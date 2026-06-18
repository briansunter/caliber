import { serve } from "bun";
import index from "./index.html";
import {
  listBooksCursor,
  searchBooksCursor,
  listAuthorsCursor,
  listSeriesCursor,
  listTagsCursor,
  listAllTags,
  listFormatsCursor,
  listBooksByAuthorCursor,
  listBooksBySeriesCursor,
  listBooksByTagCursor,
  listBooksByFormatCursor,
  getCatalogEntry,
  getBookByIdOptimized,
  getLibraryStats,
  getBookCount,
  streamBooks,
  getLibraryPath,
  getBookFormatPath,
  getBookCoverPath,
  getBookTitle,
  initFTS,
  onDbRefresh,
  CursorError,
  type BookListItem,
  type CatalogEntry,
  type CursorPaginatedResult,
} from "./lib/calibre-optimized";
import {
  OPDS_ACQUISITION_TYPE,
  OPDS_NAVIGATION_TYPE,
  OPENSEARCH_TYPE,
  renderAcquisitionFeed,
  renderCatalogFeed,
  renderNavigationFeed,
  renderOpenSearchDescription,
  renderSingleBookFeed,
} from "./lib/opds";
import { getFormatContentType, getPathContentType, getSafeBookFilename } from "./lib/book-files";
import { EpubCacheError, getEpubEntryPath } from "./lib/epub-cache";
import { getPageFile, getPageManifest, PageStreamingError } from "./lib/page-streaming";
import { handleMCPRequest } from "./mcp";
import {
  getOrCreateUser,
  getUserByUsername,
  isValidUsername,
  getProgress,
  listProgress,
  upsertProgress,
  deleteProgress,
  clearProgress,
  type User,
} from "./lib/user-db";
import { join } from "node:path";
import { CONFIG_DIR_PATH } from "./lib/config";

const LIBRARY_PATH = getLibraryPath();
const WORK_DIR = CONFIG_DIR_PATH;
const DEFAULT_PORT = 3003;
const MAX_QUERY_LIMIT = 100;
const MAX_STREAM_BATCH_SIZE = 5000;
const SORT_FIELDS = ["title", "author", "added", "rating"] as const;
const SORT_ORDERS = ["asc", "desc"] as const;
const OPTIONAL_EPUB_DISPLAY_OPTIONS_PATH = "META-INF/com.apple.ibooks.display-options.xml";
const FORMAT_PATTERN = /^[A-Za-z0-9]{1,10}$/;
const DEFAULT_EPUB_DISPLAY_OPTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<display_options/>`;

type SortField = (typeof SORT_FIELDS)[number];
type SortOrder = (typeof SORT_ORDERS)[number];

function parseBoundedInt(
  value: string | null | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function parseSortField(value: string | null): SortField {
  return SORT_FIELDS.includes(value as SortField) ? (value as SortField) : "title";
}

function parseSortOrder(value: string | null): SortOrder {
  return SORT_ORDERS.includes(value as SortOrder) ? (value as SortOrder) : "asc";
}

// Parse repeated `tag` query params into deduped, valid tag IDs (OR logic).
const MAX_TAG_FILTERS = 50;
function parseTagIds(url: URL): number[] {
  const raw = url.searchParams.getAll("tag");
  if (raw.length === 0) return [];
  const ids = new Set<number>();
  for (const value of raw) {
    const id = Number.parseInt(value, 10);
    if (Number.isFinite(id) && id > 0) {
      ids.add(id);
      if (ids.size >= MAX_TAG_FILTERS) break;
    }
  }
  return Array.from(ids);
}

// --- User session cookie (no auth yet: cookie just remembers a username) ---
const USER_COOKIE = "caliber-user";
const USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("Cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function userCookieHeader(username: string | null): string {
  const base = `${USER_COOKIE}=`;
  const attrs = "Path=/; HttpOnly; SameSite=Lax";
  if (username === null) {
    return `${base}; ${attrs}; Max-Age=0`;
  }
  return `${base}${encodeURIComponent(username)}; ${attrs}; Max-Age=${USER_COOKIE_MAX_AGE}`;
}

// Resolve the current user from the cookie. Does NOT create a user — login does.
function currentUser(req: Request): User | null {
  const username = parseCookies(req)[USER_COOKIE];
  if (!username) return null;
  return getUserByUsername(username);
}

function publicUser(user: User) {
  return { id: user.id, username: user.username };
}

// Initialize FTS on startup
initFTS();
onDbRefresh(() => apiCache.clear());

const MAX_CACHE_BYTES = 50 * 1024 * 1024;

class LRUCache<K extends string, V extends { data: string }> {
  private cache = new Map<K, V>();
  private maxSize: number;
  private maxBytes: number;
  private totalBytes = 0;

  constructor(maxSize: number, maxBytes: number = MAX_CACHE_BYTES) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    const incoming = value.data.length;
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.data.length;
      this.cache.delete(key);
    }
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.maxSize || this.totalBytes + incoming > this.maxBytes)
    ) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      const evicted = this.cache.get(firstKey);
      if (evicted !== undefined) this.totalBytes -= evicted.data.length;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
    this.totalBytes += incoming;
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }
}

interface CachedResponse {
  data: string;
  etag: string;
  timestamp: number;
}

const apiCache = new LRUCache<string, CachedResponse>(100);
const CACHE_TTL = 60 * 1000; // 1 minute for list results

function generateETag(data: string): string {
  const hash = Bun.hash(data);
  return `"${hash.toString(36)}"`;
}

function getCachedResponse(cacheKey: string, data: unknown, req: Request): Response {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === cached.etag) {
      return new Response(null, { status: 304, headers: { ETag: cached.etag } });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        ETag: cached.etag,
      },
    });
  }

  const jsonData = JSON.stringify(data);
  const etag = generateETag(jsonData);

  apiCache.set(cacheKey, { data: jsonData, etag, timestamp: now });

  return new Response(jsonData, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      ETag: etag,
    },
  });
}

function getCachedTextResponse(
  cacheKey: string,
  data: string,
  req: Request,
  contentType: string,
  cacheControl: string = "public, max-age=60",
): Response {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === cached.etag) {
      return new Response(null, { status: 304, headers: { ETag: cached.etag } });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ETag: cached.etag,
      },
    });
  }

  const etag = generateETag(data);
  apiCache.set(cacheKey, { data, etag, timestamp: now });

  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}

function getPublicBaseUrl(req: Request): string {
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("Host") || url.host;
  const protocol = forwardedProto || url.protocol.replace(":", "");

  return `${protocol}://${host}`;
}

