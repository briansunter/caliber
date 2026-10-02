import JSZip from "jszip";
import { JobSemaphore } from "./job-semaphore";
import { ByteLruCache } from "./byte-lru-cache";
import { type CachedPage, type PageCacheMeta, isPageCacheMeta } from "./page-cache-meta";
import { createExtractorFromData, type FileHeader } from "node-unrar-js/esm";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { CONFIG_DIR_PATH, LIBRARY_PATH } from "./config";
import { getBookFormatPath, getLibraryPath, getSnapshotRevision } from "./calibre-optimized";
import { getPathContentType } from "./book-files";
import { cacheLibraryHash, runSingleFlight } from "./epub-cache";
import { type SourceSignature, getSourceSignature, isSameSignature } from "./file-signature";

const PAGE_CACHE_DIR = join(CONFIG_DIR_PATH, "page-cache");
const CACHE_META_FILE = ".caliber-page-cache.json";
// SVG pages are disallowed: inline SVG served as image/svg+xml can execute
// embedded scripts in the reader's origin. SVG entries are skipped (and
// logged) instead of extracted.
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const SKIPPED_SVG_EXTENSION = ".svg";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_PAGE_COUNT = 10_000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const COMMAND_TIMEOUT_MS = 30_000;
// S6: CBR manifest version. Bump when the CBR meta layout/ordering contract
// changes; metas missing this version (or failing contiguity) force rebuild.
const CBR_MANIFEST_VERSION = 2;

// Global job semaphore: max 3 concurrent PDF renders, max 2 archive extracts.

export const pdfRenderSemaphore = new JobSemaphore(3);
export const archiveExtractSemaphore = new JobSemaphore(2);

// Refcounted leases: every acquire must pair with its release (idempotent via
// flag); the count drops to zero — and the entry is deleted — only when the
// last holder releases, so concurrent renders never evict each other's pages.
const activePageLeases = new Map<string, number>();

export function acquirePageLease(path: string): () => void {
  activePageLeases.set(path, (activePageLeases.get(path) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activePageLeases.get(path) ?? 1) - 1;
    if (remaining <= 0) activePageLeases.delete(path);
    else activePageLeases.set(path, remaining);
  };
}

export function pageSingleFlightKey(
  bookId: number,
  op: string,
  page: string,
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
  return `${resolved}|${bookId}|${rev}|${op}|${page}`;
}

/** Pixel-count guard via PNG IHDR header without a full decode. */
export function assertPixelCountGuard(data: Uint8Array, fileName: string): void {
  if (extname(fileName).toLowerCase() !== ".png" || data.byteLength < 33) return;
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[12] === 0x49 &&
    data[13] === 0x48 &&
    data[14] === 0x44 &&
    data[15] === 0x52
  ) {
    const w =
      ((data[16] ?? 0) * 2 ** 24 +
        (data[17] ?? 0) * 2 ** 16 +
        (data[18] ?? 0) * 2 ** 8 +
        (data[19] ?? 0)) >>>
      0;
    const h =
      ((data[20] ?? 0) * 2 ** 24 +
        (data[21] ?? 0) * 2 ** 16 +
        (data[22] ?? 0) * 2 ** 8 +
        (data[23] ?? 0)) >>>
      0;
    if (Number.isFinite(w) && Number.isFinite(h) && w * h > MAX_IMAGE_PIXELS) {
      throw new PageStreamingError(413, "Page image exceeds the pixel-count limit");
    }
  }
}

