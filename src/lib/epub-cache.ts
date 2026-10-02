import JSZip from "jszip";
import { JobSemaphore } from "./job-semaphore";
import { ByteLruCache } from "./byte-lru-cache";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { CONFIG_DIR_PATH, LIBRARY_PATH } from "./config";
import { getBookFormatPath, getLibraryPath, getSnapshotRevision } from "./calibre-optimized";
import { type SourceSignature, getSourceSignature, isSameSignature } from "./file-signature";

const EPUB_CACHE_DIR = join(CONFIG_DIR_PATH, "epub-cache");
const CACHE_META_FILE = ".caliber-epub-cache.json";
const MAX_OPEN_EPUBS = 3;
const MAX_OPEN_EPUB_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_EPUB_BYTES = 256 * 1024 * 1024;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_CACHE_BYTES = 1024 * 1024 * 1024;

// PHYSICAL namespace: on-disk cache dirs are scoped by library identity so
// two libraries serving the same book id can never share extracted bytes.
// libHash is a short hash of the resolved library path (same derivation as
// the progress library id in src/index.ts).
export function cacheLibraryHash(libraryPath?: string): string {
  return Bun.hash(libraryPath ?? getLibraryPath()).toString(36);
}

// Coherence rule (also applies to page-streaming.ts): resolve the library
// ONCE at the entry of each ensure/extract function and thread the captured
// value through every await below. Re-reading getLibraryPath() mid-await
// could observe a library switch and mix generations on disk.

// Refcounted leases: every acquire must pair with its release (idempotent via
// flag); the count drops to zero — and the entry is deleted — only when the
// last holder releases, so concurrent readers never evict each other's dirs.
const activeEpubLeases = new Map<string, number>();

export function acquireEpubLease(cacheDir: string): () => void {
  activeEpubLeases.set(cacheDir, (activeEpubLeases.get(cacheDir) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeEpubLeases.get(cacheDir) ?? 1) - 1;
    if (remaining <= 0) activeEpubLeases.delete(cacheDir);
    else activeEpubLeases.set(cacheDir, remaining);
  };
}

// Max 2 concurrent EPUB extractions (shared discipline with the page-cache
// archive semaphore in page-streaming.ts).

const epubExtractSemaphore = new JobSemaphore(2);

