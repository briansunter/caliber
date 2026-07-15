import JSZip from "jszip";
import { createExtractorFromData } from "node-unrar-js/esm";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CONFIG_DIR_PATH } from "./config";
import { getBookFormatPath } from "./calibre-optimized";
import { getPathContentType } from "./book-files";
import { type SourceSignature, getSourceSignature, isSameSignature } from "./file-signature";

const PAGE_CACHE_DIR = join(CONFIG_DIR_PATH, "page-cache");
const CACHE_META_FILE = ".caliber-page-cache.json";
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_PAGE_COUNT = 10_000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

interface CachedPage {
  index: number;
  name: string;
  fileName: string;
  contentType: string;
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
  return `${bookId}/${format.toUpperCase()}`;
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
  let extractedBytes = 0;
  for (const [offset, entry] of imageEntries.entries()) {
    const index = offset + 1;
    const ext = extname(entry.name).toLowerCase() || ".bin";
    const fileName = `${String(index).padStart(5, "0")}${ext}`;
    const outputPath = join(cacheDir, fileName);
    const data = await entry.async("uint8array");
    extractedBytes += data.byteLength;
    if (extractedBytes > MAX_CACHE_BYTES) {
      throw new PageStreamingError(413, "CBZ expands beyond the reader cache limit");
    }
    await Bun.write(outputPath, data);
    pages.push({
      index,
      name: basename(entry.name),
      fileName,
      contentType: getPathContentType(fileName),
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
  const imageNames = [...list.fileHeaders]
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
  const extracted = extractor.extract({ files: (header) => imageNameSet.has(header.name) });
  const extractedPages = new Map<string, Uint8Array>();
  for (const file of extracted.files) {
    if (file.extraction) {
      extractedPages.set(file.fileHeader.name, file.extraction);
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
    await Bun.write(join(cacheDir, fileName), data);
    pages.push({
      index,
      name: basename(name),
      fileName,
      contentType: getPathContentType(fileName),
    });
  }

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
}

async function getPdfPageFile(bookId: number, page: number): Promise<PageFile> {
  const { cacheDir, sourcePath, pageCount } = await ensurePdfCache(bookId);
  const pageNumber = normalizePageNumber(page, pageCount);
  const outputPrefix = join(cacheDir, String(pageNumber).padStart(5, "0"));
  const outputPath = `${outputPrefix}.png`;

  if (!existsSync(outputPath)) {
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
      outputPrefix,
    ]);
  }

  return {
    path: outputPath,
    contentType: "image/png",
  };
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

    return {
      path: join(cacheDir, cachedPage.fileName),
      contentType: cachedPage.contentType,
    };
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