function entryUncompressedSize(entry: unknown): number | null {
  const size = (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

/** Declared uncompressed size from a RAR file header, if sane. */
function declaredOf(header: FileHeader): number | null {
  const size = header.unpSize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

export function sweepPageCacheQuota(): void {
  try {
    // Recursive walk: pages may live in nested directories; every file counts
    // toward the quota (manifests included), while only unleased page files
    // are eviction candidates.
    let total = 0;
    const files: Array<{ path: string; mtime: number }> = [];
    const walk = (dir: string): void => {
      let entries: Dirent[] | undefined;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = statSync(p);
          total += st.size;
          if (entry.name === CACHE_META_FILE) continue;
          if ((activePageLeases.get(p) ?? 0) > 0) continue;
          files.push({ path: p, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    };
    let books: Dirent[] | undefined;
    try {
      books = readdirSync(PAGE_CACHE_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    for (const book of books) {
      if (!book.isDirectory()) continue;
      walk(join(PAGE_CACHE_DIR, book.name));
    }
    if (total <= MAX_CACHE_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const { path } of files) {
      if (total <= MAX_CACHE_BYTES) break;
      if ((activePageLeases.get(path) ?? 0) > 0) continue;
      try {
        total -= statSync(path).size;
      } catch {
        /* ignore */
      }
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
    // Manifests remain valid after byte eviction: page readers check file
    // existence and regenerate missing pages on demand.
  } catch {
    /* ignore */
  }
}

// S6: pages must be dense and 1-based with no gaps for positional lookup
// (meta.pages[page-1]) to stay consistent.
function isContiguousPages(pages: CachedPage[]): boolean {
  return pages.every((page, i) => page.index === i + 1);
}

export interface PageManifestPage {
  index: number;
  href: string;
  type: string;
  name: string;
}

export interface PageManifest {
  bookId: number;
  format: string;
  pageCount: number;
  pages: PageManifestPage[];
}

export interface PageFile {
  path: string;
  contentType: string;
}

export class PageStreamingError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PageStreamingError";
    this.status = status;
  }
}

// In-memory cache for validated PageCacheMeta keyed by "bookId/format"
interface MetaMemEntry {
  meta: PageCacheMeta;
  signature: SourceSignature;
}
const metaMemCache = new Map<string, MetaMemEntry>();

function rememberPageMeta(key: string, entry: MetaMemEntry): void {
  metaMemCache.delete(key);
  let pageTotal = entry.meta.pageCount;
  for (const cached of metaMemCache.values()) pageTotal += cached.meta.pageCount;
  while (metaMemCache.size > 0 && (metaMemCache.size >= 100 || pageTotal > 50_000)) {
    const oldest = metaMemCache.entries().next().value;
    if (!oldest) break;
    pageTotal -= oldest[1].meta.pageCount;
    metaMemCache.delete(oldest[0]);
  }
  metaMemCache.set(key, entry);
}
const MAX_OPEN_CBZ_BYTES = 128 * 1024 * 1024;
const openCbzs = new ByteLruCache<string, { signature: SourceSignature; zip: JSZip }>(
  3,
  MAX_OPEN_CBZ_BYTES,
);

async function getOpenCbz(sourcePath: string, source: SourceSignature): Promise<JSZip> {
  const cached = openCbzs.get(sourcePath);
  if (cached && isSameSignature(cached.signature, source)) {
    return cached.zip;
  }
  openCbzs.delete(sourcePath);
  return runSingleFlight(`open-cbz:${sourcePath}:${source.size}:${source.mtimeMs}`, async () => {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await Bun.file(sourcePath).arrayBuffer());
    } catch {
      throw new PageStreamingError(422, "Invalid CBZ archive");
    }
    // JSZip retains compressed archive bytes. Keep a bounded LRU so moving
    // between pages avoids re-reading and parsing the complete comic.
    openCbzs.set(sourcePath, { signature: source, zip }, source.size);
    return zip;
  });
}

function metaCacheKey(bookId: number, format: string, library?: string): string {
  // F04: scope the in-memory + singleflight key by library so switching
  // libraries never serves another library's validated meta. Pass the
  // entry-captured library (see coherence rule in epub-cache.ts) instead of
  // re-reading mid-await; the default covers best-effort callers.
  return `${library ?? LIBRARY_PATH}::${bookId}/${format.toUpperCase()}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

async function readPageCacheMeta(path: string): Promise<PageCacheMeta | null> {
  const value = await readJson<unknown>(path);
  return isPageCacheMeta(value) ? value : null;
}

function getCacheDir(bookId: number, format: string, libHash: string = cacheLibraryHash()): string {
  // PHYSICAL namespace: scoped by library hash so two libraries serving the
  // same book id never share extracted pages. See coherence rule in
  // epub-cache.ts: ensure functions capture the library once at entry and
  // pass the derived libHash down instead of re-reading mid-await.
  return join(PAGE_CACHE_DIR, `${libHash}-${bookId}`, format.toUpperCase());
}

function getLegacyCacheDir(bookId: number, format: string): string {
  return join(PAGE_CACHE_DIR, String(bookId), format.toUpperCase());
}

/**
 * S5: legacy unscoped page dirs are disposable artifacts — never adopt on
 * signature match. Always rm -rf the legacy dir and let the caller rebuild
 * into the scoped dir (no rename of foreign content). Keeps only the
 * scoped-dir hit path (validated in the ensure* callers).
 */
async function adoptOrRebuildPageDir(
  _cacheDir: string,
  legacyDir: string,
  _source: SourceSignature,
  _libHash: string,
  _requirePages: boolean,
): Promise<null> {
  if (existsSync(legacyDir)) {
    rmSync(legacyDir, { recursive: true, force: true });
  }
  return null;
}

function getSourcePath(bookId: number, format: string): string {
  const sourcePath = getBookFormatPath(bookId, format);
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new PageStreamingError(404, `Format ${format.toUpperCase()} not found`);
  }

  return sourcePath;
}

function assertArchiveSize(sourcePath: string): void {
  const size = statSync(sourcePath).size;
  if (size > MAX_ARCHIVE_BYTES) {
    throw new PageStreamingError(413, "Reader source file is too large");
  }
}

function normalizePageNumber(page: number, pageCount: number): number {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new PageStreamingError(404, "Page not found");
  }

  return page;
}

function sortPageNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function ensureCbzCache(
  bookId: number,
  library?: string,
): Promise<{ cacheDir: string; meta: PageCacheMeta; sourcePath: string }> {
  // Capture the coherent catalog context at entry (see epub-cache.ts).
  const resolvedLibrary = library ?? getLibraryPath();
  const libHash = cacheLibraryHash(resolvedLibrary);
  const format = "CBZ";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format, libHash);
  const legacyDir = getLegacyCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format, resolvedLibrary);

  const memEntry = metaMemCache.get(cacheKey);
  if (
    memEntry &&
    memEntry.meta.libHash === libHash &&
    isSameSignature(memEntry.signature, source)
  ) {
    return { cacheDir, meta: memEntry.meta, sourcePath };
  }

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readPageCacheMeta(metaPath);

    if (
      existingMeta &&
      existingMeta.libHash === libHash &&
      isSameSignature(existingMeta.source, source)
    ) {
      rememberPageMeta(cacheKey, { meta: existingMeta, signature: source });
      return { cacheDir, meta: existingMeta, sourcePath };
    }

    // CBZ pages materialize lazily; legacy dirs are purged, never adopted.
    await adoptOrRebuildPageDir(cacheDir, legacyDir, source, libHash, false);

    metaMemCache.delete(cacheKey);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });

    const zip = await archiveExtractSemaphore.run(() => getOpenCbz(sourcePath, source));
    const skippedSvg = Object.values(zip.files).filter(
      (entry) => !entry.dir && extname(entry.name).toLowerCase() === SKIPPED_SVG_EXTENSION,
    ).length;
    if (skippedSvg > 0) {
      console.warn(`[page-streaming] skipped ${skippedSvg} SVG page(s) in CBZ source`);
    }
    const imageEntries = Object.values(zip.files)
      .filter((entry) => !entry.dir && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => sortPageNames(a.name, b.name));

    if (imageEntries.length === 0) {
      throw new PageStreamingError(422, "CBZ contains no image pages");
    }
    if (imageEntries.length > MAX_PAGE_COUNT) {
      throw new PageStreamingError(413, "CBZ contains too many pages");
    }

    const pages: CachedPage[] = [];
    // Cumulative cap check BEFORE retaining any bytes: sum central-directory
    // uncompressed sizes first and abort before entry.async allocates.
    let declaredTotal = 0;
    for (const entry of imageEntries) {
      const declared = entryUncompressedSize(entry);
      if (declared !== null) {
        if (declared > MAX_CACHE_BYTES) {
          throw new PageStreamingError(413, "CBZ expands beyond the reader cache limit");
        }
        declaredTotal += declared;
        if (declaredTotal > MAX_CACHE_BYTES) {
          throw new PageStreamingError(413, "CBZ expands beyond the reader cache limit");
        }
      }
    }
    for (const [offset, entry] of imageEntries.entries()) {
      const index = offset + 1;
      const ext = extname(entry.name).toLowerCase() || ".bin";
      const fileName = `${String(index).padStart(5, "0")}${ext}`;
      pages.push({
        index,
        name: basename(entry.name),
        fileName,
        contentType: getPathContentType(fileName),
        sourceName: entry.name,
      });
    }

    const meta: PageCacheMeta = {
      source,
      libHash,
      pageCount: pages.length,
      pages,
    };
    await Bun.write(metaPath, `${JSON.stringify(meta)}\n`);
    rememberPageMeta(cacheKey, { meta, signature: source });

    return { cacheDir, meta, sourcePath };
  });
}

/**
 * Lazily extract a single CBZ page on demand. The manifest lists entry names
 * without extracting all bytes; bytes are materialized per page under the
 * archive semaphore with pre-retain caps, pixel guard, and atomic publish.
 */
async function extractCbzPage(
  bookId: number,
  cacheDir: string,
  meta: PageCacheMeta,
  sourcePath: string,
  source: SourceSignature,
  pageNumber: number,
  library?: string,
): Promise<PageFile> {
  const cachedPage = meta.pages[pageNumber - 1];
  if (!cachedPage) throw new PageStreamingError(404, "Page not found");
  const outputPath = join(cacheDir, cachedPage.fileName);
  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: cachedPage.contentType };
  }
  // Thread the entry-captured library (see epub-cache.ts coherence rule) so
  // the singleflight key cannot mix generations across a library switch.
  const resolvedLibrary = library ?? getLibraryPath();
  return runSingleFlight(
    pageSingleFlightKey(bookId, "cbz", String(pageNumber), resolvedLibrary),
    () =>
      archiveExtractSemaphore.run(async () => {
        if (existsSync(outputPath)) {
          return { path: outputPath, contentType: cachedPage.contentType };
        }
        // Never publish for a stale generation.
        const fresh = getSourceSignature(sourcePath);
        if (!isSameSignature(fresh, source)) {
          throw new PageStreamingError(409, "Reader source changed during extraction");
        }
        const zip = await getOpenCbz(sourcePath, source);
        const entryName =
          cachedPage.sourceName ??
          Object.values(zip.files).find((e) => basename(e.name) === cachedPage.name)?.name;
        const entry = entryName ? zip.files[entryName] : undefined;
        if (!entry || entry.dir) throw new PageStreamingError(404, "Page not found");
        const declared = entryUncompressedSize(entry);
        if (declared !== null && declared > MAX_CACHE_BYTES) {
          throw new PageStreamingError(413, "CBZ expands beyond the reader cache limit");
        }
        const data = await entry.async("uint8array");
        if (data.byteLength > MAX_CACHE_BYTES) {
          throw new PageStreamingError(413, "CBZ expands beyond the reader cache limit");
        }
        assertPixelCountGuard(data, cachedPage.fileName);
        const tmpPath = `${outputPath}.tmp-${process.pid}`;
        await Bun.write(tmpPath, data);
        const beforePublish = getSourceSignature(sourcePath);
        if (!isSameSignature(beforePublish, source)) {
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
          throw new PageStreamingError(409, "Reader source changed during extraction");
        }
        try {
          renameSync(tmpPath, outputPath);
        } catch {
          await Bun.write(outputPath, data);
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        sweepPageCacheQuota();
        return { path: outputPath, contentType: cachedPage.contentType };
      }),
  );
}

async function getUnrarWasmBinary(): Promise<ArrayBuffer> {
  const wasmPath = join(
    import.meta.dir,
    "..",
    "..",
    "node_modules",
    "node-unrar-js",
    "esm",
    "js",
    "unrar.wasm",
  );
  return Bun.file(wasmPath).arrayBuffer();
}

async function ensureCbrCache(
  bookId: number,
  library?: string,
): Promise<{ cacheDir: string; meta: PageCacheMeta; sourcePath: string }> {
  const resolvedLibrary = library ?? getLibraryPath();
  const libHash = cacheLibraryHash(resolvedLibrary);
  const format = "CBR";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format, libHash);
  const legacyDir = getLegacyCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format, resolvedLibrary);

  const memEntry = metaMemCache.get(cacheKey);
  if (
    memEntry &&
    memEntry.meta.libHash === libHash &&
    memEntry.meta.version === CBR_MANIFEST_VERSION &&
    memEntry.meta.pageCount === memEntry.meta.pages.length &&
    isContiguousPages(memEntry.meta.pages) &&
    isSameSignature(memEntry.signature, source)
  ) {
    return { cacheDir, meta: memEntry.meta, sourcePath };
  }

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readPageCacheMeta(metaPath);

    if (
      existingMeta &&
      existingMeta.libHash === libHash &&
      existingMeta.version === CBR_MANIFEST_VERSION &&
      existingMeta.pageCount === existingMeta.pages.length &&
      isContiguousPages(existingMeta.pages) &&
      isSameSignature(existingMeta.source, source)
    ) {
      rememberPageMeta(cacheKey, { meta: existingMeta, signature: source });
      return { cacheDir, meta: existingMeta, sourcePath };
    }

    // CBR extracts eagerly; legacy dirs are purged, never adopted.
    await adoptOrRebuildPageDir(cacheDir, legacyDir, source, libHash, true);

    metaMemCache.delete(cacheKey);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });

    const archiveData = await Bun.file(sourcePath).arrayBuffer();
    const extractor = await createExtractorFromData({
      data: archiveData,
      wasmBinary: await getUnrarWasmBinary(),
    });
    const list = extractor.getFileList();
    // fileHeaders is a one-shot generator: materialize once and reuse.
    const fileHeaders = [...list.fileHeaders];
    const skippedSvg = fileHeaders.filter(
      (header) =>
        !header.flags.directory && extname(header.name).toLowerCase() === SKIPPED_SVG_EXTENSION,
    ).length;
    if (skippedSvg > 0) {
      console.warn(`[page-streaming] skipped ${skippedSvg} SVG page(s) in CBR source`);
    }
    const imageNames = fileHeaders
      .filter(
        (header) =>
          !header.flags.directory && IMAGE_EXTENSIONS.has(extname(header.name).toLowerCase()),
      )
      .map((header) => header.name)
      .sort(sortPageNames);

    if (imageNames.length === 0) {
      throw new PageStreamingError(422, "CBR contains no image pages");
    }
    if (imageNames.length > MAX_PAGE_COUNT) {
      throw new PageStreamingError(413, "CBR contains too many pages");
    }

    const imageNameSet = new Set(imageNames);
    const indexByName = new Map(imageNames.map((name, offset) => [name, offset + 1]));
    const declaredByName = new Map<string, number>();
    for (const header of fileHeaders) {
      if (imageNameSet.has(header.name)) declaredByName.set(header.name, header.unpSize);
    }
    // Declared-size gate BEFORE retaining any bytes: sum the archive headers'
    // uncompressed sizes first and abort before extract() allocates.
    let declaredTotal = 0;
    for (const name of imageNames) {
      const declared = declaredByName.get(name);
      if (declared === undefined || !Number.isFinite(declared) || declared < 0) continue;
      if (declared > MAX_CACHE_BYTES) {
        throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
      }
      declaredTotal += declared;
      if (declaredTotal > MAX_CACHE_BYTES) {
        throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
      }
    }
    // The whole retain path runs INSIDE the semaphore: extraction, per-entry +
    // cumulative caps, pixel guards, and writes. Files stream through the
    // generator one at a time — each page's cumulative total is checked BEFORE
    // it is retained/written, and the build aborts before further Bun.write
    // calls. Buffers are never collected into a map first (that would hold
    // the whole archive in memory before any cap is enforced).
    const pages: CachedPage[] = await archiveExtractSemaphore.run(async () => {
      const extracted = await extractor.extract({
        files: (header) => imageNameSet.has(header.name),
      });

      const retained: CachedPage[] = [];
      let retainedBytes = 0;
      for (const file of extracted.files) {
        const data = file.extraction;
        if (!data) continue;
        const name: string = file.fileHeader.name;
        const index = indexByName.get(name);
        if (index === undefined) continue;
        // Declared size first (abort before accounting the retained buffer),
        // then the actual bytes — both against the running cumulative total.
        const declared = declaredOf(file.fileHeader);
        if (declared !== null) {
          if (declared > MAX_CACHE_BYTES || retainedBytes + declared > MAX_CACHE_BYTES) {
            throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
          }
        }
        if (
          data.byteLength > MAX_CACHE_BYTES ||
          retainedBytes + data.byteLength > MAX_CACHE_BYTES
        ) {
          throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
        }
        retainedBytes += data.byteLength;

        const ext = extname(name).toLowerCase() || ".bin";
        const fileName = `${String(index).padStart(5, "0")}${ext}`;
        assertPixelCountGuard(data, fileName);
        const outputPath = join(cacheDir, fileName);
        const tmpPath = `${outputPath}.tmp-${process.pid}`;
        await Bun.write(tmpPath, data);
        const beforePublish = getSourceSignature(sourcePath);
        if (!isSameSignature(beforePublish, source)) {
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
          throw new PageStreamingError(409, "Reader source changed during extraction");
        }
        try {
          renameSync(tmpPath, outputPath);
        } catch {
          await Bun.write(outputPath, data);
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        retained.push({
          index,
          name: basename(name),
          fileName,
          contentType: getPathContentType(fileName),
          sourceName: name,
        });
      }
      return retained;
    });
    sweepPageCacheQuota();

    // S6 regression: node-unrar-js yields files in archive order, which may be
    // shuffled relative to the sorted name order (e.g. a 3-page archive
    // extracting as [3,1,2] while indices were assigned [1,2,3] from the sorted
    // names). Sort retained metadata by index BEFORE publish so positional
    // lookup (meta.pages[page-1]) stays consistent; never publish gaps.
    pages.sort((a, b) => a.index - b.index);
    if (pages.length === 0 || !isContiguousPages(pages)) {
      throw new PageStreamingError(422, "CBR pages could not be extracted");
    }

    const meta: PageCacheMeta = {
      source,
      libHash,
      version: CBR_MANIFEST_VERSION,
      pageCount: pages.length,
      pages,
    };
    await Bun.write(metaPath, `${JSON.stringify(meta)}\n`);
    rememberPageMeta(cacheKey, { meta, signature: source });

    return { cacheDir, meta, sourcePath };
  });
}

/**
 * Lazily extract a single CBR page on demand (e.g. after quota eviction
 * deleted the file while the meta survived). Bytes are materialized under the
 * archive semaphore with pre-retain caps, pixel guard, and atomic publish.
 */
async function extractCbrPage(
  bookId: number,
  cacheDir: string,
  meta: PageCacheMeta,
  sourcePath: string,
  source: SourceSignature,
  pageNumber: number,
  library?: string,
): Promise<PageFile> {
  const cachedPage = meta.pages[pageNumber - 1];
  if (!cachedPage) throw new PageStreamingError(404, "Page not found");
  const outputPath = join(cacheDir, cachedPage.fileName);
  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: cachedPage.contentType };
  }
  const resolvedLibrary = library ?? getLibraryPath();
  return runSingleFlight(
    pageSingleFlightKey(bookId, "cbr", String(pageNumber), resolvedLibrary),
    () =>
      archiveExtractSemaphore.run(async () => {
        if (existsSync(outputPath)) {
          return { path: outputPath, contentType: cachedPage.contentType };
        }
        // Never publish for a stale generation.
        const fresh = getSourceSignature(sourcePath);
        if (!isSameSignature(fresh, source)) {
          throw new PageStreamingError(409, "Reader source changed during extraction");
        }
        const archiveData = await Bun.file(sourcePath).arrayBuffer();
        const extractor = await createExtractorFromData({
          data: archiveData,
          wasmBinary: await getUnrarWasmBinary(),
        });
        const entryName = cachedPage.sourceName ?? cachedPage.name;
        const extracted = await extractor.extract({
          files: (header) => header.name === entryName || basename(header.name) === cachedPage.name,
        });
        let data: Uint8Array | undefined;
        // One-shot generator: yields one file at a time, so peak memory is one
        // page. The declared-size gate runs BEFORE retaining each buffer —
        // abort before assignment/Bun.write, never after collecting.
        for (const file of extracted.files) {
          const declared = declaredOf(file.fileHeader);
          if (declared !== null && declared > MAX_CACHE_BYTES) {
            throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
          }
          if (file.extraction && file.fileHeader.name === entryName) {
            data = file.extraction;
            break;
          }
        }
        if (!data) {
          for (const file of extracted.files) {
            if (file.extraction && basename(file.fileHeader.name) === cachedPage.name) {
              data = file.extraction;
              break;
            }
          }
        }
        if (!data) throw new PageStreamingError(404, "Page not found");
        if (data.byteLength > MAX_CACHE_BYTES) {
          throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
        }
        assertPixelCountGuard(data, cachedPage.fileName);
        const tmpPath = `${outputPath}.tmp-${process.pid}`;
        await Bun.write(tmpPath, data);
        const beforePublish = getSourceSignature(sourcePath);
        if (!isSameSignature(beforePublish, source)) {
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
          throw new PageStreamingError(409, "Reader source changed during extraction");
        }
        try {
          renameSync(tmpPath, outputPath);
        } catch {
          await Bun.write(outputPath, data);
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        sweepPageCacheQuota();
        return { path: outputPath, contentType: cachedPage.contentType };
      }),
  );
}

function executable(candidates: string[], fallback: string): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

const PDFINFO_BIN = executable(
  [
    process.env.PDFINFO_PATH ?? "",
    "/opt/homebrew/bin/pdfinfo",
    "/usr/local/bin/pdfinfo",
    "/usr/bin/pdfinfo",
  ].filter(Boolean),
  "pdfinfo",
);
const PDFTOPPM_BIN = executable(
  [
    process.env.PDFTOPPM_PATH ?? "",
    "/opt/homebrew/bin/pdftoppm",
    "/usr/local/bin/pdftoppm",
    "/usr/bin/pdftoppm",
  ].filter(Boolean),
  "pdftoppm",
);

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new PageStreamingError(
      501,
      error instanceof Error ? error.message : `${command} is not available`,
    );
  }

  const pipeToText = (pipe: unknown) =>
    pipe instanceof ReadableStream ? new Response(pipe).text() : Promise.resolve("");
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // The process may have exited between the timeout firing and kill().
    }
  }, COMMAND_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      pipeToText(proc.stdout),
      pipeToText(proc.stderr),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timeout);
  }

  if (exitCode !== 0) {
    const trimmed = stderr.trim();
    console.error(`[page-streaming] ${command} error:`, trimmed || `exited with ${exitCode}`);
    throw new PageStreamingError(500, "Page extraction failed");
  }

  return { stdout, stderr };
}

async function getPdfPageCount(sourcePath: string): Promise<number> {
  const { stdout } = await runCommand(PDFINFO_BIN, [sourcePath]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match?.[1]) {
    throw new PageStreamingError(422, "Unable to read PDF page count");
  }

  const pageCount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
    throw new PageStreamingError(422, "Unable to read PDF page count");
  }

  return pageCount;
}

async function ensurePdfCache(
  bookId: number,
  library?: string,
): Promise<{ cacheDir: string; sourcePath: string; source: SourceSignature; pageCount: number }> {
  const resolvedLibrary = library ?? getLibraryPath();
  const libHash = cacheLibraryHash(resolvedLibrary);
  const format = "PDF";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format, libHash);
  const legacyDir = getLegacyCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format, resolvedLibrary);

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readPageCacheMeta(metaPath);

    if (
      existingMeta &&
      existingMeta.libHash === libHash &&
      isSameSignature(existingMeta.source, source)
    ) {
      return {
        cacheDir,
        sourcePath,
        source,
        pageCount: existingMeta.pageCount,
      };
    }

    // PDF pages render lazily; legacy dirs are purged, never adopted.
    await adoptOrRebuildPageDir(cacheDir, legacyDir, source, libHash, false);

    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });

    const pageCount = await getPdfPageCount(sourcePath);
    const meta: PageCacheMeta = {
      source,
      libHash,
      pageCount,
      pages: Array.from({ length: pageCount }, (_, offset) => ({
        index: offset + 1,
        name: `Page ${offset + 1}`,
        fileName: `${String(offset + 1).padStart(5, "0")}.png`,
        contentType: "image/png",
      })),
    };
    await Bun.write(metaPath, `${JSON.stringify(meta)}\n`);

    return { cacheDir, sourcePath, source, pageCount };
  });
}

async function getPdfPageFile(bookId: number, page: number, library?: string): Promise<PageFile> {
  // Capture the coherent catalog context at entry (see epub-cache.ts).
  const resolvedLibrary = library ?? getLibraryPath();
  const { cacheDir, sourcePath, source, pageCount } = await ensurePdfCache(bookId, resolvedLibrary);
  const pageNumber = normalizePageNumber(page, pageCount);
  const outputPrefix = join(cacheDir, String(pageNumber).padStart(5, "0"));
  const outputPath = `${outputPrefix}.png`;

  if (existsSync(outputPath)) {
    return {
      path: outputPath,
      contentType: "image/png",
    };
  }

  // Per-key singleflight: library|book|rev|op|page shares one render.
  return runSingleFlight(
    pageSingleFlightKey(bookId, "pdf", String(pageNumber), resolvedLibrary),
    () =>
      pdfRenderSemaphore.run(async () => {
        if (existsSync(outputPath)) {
          return { path: outputPath, contentType: "image/png" };
        }
        const fresh = getSourceSignature(sourcePath);
        if (!isSameSignature(fresh, source)) {
          throw new PageStreamingError(409, "Reader source changed during rendering");
        }
        // Render to tmp.$pid prefix then rename so readers never see partial PNGs.
        const tmpPrefix = `${outputPrefix}.tmp-${process.pid}`;
        const tmpPath = `${tmpPrefix}.png`;
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          /* ignore */
        }
        await runCommand(PDFTOPPM_BIN, [
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-singlefile",
          "-png",
          "-r",
          "150",
          sourcePath,
          tmpPrefix,
        ]);
        // Recheck generation before publish: never publish a stale generation.
        const beforePublish = getSourceSignature(sourcePath);
        if (!isSameSignature(beforePublish, source)) {
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
          throw new PageStreamingError(409, "Reader source changed during rendering");
        }
        if (!existsSync(tmpPath)) {
          throw new PageStreamingError(500, "Page extraction failed");
        }
        try {
          const rendered = await Bun.file(tmpPath).arrayBuffer();
          assertPixelCountGuard(new Uint8Array(rendered), outputPath);
        } catch (error) {
          if (error instanceof PageStreamingError) {
            try {
              rmSync(tmpPath, { force: true });
            } catch {
              /* ignore */
            }
            throw error;
          }
        }
        try {
          renameSync(tmpPath, outputPath);
        } catch {
          await Bun.write(outputPath, await Bun.file(tmpPath).arrayBuffer());
          try {
            rmSync(tmpPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        sweepPageCacheQuota();

        return {
          path: outputPath,
          contentType: "image/png",
        };
      }),
  );
}

function unsupportedFormat(format: string): never {
  throw new PageStreamingError(415, `Page streaming is not supported for ${format}`);
}

export async function getPageManifest(bookId: number, formatParam: string): Promise<PageManifest> {
  const format = formatParam.toUpperCase();
  // Capture the coherent catalog context at entry (see epub-cache.ts): every
  // ensure call below uses this same resolved library — never re-read
  // mid-await, where a library switch could mix generations on disk.
  const library = getLibraryPath();

  if (format === "CBZ") {
    const { meta } = await ensureCbzCache(bookId, library);
    return {
      bookId,
      format,
      pageCount: meta.pageCount,
      pages: meta.pages.map((page) => ({
        index: page.index,
        href: `/api/books/${bookId}/pages/${format}/${page.index}`,
        type: page.contentType,
        name: page.name,
      })),
    };
  }

  if (format === "CBR") {
    const { meta } = await ensureCbrCache(bookId, library);
    return {
      bookId,
      format,
      pageCount: meta.pageCount,
      pages: meta.pages.map((page) => ({
        index: page.index,
        href: `/api/books/${bookId}/pages/${format}/${page.index}`,
        type: page.contentType,
        name: page.name,
      })),
    };
  }

  if (format === "PDF") {
    const { pageCount } = await ensurePdfCache(bookId, library);
    return {
      bookId,
      format,
      pageCount,
      pages: Array.from({ length: pageCount }, (_, offset) => ({
        index: offset + 1,
        href: `/api/books/${bookId}/pages/${format}/${offset + 1}`,
        type: "image/png",
        name: `Page ${offset + 1}`,
      })),
    };
  }

  return unsupportedFormat(format);
}

export async function getPageFile(
  bookId: number,
  formatParam: string,
  page: number,
): Promise<PageFile> {
  const format = formatParam.toUpperCase();
  // Same entry-captured library discipline as getPageManifest.
  const library = getLibraryPath();

  if (format === "CBZ") {
    const { cacheDir, meta, sourcePath } = await ensureCbzCache(bookId, library);
    const pageNumber = normalizePageNumber(page, meta.pageCount);
    const cachedPage = meta.pages[pageNumber - 1];
    if (!cachedPage) throw new PageStreamingError(404, "Page not found");
    const source = meta.source;
    return extractCbzPage(bookId, cacheDir, meta, sourcePath, source, pageNumber, library);
  }

  if (format === "CBR") {
    const { cacheDir, meta, sourcePath } = await ensureCbrCache(bookId, library);
    const pageNumber = normalizePageNumber(page, meta.pageCount);
    const cachedPage = meta.pages[pageNumber - 1];
    if (!cachedPage) throw new PageStreamingError(404, "Page not found");

    // The file may be gone (quota eviction): lazily regenerate the single
    // page; if single-page extraction fails for a non-missing reason,
    // invalidate and fall back to a full re-ensure.
    const outputPath = join(cacheDir, cachedPage.fileName);
    if (existsSync(outputPath)) {
      return { path: outputPath, contentType: cachedPage.contentType };
    }
    const source = meta.source;
    try {
      return await extractCbrPage(bookId, cacheDir, meta, sourcePath, source, pageNumber, library);
    } catch (error) {
      if (error instanceof PageStreamingError && error.status === 404) throw error;
      metaMemCache.delete(metaCacheKey(bookId, format, library));
      const reensured = await ensureCbrCache(bookId, library);
      const rePage = reensured.meta.pages[pageNumber - 1];
      if (!rePage) throw new PageStreamingError(404, "Page not found");
      const rePath = join(reensured.cacheDir, rePage.fileName);
      if (existsSync(rePath)) {
        return { path: rePath, contentType: rePage.contentType };
      }
      const reSourcePath = reensured.sourcePath;
      return extractCbrPage(
        bookId,
        reensured.cacheDir,
        reensured.meta,
        reSourcePath,
        reensured.meta.source,
        pageNumber,
        library,
      );
    }
  }

  if (format === "PDF") {
    return getPdfPageFile(bookId, page, library);
  }

  return unsupportedFormat(format);
}
