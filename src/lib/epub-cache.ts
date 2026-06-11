import JSZip from "jszip";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { CONFIG_DIR_PATH } from "./config";
import { getBookFormatPath } from "./calibre-optimized";

const EPUB_CACHE_DIR = join(CONFIG_DIR_PATH, "epub-cache");
const CACHE_META_FILE = ".caliber-epub-cache.json";
const MAX_OPEN_EPUBS = 3;

export class EpubCacheError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "EpubCacheError";
  }
}

interface SourceSignature {
  size: number;
  mtimeMs: number;
}

interface CachedZip {
  signature: SourceSignature;
  zip: JSZip;
}

const openEpubs = new Map<string, CachedZip>();

function getSourceSignature(path: string): SourceSignature {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function isSameSignature(a: SourceSignature | null, b: SourceSignature): boolean {
  return Boolean(a && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

async function readCacheSignature(cacheDir: string): Promise<SourceSignature | null> {
  try {
    const file = Bun.file(join(cacheDir, CACHE_META_FILE));
    if (!(await file.exists())) return null;
    return (await file.json()) as SourceSignature;
  } catch {
    return null;
  }
}

function rememberOpenEpub(epubPath: string, cached: CachedZip): void {
  openEpubs.delete(epubPath);
  openEpubs.set(epubPath, cached);

  while (openEpubs.size > MAX_OPEN_EPUBS) {
    const oldestKey = openEpubs.keys().next().value;
    if (!oldestKey) break;
    openEpubs.delete(oldestKey);
  }
}

async function getOpenEpub(epubPath: string, signature: SourceSignature): Promise<JSZip> {
  const cached = openEpubs.get(epubPath);
  if (cached && isSameSignature(cached.signature, signature)) {
    rememberOpenEpub(epubPath, cached);
    return cached.zip;
  }

  openEpubs.delete(epubPath);

  try {
    const zip = await JSZip.loadAsync(await Bun.file(epubPath).arrayBuffer());
    rememberOpenEpub(epubPath, { signature, zip });
    return zip;
  } catch {
    throw new EpubCacheError("Invalid EPUB archive", 422, "invalid_epub");
  }
}

function safeCachePath(cacheDir: string, entryPath: string): string | null {
  const normalized = normalize(entryPath).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.startsWith("..") || normalized.includes(`..${sep}`) || normalized === ".") {
    return null;
  }

  const target = join(cacheDir, normalized);
  if (!target.startsWith(cacheDir + sep)) return null;
  return target;
}

async function resetCacheDir(cacheDir: string): Promise<void> {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
}

async function ensureEpubCache(bookId: number): Promise<{
  cacheDir: string;
  epubPath: string;
  signature: SourceSignature;
} | null> {
  const epubPath = getBookFormatPath(bookId, "EPUB");
  if (!epubPath || !existsSync(epubPath)) return null;

  const signature = getSourceSignature(epubPath);
  const cacheDir = join(EPUB_CACHE_DIR, String(bookId));
  const cachedSignature = await readCacheSignature(cacheDir);

  if (!isSameSignature(cachedSignature, signature)) {
    await resetCacheDir(cacheDir);
  } else {
    mkdirSync(cacheDir, { recursive: true });
  }

  return { cacheDir, epubPath, signature };
}

async function extractEpubEntry(
  epubPath: string,
  cacheDir: string,
  entryPath: string,
  signature: SourceSignature,
): Promise<string | null> {
  const target = safeCachePath(cacheDir, entryPath);
  if (!target) return null;
  if (existsSync(target)) return target;

  const zip = await getOpenEpub(epubPath, signature);
  const entry = zip.files[entryPath];
  if (!entry || entry.dir) return null;

  mkdirSync(dirname(target), { recursive: true });
  await Bun.write(target, await entry.async("uint8array"));
  await Bun.write(join(cacheDir, CACHE_META_FILE), `${JSON.stringify(signature)}\n`);

  return target;
}

export async function getEpubEntryPath(bookId: number, entryPath: string): Promise<string | null> {
  const cache = await ensureEpubCache(bookId);
  if (!cache) return null;

  return extractEpubEntry(
    cache.epubPath,
    cache.cacheDir,
    decodeURIComponent(entryPath),
    cache.signature,
  );
}
