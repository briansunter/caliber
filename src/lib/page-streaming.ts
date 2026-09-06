import JSZip from "jszip";
import { createExtractorFromData } from "node-unrar-js/esm";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CONFIG_DIR_PATH, LIBRARY_PATH } from "./config";
import { getBookFormatPath, getLibraryPath, getSnapshotRevision } from "./calibre-optimized";
import { getPathContentType } from "./book-files";
import { runSingleFlight } from "./epub-cache";
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

// Global job semaphore: max 3 concurrent PDF renders, max 2 archive extracts.
class JobSemaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running += 1;
    try {
      return await task();
    } finally {
      this.running -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const pdfRenderSemaphore = new JobSemaphore(3);
export const archiveExtractSemaphore = new JobSemaphore(2);

const activePageLeases = new Set<string>();

export function acquirePageLease(path: string): () => void {
  activePageLeases.add(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePageLeases.delete(path);
  };
}

export function pageSingleFlightKey(bookId: number, op: string, page: string): string {
  let library = "";
  let rev = 0;
  try {
    library = getLibraryPath();
  } catch { /* ignore */ }
  try {
    rev = getSnapshotRevision();
  } catch { /* ignore */ }
  return `${library}|${bookId}|${rev}|${op}|${page}`;
}

/** Pixel-count guard via PNG IHDR header without a full decode. */
export function assertPixelCountGuard(data: Uint8Array, fileName: string): void {
  if (extname(fileName).toLowerCase() !== ".png" || data.byteLength < 33) return;
  if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[12] === 0x49 && data[13] === 0x48 && data[14] === 0x44 && data[15] === 0x52
  ) {
    const w = (((data[16] ?? 0) * 2 ** 24 + (data[17] ?? 0) * 2 ** 16 + (data[18] ?? 0) * 2 ** 8 + (data[19] ?? 0)) >>> 0);
    const h = (((data[20] ?? 0) * 2 ** 24 + (data[21] ?? 0) * 2 ** 16 + (data[22] ?? 0) * 2 ** 8 + (data[23] ?? 0)) >>> 0);
    if (Number.isFinite(w) && Number.isFinite(h) && w * h > MAX_IMAGE_PIXELS) {
      throw new PageStreamingError(413, "Page image exceeds the pixel-count limit");
    }
  }
}

