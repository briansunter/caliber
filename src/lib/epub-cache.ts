import JSZip from "jszip";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { CONFIG_DIR_PATH } from "./config";
import { getBookFormatPath } from "./calibre-optimized";
import { type SourceSignature, getSourceSignature, isSameSignature } from "./file-signature";

const EPUB_CACHE_DIR = join(CONFIG_DIR_PATH, "epub-cache");
const CACHE_META_FILE = ".caliber-epub-cache.json";
const MAX_OPEN_EPUBS = 3;
const MAX_EPUB_BYTES = 256 * 1024 * 1024;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;

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

interface CachedZip {
  signature: SourceSignature;
  zip: JSZip;
}

const openEpubs = new Map<string, CachedZip>();

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
    if (statSync(epubPath).size > MAX_EPUB_BYTES) {
      throw new EpubCacheError("EPUB file is too large", 413, "epub_too_large");
    }
    const zip = await JSZip.loadAsync(await Bun.file(epubPath).arrayBuffer());
    rememberOpenEpub(epubPath, { signature, zip });
    return zip;
  } catch (error) {
    if (error instanceof EpubCacheError) throw error;
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

const inflightRebuilds = new Map<string, Promise<unknown>>();

// Ensures concurrent callers sharing key await one in-flight task instead of racing.
export async function runSingleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inflightRebuilds.get(key);
  if (existing) return existing as Promise<T>;

  const promise = task().finally(() => {
    inflightRebuilds.delete(key);
  });
  inflightRebuilds.set(key, promise);
  return promise;
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

  const cacheDir = join(EPUB_CACHE_DIR, String(bookId));

  const signature = await runSingleFlight(`epub:${bookId}`, async () => {
    const current = getSourceSignature(epubPath);
    const cachedSignature = await readCacheSignature(cacheDir);
    if (!isSameSignature(cachedSignature, current)) {
      await resetCacheDir(cacheDir);
      await Bun.write(join(cacheDir, CACHE_META_FILE), `${JSON.stringify(current)}\n`);
    } else {
      mkdirSync(cacheDir, { recursive: true });
    }
    return current;
  });

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

  const uncompressedSize = (entry as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize;
  if (uncompressedSize && uncompressedSize > MAX_EPUB_ENTRY_BYTES) {
    throw new EpubCacheError("EPUB resource is too large", 413, "entry_too_large");
  }

  mkdirSync(dirname(target), { recursive: true });
  const data = await entry.async("uint8array");
  if (data.byteLength > MAX_EPUB_ENTRY_BYTES) {
    throw new EpubCacheError("EPUB resource is too large", 413, "entry_too_large");
  }
  await Bun.write(target, data);
  const existingSignature = await readCacheSignature(cacheDir);
  if (!isSameSignature(existingSignature, signature)) {
    await Bun.write(join(cacheDir, CACHE_META_FILE), `${JSON.stringify(signature)}\n`);
  }

  return target;
}

export async function getEpubEntryPath(bookId: number, entryPath: string): Promise<string | null> {
  const cache = await ensureEpubCache(bookId);
  if (!cache) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(entryPath);
  } catch {
    throw new EpubCacheError("Invalid EPUB entry path", 400, "invalid_path");
  }

  return extractEpubEntry(
    cache.epubPath,
    cache.cacheDir,
    decodedPath,
    cache.signature,
  );
}
