import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProductionFrontend, frontendBuildConfig, type ProductionFrontend } from "../src/lib/frontend-assets";

let frontend: ProductionFrontend;
let foreignCwd = "";
const scanner = new Bun.Transpiler({ loader: "js" });

beforeAll(async () => {
  frontend = await buildProductionFrontend();
}, 30_000);

afterAll(() => {
  if (foreignCwd) rmSync(foreignCwd, { recursive: true, force: true });
});

describe("production frontend assets", () => {
  test("a build failure returns diagnostics before any output can be published", async () => {
    const result = await Bun.build(frontendBuildConfig({ entrypoints: [join(import.meta.dir, "missing-frontend-entry.html")] }));
    expect(result.success).toBe(false);
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.outputs).toEqual([]);
  });

  test("HTML and every static or lazy import resolve to known root-relative assets", async () => {
    const links = [...frontend.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      expect(link?.startsWith("/")).toBe(true);
      expect(frontend.assets.has(link ?? "")).toBe(true);
    }
    let lazyImports = 0;
    for (const [pathname, asset] of frontend.assets) {
      expect(asset.blob.size).toBeGreaterThan(0);
      expect(asset.etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(asset.type).toBe(asset.blob.type);
      expect(pathname.endsWith(".map")).toBe(false);
      if (!pathname.endsWith(".js")) continue;
      const source = await asset.blob.text();
      expect(source.includes("sourceMappingURL")).toBe(false);
      for (const imported of scanner.scanImports(source)) {
        expect(imported.path.startsWith("/")).toBe(true);
        expect(frontend.assets.has(imported.path)).toBe(true);
        if (imported.kind === "dynamic-import") lazyImports += 1;
      }
    }
    expect(lazyImports).toBeGreaterThanOrEqual(3);
    expect(frontend.htmlEtag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  test("the initial module graph excludes substantial lazy reader code", async () => {
    const entry = frontend.html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(entry).toBeDefined();
    const initial = new Set<string>();
    const visit = async (pathname: string) => {
      if (initial.has(pathname)) return;
      initial.add(pathname);
      const asset = frontend.assets.get(pathname);
      if (!asset) throw new Error(`Missing bundled module ${pathname}`);
      for (const imported of scanner.scanImports(await asset.blob.text())) {
        if (imported.kind === "import-statement") await visit(imported.path);
      }
    };
    await visit(entry ?? "");
    const js = [...frontend.assets].filter(([pathname]) => pathname.endsWith(".js"));
    const totalBytes = js.reduce((sum, [, asset]) => sum + asset.blob.size, 0);
    const initialBytes = js.reduce((sum, [pathname, asset]) => sum + (initial.has(pathname) ? asset.blob.size : 0), 0);
    expect(initial.size).toBeLessThan(js.length);
    // This catches a return to Bun's implicit HTML monolith even when React.lazy remains.
    expect(initialBytes / totalBytes).toBeLessThan(0.65);
  });

  test("a launch outside the package builds current sources without writing files", async () => {
    foreignCwd = mkdtempSync(join(tmpdir(), "caliber-frontend-cwd-"));
    const helperPath = join(import.meta.dir, "..", "src", "lib", "frontend-assets.ts");
    const code = `import { buildProductionFrontend } from ${JSON.stringify(helperPath)};
const result = await buildProductionFrontend();
const stylesheet = [...result.assets.values()].find(asset => asset.type.startsWith("text/css"));
console.log(JSON.stringify({ count: result.assets.size, styled: (await stylesheet.blob.text()).includes(".catalogue-search") }));`;
    const child = Bun.spawn([process.execPath, "--eval", code], { cwd: foreignCwd, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(errors);
    const result = JSON.parse(output) as { count: number; styled: boolean };
    expect(result.count).toBeGreaterThan(3);
    expect(result.styled).toBe(true);
    expect(readdirSync(foreignCwd)).toEqual([]);
  }, 30_000);
});