function getRequestPath(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}

function buildPath(pathname: string, params: Record<string, string | number | null | undefined>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function parseOpdsPageParams(req: Request) {
  const url = new URL(req.url);
  return {
    cursor: url.searchParams.get("cursor") || undefined,
    limit: parseBoundedInt(url.searchParams.get("limit"), 50, {
      min: 1,
      max: MAX_QUERY_LIMIT,
    }),
    sortBy: parseSortField(url.searchParams.get("sortBy")),
    sortOrder: parseSortOrder(url.searchParams.get("sortOrder")),
  };
}

function parseOpdsCatalogParams(req: Request) {
  const url = new URL(req.url);
  return {
    cursor: url.searchParams.get("cursor") || undefined,
    limit: parseBoundedInt(url.searchParams.get("limit"), 50, {
      min: 1,
      max: MAX_QUERY_LIMIT,
    }),
  };
}

function parseBookId(value: string): number | null {
  const id = parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
}

function opdsCatalogResponse(
  req: Request,
  title: string,
  basePath: string,
  result: CursorPaginatedResult<CatalogEntry>,
  entryHref: (entry: CatalogEntry) => string,
): Response {
  const { limit } = parseOpdsCatalogParams(req);
  const baseUrl = getPublicBaseUrl(req);
  const selfPath = getRequestPath(req);
  const nextPath = result.nextCursor
    ? buildPath(basePath, { cursor: result.nextCursor, limit })
    : undefined;
  const feed = renderCatalogFeed({
    baseUrl,
    selfPath,
    title,
    id: new URL(selfPath, baseUrl).toString(),
    updated: new Date().toISOString(),
    result,
    nextPath,
    entryHref,
  });

  return getCachedTextResponse(
    `opds:catalog:${baseUrl}:${selfPath}`,
    feed,
    req,
    `${OPDS_NAVIGATION_TYPE}; charset=utf-8`,
  );
}

function opdsAcquisitionResponse(
  req: Request,
  title: string,
  basePath: string,
  result: CursorPaginatedResult<BookListItem>,
  options?: { sortBy?: SortField; sortOrder?: SortOrder; noStore?: boolean },
): Response {
  const params = parseOpdsPageParams(req);
  const sortBy = options?.sortBy ?? params.sortBy;
  const sortOrder = options?.sortOrder ?? params.sortOrder;
  const baseUrl = getPublicBaseUrl(req);
  const selfPath = getRequestPath(req);
  const nextPath = result.nextCursor
    ? buildPath(basePath, {
        cursor: result.nextCursor,
        limit: params.limit,
        sortBy,
        sortOrder,
      })
    : undefined;
  const feed = renderAcquisitionFeed({
    baseUrl,
    selfPath,
    title,
    id: new URL(selfPath, baseUrl).toString(),
    updated: new Date().toISOString(),
    result,
    nextPath,
  });

  if (options?.noStore) {
    return new Response(feed, {
      headers: {
        "Content-Type": `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
        "Cache-Control": "no-store",
      },
    });
  }

  return getCachedTextResponse(
    `opds:acquisition:${baseUrl}:${selfPath}`,
    feed,
    req,
    `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
  );
}

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(rangeHeader: string, size: number): ByteRange | null {
  if (size <= 0 || !rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) {
    return null;
  }

  const range = rangeHeader.slice("bytes=".length);
  const [startPart, endPart] = range.split("-", 2);

  if (startPart === undefined || endPart === undefined) return null;

  if (startPart === "") {
    const suffixLength = parseInt(endPart, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;

    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = parseInt(startPart, 10);
  const end = endPart === "" ? size - 1 : parseInt(endPart, 10);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function contentDisposition(disposition: "attachment" | "inline", filename: string): string {
  return `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function ifRangeAllowsRange(ifRange: string | null, etag: string, mtimeMs: number): boolean {
  if (!ifRange) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return ifRange === etag;

  const parsed = Date.parse(ifRange);
  return Number.isFinite(parsed) && Math.floor(mtimeMs / 1000) <= Math.floor(parsed / 1000);
}

async function serveLocalFile(
  req: Request,
  filePath: string,
  options: {
    contentType: string;
    contentDisposition?: string;
    cacheControl?: string;
  },
): Promise<Response> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  const fileStat = await file.stat();
  const mtimeMs = fileStat.mtime?.getTime() || 0;
  const lastModified = fileStat.mtime?.toUTCString();
  const etag = `"${fileStat.size}-${mtimeMs}"`;
  const includeBody = req.method !== "HEAD";
  const rangeHeader = req.headers.get("Range");
  const shouldAttemptRange = Boolean(
    rangeHeader && ifRangeAllowsRange(req.headers.get("If-Range"), etag, mtimeMs),
  );

  const baseHeaders = new Headers({
    "Content-Type": options.contentType,
    "Cache-Control": options.cacheControl ?? "no-cache",
    "Accept-Ranges": "bytes",
    ETag: etag,
  });
  if (lastModified) baseHeaders.set("Last-Modified", lastModified);
  if (options.contentDisposition) {
    baseHeaders.set("Content-Disposition", options.contentDisposition);
  }

  const ifNoneMatch = req.headers.get("If-None-Match");
  if (!rangeHeader && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (shouldAttemptRange && rangeHeader) {
    const range = parseByteRange(rangeHeader, fileStat.size);

    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileStat.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": options.cacheControl ?? "no-cache",
          ETag: etag,
        },
      });
    }

    const length = range.end - range.start + 1;
    baseHeaders.set("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
    baseHeaders.set("Content-Length", String(length));

    return new Response(includeBody ? file.slice(range.start, range.end + 1) : null, {
      status: 206,
      headers: baseHeaders,
    });
  }

  baseHeaders.set("Content-Length", String(fileStat.size));

  return new Response(includeBody ? file : null, { headers: baseHeaders });
}

async function serveBookFile(
  req: Request,
  id: number,
  formatParam: string,
  disposition: "attachment" | "inline",
): Promise<Response> {
  if (!FORMAT_PATTERN.test(formatParam)) {
    return Response.json({ error: "Invalid format" }, { status: 400 });
  }
  const format = formatParam.toUpperCase();
  const filePath = getBookFormatPath(id, format);

  if (!filePath) {
    return Response.json({ error: `Format ${format} not found` }, { status: 404 });
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  const title = getBookTitle(id);
  const filename = getSafeBookFilename(title, format);
  const contentType = getFormatContentType(format);

  return serveLocalFile(req, filePath, {
    contentType,
    contentDisposition: contentDisposition(disposition, filename),
    cacheControl: "no-cache",
  });
}

function getEpubEntryFromRequest(req: Request, id: number): string {
  const pathname = new URL(req.url).pathname;
  const prefix = `/api/books/${id}/epub/`;
  if (!pathname.startsWith(prefix)) return "META-INF/container.xml";

  const entryPath = pathname.slice(prefix.length);
  return entryPath || "META-INF/container.xml";
}

async function serveEpubEntry(req: Request, id: number): Promise<Response> {
  const entryPath = getEpubEntryFromRequest(req, id);
  const filePath = await getEpubEntryPath(id, entryPath);

  if (!filePath) {
    if (entryPath === OPTIONAL_EPUB_DISPLAY_OPTIONS_PATH) {
      return new Response(req.method === "HEAD" ? null : DEFAULT_EPUB_DISPLAY_OPTIONS, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return Response.json({ error: "EPUB entry not found" }, { status: 404 });
  }

  return serveLocalFile(req, filePath, {
    contentType: getPathContentType(entryPath),
    cacheControl: "no-cache",
  });
}

function routeErrorResponse(error: unknown, logLabel: string, message: string): Response {
  if (error instanceof CursorError) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }
  console.error(logLabel, error);
  return Response.json({ error: message }, { status: 500 });
}

function pageStreamingErrorResponse(error: unknown): Response {
  if (error instanceof PageStreamingError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Page streaming error:", error);
  return Response.json({ error: "Failed to stream page" }, { status: 500 });
}

function epubEntryErrorResponse(error: unknown): Response {
  if (error instanceof EpubCacheError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error("Error serving EPUB entry:", error);
  return Response.json({ error: "Failed to serve EPUB entry" }, { status: 500 });
}

const streamEncoder = new TextEncoder();

// Streaming JSON response for large datasets
async function* streamBooksJSON(
  generator: AsyncGenerator<BookListItem[], void, unknown>,
): AsyncGenerator<string, void, unknown> {
  yield "[";
  let first = true;

  for await (const batch of generator) {
    for (const book of batch) {
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(book);
    }
  }

  yield "]";
}

const server = serve({
  port: parseBoundedInt(process.env.PORT, DEFAULT_PORT, { min: 1, max: 65535 }),
  routes: {
    // Health check
    "/api/health": {
      GET: () => Response.json({ status: "ok", timestamp: Date.now() }),
    },

    // Library stats
    "/api/stats": {
      GET: (req) => {
        const stats = getLibraryStats();
        return getCachedResponse("stats", stats, req);
      },
    },

    // All tags with book counts (for the tag filter UI)
    "/api/tags": {
      GET: (req) => {
        const tags = listAllTags();
        return getCachedResponse("tags", tags, req);
      },
    },

    // Book count (lightweight)
    "/api/books/count": {
      GET: (req) => {
        const count = getBookCount();
        return getCachedResponse("count", { count }, req);
      },
    },

    // --- Users & reading progress (server-side, no auth) ---

    // Who am I? (reads the cookie)
    "/api/user/me": {
      GET: (req) => {
        const user = currentUser(req);
        return Response.json({ user: user ? publicUser(user) : null });
      },
    },

    // "Log in" = remember a username and set the cookie.
    "/api/user/login": {
      POST: async (req) => {
        let body: { username?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const username = typeof body.username === "string" ? body.username : "";
        if (!isValidUsername(username)) {
          return Response.json({ error: "Invalid username" }, { status: 400 });
        }
        const user = getOrCreateUser(username);
        if (!user) {
          return Response.json({ error: "Could not create user" }, { status: 500 });
        }
        return Response.json(
          { user: publicUser(user) },
          { headers: { "Set-Cookie": userCookieHeader(user.username) } },
        );
      },
    },

    // Forget the current user (clear cookie)
    "/api/user/logout": {
      POST: () =>
        Response.json({ ok: true }, { headers: { "Set-Cookie": userCookieHeader(null) } }),
    },

    // Recently-read shelf: progress rows enriched with book metadata for cards.
    "/api/user/reading": {
      DELETE: (req) => {
        const user = currentUser(req);
        if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
        return Response.json({ removed: clearProgress(user.id) });
      },
      GET: (req) => {
        const user = currentUser(req);
        if (!user) return Response.json({ items: [] });
        const url = new URL(req.url);
        const limit = parseBoundedInt(url.searchParams.get("limit"), 200, { min: 1, max: 500 });
        const rows = listProgress(user.id, limit);
        const items = [];
        for (const row of rows) {
          const book = getBookByIdOptimized(row.bookId);
          if (!book) continue; // book removed from library — skip
          items.push({
            book: {
              id: book.id,
              title: book.title,
              authors: book.authors,
              series: book.series,
              series_index: book.series_index,
              formats: book.formats,
              has_cover: book.has_cover,
            },
            progress: {
              format: row.format,
              percentage: row.percentage,
              finished: row.finished,
              updatedAt: row.updatedAt,
            },
          });
        }
        return Response.json({ items });
      },
    },

    // Per-book progress for the active reader
    "/api/user/progress/:bookId": {
      GET: (req) => {
        const user = currentUser(req);
        if (!user) return Response.json({ progress: null });
        const bookId = Number.parseInt(req.params.bookId, 10);
        if (!Number.isFinite(bookId)) {
          return Response.json({ error: "Invalid book id" }, { status: 400 });
        }
        return Response.json({ progress: getProgress(user.id, bookId) });
      },
      PUT: async (req) => {
        const user = currentUser(req);
        if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
        const bookId = Number.parseInt(req.params.bookId, 10);
        if (!Number.isFinite(bookId)) {
          return Response.json({ error: "Invalid book id" }, { status: 400 });
        }
        let body: {
          format?: unknown;
          location?: unknown;
          percentage?: unknown;
          finished?: unknown;
        };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const progress = upsertProgress(user.id, bookId, {
          format: typeof body.format === "string" ? body.format : "",
          location: typeof body.location === "string" ? body.location : null,
          percentage: typeof body.percentage === "number" ? body.percentage : 0,
          finished: body.finished === true,
        });
        return Response.json({ progress });
      },
      DELETE: (req) => {
        const user = currentUser(req);
        if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
        const bookId = Number.parseInt(req.params.bookId, 10);
        if (!Number.isFinite(bookId)) {
          return Response.json({ error: "Invalid book id" }, { status: 400 });
        }
        return Response.json({ removed: deleteProgress(user.id, bookId) });
      },
    },

    // OPDS catalog root
    "/opds": {
      GET: (req) => {
        try {
          const baseUrl = getPublicBaseUrl(req);
          const updated = new Date().toISOString();
          const feed = renderNavigationFeed({
            baseUrl,
            updated,
            totalBooks: getBookCount(),
          });

          return getCachedTextResponse(
            `opds:root:${baseUrl}`,
            feed,
            req,
            `${OPDS_NAVIGATION_TYPE}; charset=utf-8`,
          );
        } catch (error) {
          console.error("Error rendering OPDS root:", error);
          return Response.json({ error: "Failed to render OPDS root" }, { status: 500 });
        }
      },
    },

    // OpenSearch descriptor used by OPDS clients
    "/opds/search.xml": {
      GET: (req) => {
        try {
          const baseUrl = getPublicBaseUrl(req);
          const description = renderOpenSearchDescription(baseUrl);

          return getCachedTextResponse(
            `opds:search-description:${baseUrl}`,
            description,
            req,
            `${OPENSEARCH_TYPE}; charset=utf-8`,
            "public, max-age=3600",
          );
        } catch (error) {
          console.error("Error rendering OPDS search descriptor:", error);
          return Response.json(
            { error: "Failed to render OPDS search descriptor" },
            { status: 500 },
          );
        }
      },
    },

    // Paged OPDS acquisition feed
    "/opds/books": {
      GET: (req) => {
        try {
          const params = parseOpdsPageParams(req);
          const result = listBooksCursor(params);
          const title = params.sortBy === "added" ? "Recently added" : "All books";
          return opdsAcquisitionResponse(req, title, "/opds/books", result);
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS books:", "Failed to render OPDS books");
        }
      },
    },

    // Recently-added OPDS acquisition feed
    "/opds/recent": {
      GET: (req) => {
        try {
          const params = parseOpdsPageParams(req);
          const result = listBooksCursor({
            cursor: params.cursor,
            limit: params.limit,
            sortBy: "added",
            sortOrder: "desc",
          });

          return opdsAcquisitionResponse(req, "Recently added", "/opds/recent", result, {
            sortBy: "added",
            sortOrder: "desc",
          });
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS recent books:", "Failed to render OPDS recent books");
        }
      },
    },

    // OPDS author navigation feed
    "/opds/authors": {
      GET: (req) => {
        try {
          const params = parseOpdsCatalogParams(req);
          const result = listAuthorsCursor(params);
          return opdsCatalogResponse(req, "Authors", "/opds/authors", result, (entry) =>
            `/opds/authors/${encodeURIComponent(String(entry.id))}/books`
          );
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS authors:", "Failed to render OPDS authors");
        }
      },
    },

    "/opds/authors/:id/books": {
      GET: (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid author ID" }, { status: 400 });
          }

          const entry = getCatalogEntry("authors", id);
          if (!entry) {
            return Response.json({ error: "Author not found" }, { status: 404 });
          }

          const params = parseOpdsPageParams(req);
          const result = listBooksByAuthorCursor(id, params);
          return opdsAcquisitionResponse(req, `Author: ${entry.title}`, `/opds/authors/${id}/books`, result);
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS author books:", "Failed to render OPDS author books");
        }
      },
    },

    // OPDS series navigation feed
    "/opds/series": {
      GET: (req) => {
        try {
          const params = parseOpdsCatalogParams(req);
          const result = listSeriesCursor(params);
          return opdsCatalogResponse(req, "Series", "/opds/series", result, (entry) =>
            `/opds/series/${encodeURIComponent(String(entry.id))}/books`
          );
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS series:", "Failed to render OPDS series");
        }
      },
    },

    "/opds/series/:id/books": {
      GET: (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid series ID" }, { status: 400 });
          }

          const entry = getCatalogEntry("series", id);
          if (!entry) {
            return Response.json({ error: "Series not found" }, { status: 404 });
          }

          const params = parseOpdsPageParams(req);
          const result = listBooksBySeriesCursor(id, params);
          return opdsAcquisitionResponse(req, `Series: ${entry.title}`, `/opds/series/${id}/books`, result);
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS series books:", "Failed to render OPDS series books");
        }
      },
    },

    // OPDS tag navigation feed
    "/opds/tags": {
      GET: (req) => {
        try {
          const params = parseOpdsCatalogParams(req);
          const result = listTagsCursor(params);
          return opdsCatalogResponse(req, "Tags", "/opds/tags", result, (entry) =>
            `/opds/tags/${encodeURIComponent(String(entry.id))}/books`
          );
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS tags:", "Failed to render OPDS tags");
        }
      },
    },

    "/opds/tags/:id/books": {
      GET: (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid tag ID" }, { status: 400 });
          }

          const entry = getCatalogEntry("tags", id);
          if (!entry) {
            return Response.json({ error: "Tag not found" }, { status: 404 });
          }

          const params = parseOpdsPageParams(req);
          const result = listBooksByTagCursor(id, params);
          return opdsAcquisitionResponse(req, `Tag: ${entry.title}`, `/opds/tags/${id}/books`, result);
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS tag books:", "Failed to render OPDS tag books");
        }
      },
    },

    // OPDS format navigation feed
    "/opds/formats": {
      GET: (req) => {
        try {
          const params = parseOpdsCatalogParams(req);
          const result = listFormatsCursor(params);
          return opdsCatalogResponse(req, "Formats", "/opds/formats", result, (entry) =>
            `/opds/formats/${encodeURIComponent(String(entry.id))}/books`
          );
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS formats:", "Failed to render OPDS formats");
        }
      },
    },

    "/opds/formats/:format/books": {
      GET: (req) => {
        try {
          const format = decodeURIComponent(req.params.format).toUpperCase();
          const entry = getCatalogEntry("formats", format);
          if (!entry) {
            return Response.json({ error: "Format not found" }, { status: 404 });
          }

          const params = parseOpdsPageParams(req);
          const result = listBooksByFormatCursor(format, params);
          return opdsAcquisitionResponse(
            req,
            `Format: ${entry.title}`,
            `/opds/formats/${encodeURIComponent(format)}/books`,
            result,
          );
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS format books:", "Failed to render OPDS format books");
        }
      },
    },

    // Paged OPDS search feed
    "/opds/search": {
      GET: (req) => {
        try {
          const url = new URL(req.url);
          const baseUrl = getPublicBaseUrl(req);
          const query = url.searchParams.get("q") || "";
          const cursor = url.searchParams.get("cursor") || undefined;
          const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
            min: 1,
            max: MAX_QUERY_LIMIT,
          });
          const sortBy = parseSortField(url.searchParams.get("sortBy"));
          const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
          const result = searchBooksCursor({ query, cursor, limit, sortBy, sortOrder });
          const nextPath = result.nextCursor
            ? buildPath("/opds/search", {
                q: query,
                cursor: result.nextCursor,
                limit,
                sortBy,
                sortOrder,
              })
            : undefined;
          const selfPath = getRequestPath(req);
          const title = query.trim() ? `Search: ${query.trim()}` : "Search";
          const feed = renderAcquisitionFeed({
            baseUrl,
            selfPath,
            title,
            id: new URL(selfPath, baseUrl).toString(),
            updated: new Date().toISOString(),
            result,
            nextPath,
          });

          return new Response(feed, {
            headers: {
              "Content-Type": `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return routeErrorResponse(error, "Error rendering OPDS search:", "Failed to render OPDS search");
        }
      },
    },

    // OPDS single-book acquisition feed
    "/opds/book/:id": {
      GET: (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const book = getBookByIdOptimized(id);
          if (!book) {
            return Response.json({ error: "Book not found" }, { status: 404 });
          }

          const baseUrl = getPublicBaseUrl(req);
          const selfPath = getRequestPath(req);
          const feed = renderSingleBookFeed({
            baseUrl,
            selfPath,
            updated: new Date().toISOString(),
            book,
          });

          return getCachedTextResponse(
            `opds:book:${baseUrl}:${id}`,
            feed,
            req,
            `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
          );
        } catch (error) {
          console.error("Error rendering OPDS book:", error);
          return Response.json({ error: "Failed to render OPDS book" }, { status: 500 });
        }
      },
    },

    // Stream all books (for massive datasets)
    "/api/books/stream": {
      GET: async (req) => {
        const url = new URL(req.url);
        const batchSize = parseBoundedInt(url.searchParams.get("batchSize"), 1000, {
          min: 1,
          max: MAX_STREAM_BATCH_SIZE,
        });

        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of streamBooksJSON(streamBooks(batchSize))) {
                controller.enqueue(streamEncoder.encode(chunk));
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          },
        });
      },
    },

    // Cursor-based paginated list
    "/api/books": {
      GET: (req) => {
        try {
          const url = new URL(req.url);
          const cursor = url.searchParams.get("cursor") || undefined;
          const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
            min: 1,
            max: MAX_QUERY_LIMIT,
          });
          const sortBy = parseSortField(url.searchParams.get("sortBy"));
          const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
          const tagIds = parseTagIds(url);

          const result = listBooksCursor({ cursor, limit, sortBy, sortOrder, tagIds });

          const cacheKey = `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}:tags:${tagIds.join(",")}`;
          return getCachedResponse(cacheKey, result, req);
        } catch (error) {
          return routeErrorResponse(error, "Error listing books:", "Failed to list books");
        }
      },
    },

    // Search with cursor pagination
    "/api/books/search": {
      GET: (req) => {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") || "";
          const cursor = url.searchParams.get("cursor") || undefined;
          const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
            min: 1,
            max: MAX_QUERY_LIMIT,
          });
          const sortBy = parseSortField(url.searchParams.get("sortBy"));
          const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
          const tagIds = parseTagIds(url);

          if (!query.trim()) {
            const result = listBooksCursor({ cursor, limit, sortBy, sortOrder, tagIds });
            return getCachedResponse(
              `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}:tags:${tagIds.join(",")}`,
              result,
              req,
            );
          }

          const result = searchBooksCursor({ query, cursor, limit, sortBy, sortOrder, tagIds });

          // Don't cache search results
          return Response.json(result, {
            headers: {
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return routeErrorResponse(error, "Error searching books:", "Failed to search books");
        }
      },
    },

    // Get single book
    "/api/books/:id": {
      GET: (req) => {
        try {
          const id = parseInt(req.params.id, 10);

          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const book = getBookByIdOptimized(id);

          if (!book) {
            return Response.json({ error: "Book not found" }, { status: 404 });
          }

          return getCachedResponse(`book:${id}`, book, req);
        } catch (error) {
          console.error("Error getting book:", error);
          return Response.json({ error: "Failed to get book" }, { status: 500 });
        }
      },
    },

    // Download book
    "/api/books/:id/download/:format": {
      GET: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveBookFile(req, id, req.params.format, "attachment");
        } catch (error) {
          console.error("Error downloading book:", error);
          return Response.json({ error: "Failed to download book" }, { status: 500 });
        }
      },
      HEAD: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveBookFile(req, id, req.params.format, "attachment");
        } catch (error) {
          console.error("Error downloading book:", error);
          return Response.json({ error: "Failed to download book" }, { status: 500 });
        }
      },
    },

    // Stream/open a book file inline with byte-range support
    "/api/books/:id/file/:format": {
      GET: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveBookFile(req, id, req.params.format, "inline");
        } catch (error) {
          console.error("Error streaming book:", error);
          return Response.json({ error: "Failed to stream book" }, { status: 500 });
        }
      },
      HEAD: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveBookFile(req, id, req.params.format, "inline");
        } catch (error) {
          console.error("Error streaming book:", error);
          return Response.json({ error: "Failed to stream book" }, { status: 500 });
        }
      },
    },

    // Serve unpacked EPUB entries for true page/resource streaming in epub.js
    "/api/books/:id/epub": {
      GET: (req) => {
        const url = new URL(req.url);
        url.pathname = `/api/books/${req.params.id}/epub/`;
        return Response.redirect(url, 308);
      },
      HEAD: (req) => {
        const url = new URL(req.url);
        url.pathname = `/api/books/${req.params.id}/epub/`;
        return Response.redirect(url, 308);
      },
    },

    "/api/books/:id/epub/**": {
      GET: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveEpubEntry(req, id);
        } catch (error) {
          return epubEntryErrorResponse(error);
        }
      },
      HEAD: async (req) => {
        try {
          const id = parseBookId(req.params.id);

          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          return await serveEpubEntry(req, id);
        } catch (error) {
          return epubEntryErrorResponse(error);
        }
      },
    },

    // Page manifests and rendered/extracted page images for comics and PDFs
    "/api/books/:id/pages/:format/manifest": {
      GET: async (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }
          if (!FORMAT_PATTERN.test(req.params.format)) {
            return Response.json({ error: "Invalid format" }, { status: 400 });
          }

          const manifest = await getPageManifest(id, req.params.format);
          return Response.json(manifest, {
            headers: {
              "Cache-Control": "no-cache",
            },
          });
        } catch (error) {
          return pageStreamingErrorResponse(error);
        }
      },
      HEAD: async (req) => {
        try {
          const id = parseBookId(req.params.id);
          if (id === null) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }
          if (!FORMAT_PATTERN.test(req.params.format)) {
            return Response.json({ error: "Invalid format" }, { status: 400 });
          }

          await getPageManifest(id, req.params.format);
          return new Response(null, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
            },
          });
        } catch (error) {
          return pageStreamingErrorResponse(error);
        }
      },
    },

    "/api/books/:id/pages/:format/:page": {
      GET: async (req) => {
        try {
          const id = parseBookId(req.params.id);
          const page = Number.parseInt(req.params.page, 10);
          if (id === null || !Number.isFinite(page)) {
            return Response.json({ error: "Invalid page request" }, { status: 400 });
          }
          if (!FORMAT_PATTERN.test(req.params.format)) {
            return Response.json({ error: "Invalid format" }, { status: 400 });
          }

          const pageFile = await getPageFile(id, req.params.format, page);
          return serveLocalFile(req, pageFile.path, {
            contentType: pageFile.contentType,
            cacheControl: "no-cache",
          });
        } catch (error) {
          return pageStreamingErrorResponse(error);
        }
      },
      HEAD: async (req) => {
        try {
          const id = parseBookId(req.params.id);
          const page = Number.parseInt(req.params.page, 10);
          if (id === null || !Number.isFinite(page)) {
            return Response.json({ error: "Invalid page request" }, { status: 400 });
          }
          if (!FORMAT_PATTERN.test(req.params.format)) {
            return Response.json({ error: "Invalid format" }, { status: 400 });
          }

          const pageFile = await getPageFile(id, req.params.format, page);
          return serveLocalFile(req, pageFile.path, {
            contentType: pageFile.contentType,
            cacheControl: "no-cache",
          });
        } catch (error) {
          return pageStreamingErrorResponse(error);
        }
      },
    },

    // Get cover (full size)
    "/api/books/:id/cover": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const coverPath = getBookCoverPath(id);
          if (!coverPath) {
            return Response.json({ error: "Cover not found" }, { status: 404 });
          }

          const file = Bun.file(coverPath);
          if (!(await file.exists())) {
            return Response.json({ error: "Cover file not found" }, { status: 404 });
          }

          const fileStat = await file.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, {
              status: 304,
              headers: {
                ETag: etag,
                "Cache-Control": "public, max-age=604800, immutable",
              },
            });
          }

          return new Response(file, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error getting cover:", error);
          return Response.json({ error: "Failed to get cover" }, { status: 500 });
        }
      },
    },

    // Get cover thumbnail (resized for list/grid views)
    "/api/books/:id/thumb": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          // Check thumbnail cache first
          const thumbDir = join(WORK_DIR, "thumbs");
          const thumbPath = join(thumbDir, `${id}.jpg`);
          const thumbFile = Bun.file(thumbPath);

          if (await thumbFile.exists()) {
            const ifNoneMatch = req.headers.get("If-None-Match");
            const stat = await thumbFile.stat();
            const etag = `"t${stat.size}-${stat.mtime?.getTime() || 0}"`;
            if (ifNoneMatch === etag) {
              return new Response(null, {
                status: 304,
                headers: {
                  ETag: etag,
                  "Cache-Control": "public, max-age=604800, immutable",
                },
              });
            }
            return new Response(thumbFile, {
              headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=604800, immutable",
                ETag: etag,
              },
            });
          }

          // Generate thumbnail
          const coverPath = getBookCoverPath(id);
          if (!coverPath) {
            return Response.json({ error: "Cover not found" }, { status: 404 });
          }

          const coverFile = Bun.file(coverPath);
          if (!(await coverFile.exists())) {
            return Response.json({ error: "Cover file not found" }, { status: 404 });
          }

          // Use sharp-like resize if available, otherwise serve original with size hint
          // For now, serve the original with aggressive caching — the browser will cache it
          const fileStat = await coverFile.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, {
              status: 304,
              headers: {
                ETag: etag,
                "Cache-Control": "public, max-age=604800, immutable",
              },
            });
          }

          return new Response(coverFile, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error getting thumb:", error);
          return Response.json({ error: "Failed to get thumbnail" }, { status: 500 });
        }
      },
    },

    // Serve PDF.js worker
    "/pdfjs/pdf.worker.min.mjs": {
      GET: async () => {
        const workerPath = join(
          import.meta.dir,
          "..",
          "node_modules",
          "pdfjs-dist",
          "build",
          "pdf.worker.min.mjs",
        );
        const file = Bun.file(workerPath);
        return new Response(file, {
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
          },
        });
      },
    },

    // MCP endpoint for AI tool integration
    "/mcp": {
      POST: async (req) => {
        try {
          const result = await handleMCPRequest(req);
          return result;
        } catch (error) {
          console.error("MCP error:", error);
          return Response.json({ error: "MCP request failed" }, { status: 500 });
        }
      },
    },

    // Serve index.html for all unmatched routes
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
console.log(`📚 Library: ${LIBRARY_PATH}`);
