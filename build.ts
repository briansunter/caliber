#!/usr/bin/env bun
import { frontendBuildConfig } from "./src/lib/frontend-assets";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Common Options:
  --outdir <path>          Output directory (default: "dist")
  --minify                 Enable minification (or --minify.whitespace, --minify.syntax, etc)
  --sourcemap <type>      Sourcemap type: none|linked|inline|external
  --target <target>        Build target: browser|bun|node
  --format <format>        Output format: esm|cjs|iife
  --splitting              Enable code splitting
  --packages <type>        Package handling: bundle|external
  --public-path <path>     Public path for assets
  --env <mode>             Environment handling: inline|disable|prefix*
  --conditions <list>      Package.json export conditions (comma separated)
  --external <list>        External packages (comma separated)
  --banner <text>          Add banner text to output
  --footer <text>          Add footer text to output
  --define <obj>           Define global constants (e.g. --define.VERSION=1.0.0)
  --help, -h               Show this help message

Example:
  bun run build.ts --outdir=dist --minify --sourcemap=linked --external=react,react-dom
`);
  process.exit(0);
}

const toCamelCase = (str: string): string =>
  str.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());

const parseValue = (value: string): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;

  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d*\.\d+$/.test(value)) return parseFloat(value);

  return value;
};

function parseArgs(): Partial<Bun.BuildConfig> {
  const config: Record<string, unknown> = {};
  const args = process.argv.slice(2);
  const setOption = (rawKey: string, value: unknown) => {
    const key = toCamelCase(rawKey);
    if (!key.includes(".")) {
      config[key] = value;
      return;
    }
    const [parentKey, childKey] = key.split(".", 2);
    if (!parentKey || !childKey) return;
    const parent =
      typeof config[parentKey] === "object" && config[parentKey] !== null
        ? (config[parentKey] as Record<string, unknown>)
        : {};
    parent[childKey] = parentKey === "define" ? String(value) : value;
    config[parentKey] = parent;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) continue;

    if (arg.startsWith("--no-")) {
      setOption(arg.slice(5), false);
      continue;
    }

    if (!arg.includes("=") && (i === args.length - 1 || args[i + 1]?.startsWith("--"))) {
      setOption(arg.slice(2), true);
      continue;
    }

    let key: string;
    let value: string;

    if (arg.includes("=")) {
      const separator = arg.indexOf("=");
      key = arg.slice(2, separator);
      value = arg.slice(separator + 1);
    } else {
      key = arg.slice(2);
      value = args[++i] ?? "";
    }

    setOption(
      key,
      ["external", "conditions"].includes(toCamelCase(key))
        ? value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : key.startsWith("define.") ||
            ["banner", "footer", "outdir", "publicPath"].includes(toCamelCase(key))
          ? value
          : parseValue(value),
    );
  }

  return config as Partial<Bun.BuildConfig>;
}

const formatFileSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

console.log("\n🚀 Starting build process...\n");

const cliConfig = parseArgs();
const projectRoot = process.cwd();
const outdir = path.resolve(typeof cliConfig.outdir === "string" ? cliConfig.outdir : "dist");
const isWithin = (directory: string, candidate: string) => {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
if (
  isWithin(outdir, projectRoot) ||
  isWithin(path.join(projectRoot, "src"), outdir) ||
  isWithin(path.join(projectRoot, "node_modules"), outdir)
) {
  throw new Error(`Unsafe build output directory: ${outdir}`);
}
const outputMarker = ".caliber-build-output";
if (
  outdir !== path.join(projectRoot, "dist") &&
  existsSync(outdir) &&
  !existsSync(path.join(outdir, outputMarker)) &&
  (await readdir(outdir)).length > 0
) {
  throw new Error(`Refusing to replace a non-build directory: ${outdir}`);
}
await mkdir(path.dirname(outdir), { recursive: true });
const stagingDir = await mkdtemp(path.join(path.dirname(outdir), ".caliber-build-"));

const start = performance.now();

const buildConfig = frontendBuildConfig({ sourcemap: "linked", ...cliConfig, outdir: stagingDir });
const entrypoints = buildConfig.entrypoints;
console.log(
  `📄 Found ${entrypoints.length} HTML ${entrypoints.length === 1 ? "file" : "files"} to process\n`,
);

let result: Awaited<ReturnType<typeof Bun.build>>;
let outputTable: { File: string; Type: string; Size: string }[] = [];
try {
  result = await Bun.build(buildConfig);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed; previous output was preserved.");
  }
  // BuildArtifact reads its file lazily, so capture sizes before moving it.
  outputTable = result.outputs.map((output) => ({
    File: path.relative(process.cwd(), path.join(outdir, path.relative(stagingDir, output.path))),
    Type: output.kind,
    Size: formatFileSize(output.size),
  }));
  await writeFile(
    path.join(stagingDir, outputMarker),
    "Generated by Caliber. Safe to replace during a build.\n",
  );
  await rm(outdir, { recursive: true, force: true });
  await rename(stagingDir, outdir);
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true });
  throw error;
}

const end = performance.now();

console.table(outputTable);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);
