import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const FRONTEND_ROOT = join(import.meta.dir, "..");

/** Keep CLI and runtime builds aligned, independent of the launch directory. */
export function frontendBuildConfig(overrides: Partial<Bun.BuildConfig> = {}): Bun.BuildConfig {
  return {
    entrypoints: [join(FRONTEND_ROOT, "index.html")],
    root: FRONTEND_ROOT,
    tsconfig: join(FRONTEND_ROOT, "..", "tsconfig.json"),
    plugins: [tailwind],
    minify: true,
    splitting: true,
    target: "browser",
    throw: false,
    sourcemap: "none",
    env: "BUN_PUBLIC_*",
    ...overrides,
    define: { "process.env.NODE_ENV": JSON.stringify("production"), ...overrides.define },
  };
}

export interface FrontendAsset {
  blob: Blob;
  type: string;
  etag: string;
}

export interface ProductionFrontend {
  html: string;
  htmlEtag: string;
  assets: Map<string, FrontendAsset>;
}

function entityTag(bytes: ArrayBuffer): string {
  return `"${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}"`;
}

/**
 * Build current package sources once at startup. Omitting outdir keeps Bun's
 * output in memory: no prebuilt dist, writable package directory, or cleanup
 * is required. Materialize artifacts so all responses own stable byte buffers.
 */
export async function buildProductionFrontend(): Promise<ProductionFrontend> {
  const result = await Bun.build(frontendBuildConfig({ publicPath: "/" }));
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Could not build the Caliber frontend.\n${details}`);
  }
  const assets = new Map<string, FrontendAsset>();
  let html: string | undefined;
  let htmlEtag = "";
  for (const output of result.outputs) {
    const bytes = await output.arrayBuffer();
    if (output.kind === "entry-point" && output.path.endsWith(".html")) {
      if (html !== undefined) throw new Error("The frontend build produced multiple HTML entries.");
      html = new TextDecoder().decode(bytes);
      htmlEtag = entityTag(bytes);
      continue;
    }
    const outputPath = output.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (outputPath.startsWith("/") || outputPath.split("/").includes("..")) {
      throw new Error(`Unexpected frontend asset path: ${output.path}`);
    }
    const type = output.type || "application/octet-stream";
    assets.set(`/${outputPath}`, {
      blob: new Blob([bytes], { type }),
      type,
      etag: entityTag(bytes),
    });
  }
  if (html === undefined || assets.size === 0) {
    throw new Error("The frontend build did not produce a complete HTML and asset bundle.");
  }
  return { html, htmlEtag, assets };
}
