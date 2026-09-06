import JSZip from "jszip";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { CONFIG_DIR_PATH, LIBRARY_PATH } from "./config";
import { getBookFormatPath, getLibraryPath, getSnapshotRevision } from "./calibre-optimized";
import { type SourceSignature, getSourceSignature, isSameSignature } from "./file-signature";

const EPUB_CACHE_DIR = join(CONFIG_DIR_PATH, "epub-cache");
const CACHE_META_FILE = ".caliber-epub-cache.json";
const MAX_OPEN_EPUBS = 3;
const MAX_EPUB_BYTES = 256 * 1024 * 1024;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_CACHE_BYTES = 1024 * 1024 * 1024;

const activeEpubLeases = new Set<string>();

export function acquireEpubLease(cacheDir: string): () => void {
  activeEpubLeases.add(cacheDir);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeEpubLeases.delete(cacheDir);
  };
}

function epubCacheSizeBytes(): number {
  let total = 0;
  try {
    for (const book of readdirSync(EPUB_CACHE_DIR, { withFileTypes: true })) {
      if (!book.isDirectory()) continue;
      const dir = join(EPUB_CACHE_DIR, book.name);
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          try {
            total += statSync(join(dir, entry.name)).size;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return total;
}

export function sweepEpubCacheQuota(): void {
  try {
    if (epubCacheSizeBytes() <= MAX_EPUB_CACHE_BYTES) return;
    const dirs = readdirSync(EPUB_CACHE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = join(EPUB_CACHE_DIR, e.name);
        let mtime = 0;
        try {
          mtime = statSync(dir).mtimeMs;
        } catch { /* ignore */ }
        return { dir, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const { dir } of dirs) {
      if (epubCacheSizeBytes() <= MAX_EPUB_CACHE_BYTES) break;
      if (activeEpubLeases.has(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function epubSingleFlightKey(bookId: number, op: string, entryPath: string): string {
  let library = "";
  let rev = 0;
  try {
    library = getLibraryPath();
  } catch { /* ignore */ }
  try {
    rev = getSnapshotRevision();
  } catch { /* ignore */ }
  return `${library}|${bookId}|${rev}|${op}|${entryPath}`;
}

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
  const key = openCacheKey(epubPath);
  openEpubs.delete(key);
  openEpubs.set(key, cached);

  while (openEpubs.size > MAX_OPEN_EPUBS) {
    const oldestKey = openEpubs.keys().next().value;
    if (!oldestKey) break;
    openEpubs.delete(oldestKey);
  }
}

function openCacheKey(epubPath: string): string {
  // F04: key the open-epub LRU by library + path so library switches can't
  // reuse another library's open archive for the same book id.
  return `${LIBRARY_PATH}::${epubPath}`;
}

async function getOpenEpub(epubPath: string, signature: SourceSignature): Promise<JSZip> {
  const key = openCacheKey(epubPath);
  const cached = openEpubs.get(key);
  if (cached && isSameSignature(cached.signature, signature)) {
    rememberOpenEpub(epubPath, cached);
    return cached.zip;
  }

  openEpubs.delete(key);

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

  const signature = await runSingleFlight(`${LIBRARY_PATH}::epub:${bookId}`, async () => {
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

  const releaseLease = acquireEpubLease(cacheDir);
  try {
    return await runSingleFlight(epubSingleFlightKey(0, "extractEpubEntry", `${epubPath}:${entryPath}`), async () => {
      // Recheck after acquiring the singleflight slot: another worker may
      // have published while we waited.
      if (existsSync(target)) return target;
      // Never publish entries for a stale generation: if the source changed
      // while we waited, abort instead of writing under the old signature.
      const fresh = getSourceSignature(epubPath);
      if (!isSameSignature(fresh, signature)) return null;

      const zip = await getOpenEpub(epubPath, signature);
      const entry = zip.files[entryPath];
      if (!entry || entry.dir) return null;

      // Per-entry uncompressed cap BEFORE retaining/extracting bytes: check
      // the central-directory size plus the running total is implicit here
      // (single entry), abort before entry.async allocates.
      const uncompressedSize = (entry as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize;
      if (typeof uncompressedSize === "number" && uncompressedSize > MAX_EPUB_ENTRY_BYTES) {
        throw new EpubCacheError("EPUB resource is too large", 413, "entry_too_large");
      }

      mkdirSync(dirname(target), { recursive: true });
      const data = await entry.async("uint8array");
      if (data.byteLength > MAX_EPUB_ENTRY_BYTES) {
        throw new EpubCacheError("EPUB resource is too large", 413, "entry_too_large");
      }
      // Write to tmp.$pid then rename so readers never see a half-written file.
      const tmpPath = `${target}.tmp-${process.pid}`;
      await Bun.write(tmpPath, data);
      // Recheck generation before publish: never publish a stale generation.
      const beforePublish = getSourceSignature(epubPath);
      if (!isSameSignature(beforePublish, signature)) {
        try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        return null;
      }
      try {
        renameSync(tmpPath, target);
      } catch {
        // Cross-device or racing rename fallback: rewrite atomically.
        await Bun.write(target, data);
        try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      }
      const existingSignature = await readCacheSignature(cacheDir);
      if (!isSameSignature(existingSignature, signature)) {
        await Bun.write(join(cacheDir, CACHE_META_FILE), `${JSON.stringify(signature)}\n`);
      }
      sweepEpubCacheQuota();

      return target;
    });
  } finally {
    releaseLease();
  }
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