function dirSizeBytesRecursive(dir: string): number {
  let total = 0;
  let entries: Dirent[] | undefined;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytesRecursive(p);
    } else if (entry.isFile()) {
      try {
        total += statSync(p).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export function sweepEpubCacheQuota(): void {
  try {
    // Count every directory once; repeated full-tree scans made eviction
    // quadratic in the number of cached books.
    let total = 0;
    const dirs = readdirSync(EPUB_CACHE_DIR, { withFileTypes: true })
      .flatMap((entry) => {
        const dir = join(EPUB_CACHE_DIR, entry.name);
        const stat = statSync(dir);
        const size = entry.isDirectory() ? dirSizeBytesRecursive(dir) : stat.size;
        total += size;
        return entry.isDirectory() ? [{ dir, mtime: stat.mtimeMs, size }] : [];
      })
      .sort((a, b) => a.mtime - b.mtime);
    if (total <= MAX_EPUB_CACHE_BYTES) return;
    for (const { dir, size } of dirs) {
      if (total <= MAX_EPUB_CACHE_BYTES) break;
      if ((activeEpubLeases.get(dir) ?? 0) > 0) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        total -= size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function epubSingleFlightKey(
  bookId: number,
  op: string,
  entryPath: string,
  library?: string,
): string {
  let resolved = library;
  let rev = 0;
  if (resolved === undefined) {
    try {
      resolved = getLibraryPath();
    } catch {
      resolved = "";
    }
  }
  try {
    rev = getSnapshotRevision();
  } catch {
    /* ignore */
  }
  return `${resolved}|${bookId}|${rev}|${op}|${entryPath}`;
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

// On-disk meta: the source signature plus the library hash that owns this
// scoped dir. isSameSignature ignores the extra field, so legacy metas
// without libHash still compare correctly.
interface EpubCacheMeta extends SourceSignature {
  libHash?: string;
}

const openEpubs = new ByteLruCache<string, CachedZip>(MAX_OPEN_EPUBS, MAX_OPEN_EPUB_CACHE_BYTES);

async function readCacheSignature(cacheDir: string): Promise<EpubCacheMeta | null> {
  try {
    const file = Bun.file(join(cacheDir, CACHE_META_FILE));
    if (!(await file.exists())) return null;
    return (await file.json()) as EpubCacheMeta;
  } catch {
    return null;
  }
}

function rememberOpenEpub(epubPath: string, cached: CachedZip): void {
  openEpubs.set(openCacheKey(epubPath), cached, cached.signature.size);
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
  if (isAbsolute(entryPath) || entryPath.includes("\0") || entryPath === CACHE_META_FILE) {
    return null;
  }
  const normalized = normalize(entryPath);
  if (
    normalized.startsWith("..") ||
    normalized.includes(`..${sep}`) ||
    normalized === CACHE_META_FILE ||
    normalized === "."
  ) {
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
  library: string;
} | null> {
  // Capture the coherent catalog context at entry (see coherence rule above).
  const library = getLibraryPath();
  const libHash = cacheLibraryHash(library);
  const epubPath = getBookFormatPath(bookId, "EPUB");
  if (!epubPath || !existsSync(epubPath)) return null;

  const cacheDir = join(EPUB_CACHE_DIR, `${libHash}-${bookId}`);
  const legacyDir = join(EPUB_CACHE_DIR, String(bookId));

  const signature = await runSingleFlight(`${library}::epub:${bookId}`, async () => {
    const current = getSourceSignature(epubPath);
    // S5: legacy unscoped dirs are disposable artifacts — never adopt on
    // signature match. Always drop the legacy dir and rebuild into the scoped
    // dir; a libHash mismatch rebuilds without renaming foreign content.
    if (existsSync(legacyDir)) {
      rmSync(legacyDir, { recursive: true, force: true });
    }
    const cachedSignature = await readCacheSignature(cacheDir);
    if (!isSameSignature(cachedSignature, current) || cachedSignature?.libHash !== libHash) {
      await resetCacheDir(cacheDir);
      await Bun.write(
        join(cacheDir, CACHE_META_FILE),
        `${JSON.stringify({ ...current, libHash })}\n`,
      );
    } else {
      mkdirSync(cacheDir, { recursive: true });
    }
    return current;
  });

  return { cacheDir, epubPath, signature, library };
}

async function extractEpubEntry(
  epubPath: string,
  cacheDir: string,
  entryPath: string,
  signature: SourceSignature,
  library: string,
): Promise<string | null> {
  const target = safeCachePath(cacheDir, entryPath);
  if (!target) return null;
  if (existsSync(target)) return target;
  const libHash = cacheLibraryHash(library);

  const releaseLease = acquireEpubLease(cacheDir);
  try {
    return await runSingleFlight(
      epubSingleFlightKey(0, "extractEpubEntry", `${epubPath}:${entryPath}`, library),
      async () => {
        // Recheck after acquiring the singleflight slot: another worker may
        // have published while we waited.
        if (existsSync(target)) return target;
        // Never publish entries for a stale generation: if the source changed
        // while we waited, abort instead of writing under the old signature.
        const fresh = getSourceSignature(epubPath);
        if (!isSameSignature(fresh, signature)) return null;

        // Bound concurrent archive work: the open/decompress/write section runs
        // under the extraction semaphore.
        return epubExtractSemaphore.run(async () => {
          if (existsSync(target)) return target;
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
            try {
              rmSync(tmpPath, { force: true });
            } catch {
              /* ignore */
            }
            return null;
          }
          try {
            renameSync(tmpPath, target);
          } catch {
            // Cross-device or racing rename fallback: rewrite atomically.
            await Bun.write(target, data);
            try {
              rmSync(tmpPath, { force: true });
            } catch {
              /* ignore */
            }
          }
          const existingSignature = await readCacheSignature(cacheDir);
          if (
            !isSameSignature(existingSignature, signature) ||
            existingSignature?.libHash !== libHash
          ) {
            await Bun.write(
              join(cacheDir, CACHE_META_FILE),
              `${JSON.stringify({ ...signature, libHash })}\n`,
            );
          }
          sweepEpubCacheQuota();

          return target;
        });
      },
    );
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
    cache.library,
  );
}