function entryUncompressedSize(entry: unknown): number | null {
  const size = (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

export function sweepPageCacheQuota(): void {
  try {
    const books = readdirSync(PAGE_CACHE_DIR, { withFileTypes: true });
    const files: Array<{ path: string; mtime: number }> = [];
    let total = 0;
    for (const book of books) {
      if (!book.isDirectory()) continue;
      const bookDir = join(PAGE_CACHE_DIR, book.name);
      let formats: Array<{ isDirectory(): boolean; name: string }>;
      try {
        formats = readdirSync(bookDir, { withFileTypes: true }) as unknown as Array<{ isDirectory(): boolean; name: string }>;
      } catch { continue; }
      for (const fmt of formats) {
        if (!fmt.isDirectory()) continue;
        const dir = join(bookDir, fmt.name);
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch { continue; }
        for (const entry of entries) {
          if (entry === CACHE_META_FILE) continue;
          const p = join(dir, entry);
          if (activePageLeases.has(p)) continue;
          try {
            const st = statSync(p);
            total += st.size;
            files.push({ path: p, mtime: st.mtimeMs });
          } catch { /* ignore */ }
        }
      }
    }
    if (total <= MAX_CACHE_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const { path } of files) {
      if (total <= MAX_CACHE_BYTES) break;
      if (activePageLeases.has(path)) continue;
      try {
        total -= statSync(path).size;
      } catch { /* ignore */ }
      try {
        rmSync(path, { force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

interface CachedPage {
  index: number;
  name: string;
  fileName: string;
  contentType: string;
  /** Full archive entry path for lazy on-demand extraction (CBZ). */
  sourceName?: string;
}

interface PageCacheMeta {
  source: SourceSignature;
  pageCount: number;
  pages: CachedPage[];
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

function metaCacheKey(bookId: number, format: string): string {
  // F04: scope the in-memory + singleflight key by library so switching
  // libraries never serves another library's validated meta.
  return `${LIBRARY_PATH}::${bookId}/${format.toUpperCase()}`;
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

function getCacheDir(bookId: number, format: string): string {
  return join(PAGE_CACHE_DIR, String(bookId), format.toUpperCase());
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

async function ensureCbzCache(bookId: number): Promise<{ cacheDir: string; meta: PageCacheMeta }> {
  const format = "CBZ";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format);

  const memEntry = metaMemCache.get(cacheKey);
  if (memEntry && isSameSignature(memEntry.signature, source)) {
    return { cacheDir, meta: memEntry.meta };
  }

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readJson<PageCacheMeta>(metaPath);

    if (
      existingMeta &&
      isSameSignature(existingMeta.source, source) &&
      existingMeta.pages.every((page) => existsSync(join(cacheDir, page.fileName)))
    ) {
      metaMemCache.set(cacheKey, { meta: existingMeta, signature: source });
      return { cacheDir, meta: existingMeta };
    }

    metaMemCache.delete(cacheKey);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });

    const zip = await JSZip.loadAsync(await Bun.file(sourcePath).arrayBuffer());
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
      pageCount: pages.length,
      pages,
    };
    await Bun.write(metaPath, `${JSON.stringify(meta)}\n`);
    metaMemCache.set(cacheKey, { meta, signature: source });

    return { cacheDir, meta };
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
): Promise<PageFile> {
  const cachedPage = meta.pages[pageNumber - 1];
  if (!cachedPage) throw new PageStreamingError(404, "Page not found");
  const outputPath = join(cacheDir, cachedPage.fileName);
  if (existsSync(outputPath)) {
    return { path: outputPath, contentType: cachedPage.contentType };
  }
  return runSingleFlight(pageSingleFlightKey(bookId, "cbz", String(pageNumber)), () =>
    archiveExtractSemaphore.run(async () => {
      if (existsSync(outputPath)) {
        return { path: outputPath, contentType: cachedPage.contentType };
      }
      // Never publish for a stale generation.
      const fresh = getSourceSignature(sourcePath);
      if (!isSameSignature(fresh, source)) {
        throw new PageStreamingError(409, "Reader source changed during extraction");
      }
      const zip = await JSZip.loadAsync(await Bun.file(sourcePath).arrayBuffer());
      const entryName = cachedPage.sourceName
        ?? Object.values(zip.files).find((e) => basename(e.name) === cachedPage.name)?.name;
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
        } catch { /* ignore */ }
        throw new PageStreamingError(409, "Reader source changed during extraction");
      }
      try {
        renameSync(tmpPath, outputPath);
      } catch {
        await Bun.write(outputPath, data);
        try {
          rmSync(tmpPath, { force: true });
        } catch { /* ignore */ }
      }
      sweepPageCacheQuota();
      return { path: outputPath, contentType: cachedPage.contentType };
    }),
  );
}

async function getUnrarWasmBinary(): Promise<ArrayBuffer> {
  const wasmPath = join(import.meta.dir, "..", "..", "node_modules", "node-unrar-js", "esm", "js", "unrar.wasm");
  return Bun.file(wasmPath).arrayBuffer();
}

async function ensureCbrCache(bookId: number): Promise<{ cacheDir: string; meta: PageCacheMeta }> {
  const format = "CBR";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format);

  const memEntry = metaMemCache.get(cacheKey);
  if (memEntry && isSameSignature(memEntry.signature, source)) {
    return { cacheDir, meta: memEntry.meta };
  }

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readJson<PageCacheMeta>(metaPath);

    if (
      existingMeta &&
      isSameSignature(existingMeta.source, source) &&
      existingMeta.pages.every((page) => existsSync(join(cacheDir, page.fileName)))
    ) {
      metaMemCache.set(cacheKey, { meta: existingMeta, signature: source });
      return { cacheDir, meta: existingMeta };
    }

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
      (header) => !header.flags.directory && extname(header.name).toLowerCase() === SKIPPED_SVG_EXTENSION,
    ).length;
    if (skippedSvg > 0) {
      console.warn(`[page-streaming] skipped ${skippedSvg} SVG page(s) in CBR source`);
    }
    const imageNames = fileHeaders
      .filter((header) => !header.flags.directory && IMAGE_EXTENSIONS.has(extname(header.name).toLowerCase()))
      .map((header) => header.name)
      .sort(sortPageNames);

    if (imageNames.length === 0) {
      throw new PageStreamingError(422, "CBR contains no image pages");
    }
    if (imageNames.length > MAX_PAGE_COUNT) {
      throw new PageStreamingError(413, "CBR contains too many pages");
    }

    const imageNameSet = new Set(imageNames);
    const extracted = await archiveExtractSemaphore.run(async () =>
      extractor.extract({ files: (header) => imageNameSet.has(header.name) }),
    );
    const extractedPages = new Map<string, Uint8Array>();
    for (const file of extracted.files) {
      if (file.extraction) {
        extractedPages.set(file.fileHeader.name, file.extraction);
      }
    }

    // Per-entry + cumulative cap checks BEFORE retaining: bound the total
    // before writing any file.
    let declaredTotal = 0;
    for (const name of imageNames) {
      const data = extractedPages.get(name);
      if (!data) continue;
      if (data.byteLength > MAX_CACHE_BYTES) {
        throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
      }
      declaredTotal += data.byteLength;
      if (declaredTotal > MAX_CACHE_BYTES) {
        throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
      }
    }
    const pages: CachedPage[] = [];
    let extractedBytes = 0;
    for (const [offset, name] of imageNames.entries()) {
      const data = extractedPages.get(name);
      if (!data) continue;
      extractedBytes += data.byteLength;
      if (extractedBytes > MAX_CACHE_BYTES) {
        throw new PageStreamingError(413, "CBR expands beyond the reader cache limit");
      }

      const index = offset + 1;
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
        } catch { /* ignore */ }
        throw new PageStreamingError(409, "Reader source changed during extraction");
      }
      try {
        renameSync(tmpPath, outputPath);
      } catch {
        await Bun.write(outputPath, data);
        try {
          rmSync(tmpPath, { force: true });
        } catch { /* ignore */ }
      }
      pages.push({
        index,
        name: basename(name),
        fileName,
        contentType: getPathContentType(fileName),
      });
    }
    sweepPageCacheQuota();

    if (pages.length === 0) {
      throw new PageStreamingError(422, "CBR pages could not be extracted");
    }

    const meta: PageCacheMeta = {
      source,
      pageCount: pages.length,
      pages,
    };
    await Bun.write(metaPath, `${JSON.stringify(meta)}\n`);
    metaMemCache.set(cacheKey, { meta, signature: source });

    return { cacheDir, meta };
  });
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

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
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

async function ensurePdfCache(bookId: number): Promise<{ cacheDir: string; sourcePath: string; source: SourceSignature; pageCount: number }> {
  const format = "PDF";
  const sourcePath = getSourcePath(bookId, format);
  assertArchiveSize(sourcePath);
  const source = getSourceSignature(sourcePath);
  const cacheDir = getCacheDir(bookId, format);
  const metaPath = join(cacheDir, CACHE_META_FILE);
  const cacheKey = metaCacheKey(bookId, format);

  return runSingleFlight(cacheKey, async () => {
    const existingMeta = await readJson<PageCacheMeta>(metaPath);

    if (existingMeta && isSameSignature(existingMeta.source, source)) {
      return {
        cacheDir,
        sourcePath,
        source,
        pageCount: existingMeta.pageCount,
      };
    }

    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });

    const pageCount = await getPdfPageCount(sourcePath);
    const meta: PageCacheMeta = {
      source,
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

async function getPdfPageFile(bookId: number, page: number): Promise<PageFile> {
  const { cacheDir, sourcePath, source, pageCount } = await ensurePdfCache(bookId);
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
  return runSingleFlight(pageSingleFlightKey(bookId, "pdf", String(pageNumber)), () =>
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
      } catch { /* ignore */ }
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
        } catch { /* ignore */ }
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
          } catch { /* ignore */ }
          throw error;
        }
      }
      try {
        renameSync(tmpPath, outputPath);
      } catch {
        await Bun.write(outputPath, await Bun.file(tmpPath).arrayBuffer());
        try {
          rmSync(tmpPath, { force: true });
        } catch { /* ignore */ }
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

  if (format === "CBZ") {
    const { meta } = await ensureCbzCache(bookId);
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
    const { meta } = await ensureCbrCache(bookId);
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
    const { pageCount } = await ensurePdfCache(bookId);
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

export async function getPageFile(bookId: number, formatParam: string, page: number): Promise<PageFile> {
  const format = formatParam.toUpperCase();

  if (format === "CBZ") {
    const { cacheDir, meta } = await ensureCbzCache(bookId);
    const pageNumber = normalizePageNumber(page, meta.pageCount);
    const cachedPage = meta.pages[pageNumber - 1];
    if (!cachedPage) throw new PageStreamingError(404, "Page not found");
    const sourcePath = getSourcePath(bookId, format);
    const source = getSourceSignature(sourcePath);
    return extractCbzPage(bookId, cacheDir, meta, sourcePath, source, pageNumber);
  }

  if (format === "CBR") {
    const { cacheDir, meta } = await ensureCbrCache(bookId);
    const pageNumber = normalizePageNumber(page, meta.pageCount);
    const cachedPage = meta.pages[pageNumber - 1];
    if (!cachedPage) throw new PageStreamingError(404, "Page not found");

    return {
      path: join(cacheDir, cachedPage.fileName),
      contentType: cachedPage.contentType,
    };
  }

  if (format === "PDF") {
    return getPdfPageFile(bookId, page);
  }

  return unsupportedFormat(format);
}
