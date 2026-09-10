import { serve } from "bun";
import index from "./index.html";
import {
  listBooksCursor,
  searchBooksCursor,
  listAuthorsCursor,
  listSeriesCursor,
  listTagsCursor,
  listAllTags,
  listAllFormats,
  listFormatsCursor,
  listBooksByAuthorCursor,
  listBooksBySeriesCursor,
  listBooksByTagCursor,
  listBooksByFormatCursor,
  getCatalogEntry,
  getBookByIdOptimized,
  getBooksByIdsOptimized,
  getLibraryStats,
  getBookCount,
  getSnapshotRevision,
  getSnapshotUpdated,
  getSnapshotStatus,
  acquireSnapshotLease,
  streamBooks,
  getLibraryPath,
  getBookFormatPath,
  getBookCoverPath,
  getBookTitle,
  initFTS,
  onDbRefresh,
  CursorError,
  reconfigureLibraryDatabase,
  type BookListItem,
  type CatalogEntry,
  type CursorPaginatedResult,
} from "./lib/calibre-optimized";
import {
  OPDS_ACQUISITION_TYPE,
  OPDS_ENTRY_TYPE,
  OPDS_NAVIGATION_TYPE,
  OPENSEARCH_TYPE,
  getRequestPrefix,
  renderAcquisitionFeed,
  renderBookCompleteEntry,
  renderCatalogFeed,
  renderNavigationFeed,
  renderOpenSearchDescription,
  renderSingleBookFeed,
} from "./lib/opds";
import {
  canReadInBrowser,
  getFormatContentType,
  getPathContentType,
  getSafeBookFilename,
} from "./lib/book-files";
import { EpubCacheError, getEpubEntryPath } from "./lib/epub-cache";
import { getPageFile, getPageManifest, PageStreamingError } from "./lib/page-streaming";
import { handleMCPRequest } from "./mcp";
import {
  getOrCreateUser,
  getUserByUsername,
  isValidUsername,
  getProgress,
  getProgressDeletion,
  getLibraryDeletion,
  listProgress,
  listProgressFormats,
  upsertProgress,
  deleteProgress,
  clearProgress,
  countUsersWithPassword,
  deleteUser,
  getCredentialByUsername,
  listAuthUsers,
  type User,
} from "./lib/user-db";
import { join } from "node:path";
import {
  AUTH_ENABLED,
  AUTH_ENV_CONTROLLED,
  AuthConfigError,
  CONFIG_DIR_PATH,
  COOKIE_SECURE,
  HOST,
  getCanonicalLibraryId,
  getLibraryConfigStatus,
  LibraryConfigError,
  MCP_ENABLED,
  PORT,
  PUBLIC_BASE_URL,
  saveLibraryConfig,
  setAuthEnabled,
  TRUST_PROXY,
} from "./lib/config";
import {
  authenticateRequest,
  authenticateWithPassword,
  createSessionToken,
  isValidPassword,
  loginRateLimited,
  needsInitialSetup,
  PasswordError,
  purgeExpiredSessions,
  revokeSessionToken,
  sessionCookieHeader,
  sessionTokenFromRequest,
  setRequestUser,
  setPasswordForUser,
  MIN_PASSWORD_LENGTH,
} from "./lib/auth";

const LIBRARY_PATH = getLibraryPath();
const WORK_DIR = CONFIG_DIR_PATH;
const DEFAULT_PORT = 3003;
const MAX_QUERY_LIMIT = 100;
const MAX_STREAM_BATCH_SIZE = 5000;
const LOCAL_SETUP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SORT_FIELDS = ["title", "author", "added", "rating", "series_index"] as const;
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
  const raw = value?.trim() ?? "";
  if (!/^-?\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
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
    if (!/^\d+$/.test(value)) continue;
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) {
      ids.add(id);
      if (ids.size >= MAX_TAG_FILTERS) break;
    }
  }
  return Array.from(ids);
}

// Parse repeated `format` query params into deduped, uppercased format names
// (OR logic). Calibre stores `data.format` uppercase; values are validated
// to alphanumerics so they are safe to bind and cache-key.
const MAX_FORMAT_FILTERS = 20;
function parseFormats(url: URL): string[] {
  const raw = url.searchParams.getAll("format");
  if (raw.length === 0) return [];
  const formats = new Set<string>();
  for (const value of raw) {
    const normalized = value.trim().toUpperCase();
    if (/^[A-Z0-9]{1,10}$/.test(normalized)) {
      formats.add(normalized);
      if (formats.size >= MAX_FORMAT_FILTERS) break;
    }
  }
  return Array.from(formats);
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
    if (name) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookie values instead of failing the whole request.
      }
    }
  }
  return out;
}

function userCookieHeader(username: string | null): string {
  const base = `${USER_COOKIE}=`;
  const attrs = `Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE ? "; Secure" : ""}`;
  if (username === null) {
    return `${base}; ${attrs}; Max-Age=0`;
  }
  return `${base}${encodeURIComponent(username)}; ${attrs}; Max-Age=${USER_COOKIE_MAX_AGE}`;
}

// Resolve the current user. With auth enabled this is a real
// authenticated identity (session cookie or Basic credentials). Without
// auth, the cookie just remembers a username for reading progress.
async function currentUser(req: Request): Promise<User | null> {
  if (AUTH_ENABLED) {
    const authenticated = await authenticateRequest(req);
    return authenticated?.user ?? null;
  }
  const username = parseCookies(req)[USER_COOKIE];
  if (!username) return null;
  return getUserByUsername(username);
}

function publicUser(user: User) {
  return { id: user.id, username: user.username };
}

// FUP1: server-authoritative library context for reading progress. The
// library id is derived from the server's configured LIBRARY_PATH (or an
// explicit CALIBER_LIBRARY_ID override) and NEVER taken from client input —
// progress rows are always scoped to the library the server is serving.
function resolveLibraryId(_req?: Request): string {
  return getCanonicalLibraryId();
}

// Optional ?format= query for per-format progress reads/deletes. Returns
// undefined when absent, null when present-but-invalid.
function parseFormatQuery(value: string | null): string | undefined | null {
  if (value === null) return undefined;
  const format = value.trim().toUpperCase();
  if (!FORMAT_PATTERN.test(format)) return null;
  return format;
}

// S2/S3: shared progress-write handler. Catalog context (resolved libraryId
// + book existence) is captured BEFORE the body is awaited; the body is then
// validated for identity match (expected user/library vs authenticated user +
// resolved library) before any write. All responses carry server_seq.
function expectedIdentityFromBody(body: Record<string, unknown>): {
  userId: number | null;
  libraryId: string | null;
} {
  const rawUser = body.expectedUserId ?? body.userId;
  const rawLib = body.expectedLibraryId ?? body.libraryId;
  return {
    userId: typeof rawUser === "number" && Number.isInteger(rawUser) ? rawUser : null,
    libraryId: typeof rawLib === "string" && rawLib ? rawLib : null,
  };
}

async function handleProgressWrite(
  req: Request,
  bookId: number,
  user: User,
  libraryId: string,
  book: { formats: string[] },
): Promise<Response> {
  const rawBody = await readJsonBodyOr400(req);
  if (rawBody instanceof Response) return rawBody;
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return Response.json({ error: "Request body must be an object" }, { status: 400 });
  }
  const body = rawBody as {
    format?: unknown;
    location?: unknown;
    percentage?: unknown;
    finished?: unknown;
    mutationId?: unknown;
    clientTs?: unknown;
    baseRevision?: unknown;
    baseDeletionSeq?: unknown;
    force?: unknown;
    forceResurrect?: unknown;
  } & Record<string, unknown>;
  // S3: identity enforcement — a claimed principal/library that disagrees
  // with the authenticated user / resolved library is rejected with no write.
  const expected = expectedIdentityFromBody(body);
  if (expected.userId !== null && expected.userId !== user.id) {
    return Response.json({ error: "Principal mismatch" }, { status: 401 });
  }
  if (expected.libraryId !== null && expected.libraryId !== libraryId) {
    return Response.json({ error: "Library mismatch" }, { status: 409 });
  }
  const format = typeof body.format === "string" ? body.format.trim().toUpperCase() : "";
  if (!FORMAT_PATTERN.test(format) || !book.formats.includes(format)) {
    return Response.json({ error: "Invalid book format" }, { status: 400 });
  }
  const result = upsertProgress(user.id, libraryId, bookId, {
    format,
    location: typeof body.location === "string" ? body.location : null,
    percentage: typeof body.percentage === "number" ? body.percentage : 0,
    finished: body.finished === true,
    mutationId: typeof body.mutationId === "string" ? body.mutationId : null,
    clientTs: typeof body.clientTs === "number" ? body.clientTs : null,
    baseRevision: typeof body.baseRevision === "number" ? body.baseRevision : null,
    // T5 deletion generation: stale/absent baseDeletionSeq after a DELETE or
    // clear is rejected with applied:false reason:"deleted" (no resurrect).
    // A fresh seq (from GET deletion info) or force:true (explicit
    // user-confirmed re-read) resurrects.
    baseDeletionSeq: typeof body.baseDeletionSeq === "number" ? body.baseDeletionSeq : null,
    force: body.force === true || body.forceResurrect === true,
  });
  // Always report the current deletion generation so writers can rebase and
  // resurrect intentionally with a fresh baseDeletionSeq.
  const deletion = getProgressDeletion(user.id, libraryId, bookId, format);
  return Response.json(
    {
      progress: result.progress,
      applied: result.applied,
      reason: result.reason,
      serverSeq: result.progress?.serverSeq ?? null,
      deletionSeq: deletion.seq,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

// Auth administration (toggle, accounts) is a local-operator action.
// Trust model: when auth is enabled, ALL authenticated users are trusted as
// operators (there is no separate admin role). Set CALIBER_ADMIN_RESTRICTED=1
// to disable this all-users-trusted default and deny management even to
// signed-in users (loopback operators only). When auth is disabled, management
// is denied unless the server is bound to loopback AND the operator explicitly
// opts in with CALIBER_ALLOW_NOAUTH_ADMIN=1.
const ALLOW_ALL_USERS_AS_ADMINS = process.env.CALIBER_ADMIN_RESTRICTED !== "1";
async function canManageAuth(req: Request): Promise<boolean> {
  if (!AUTH_ENABLED) {
    if (!LOCAL_SETUP_HOSTS.has(HOST.toLowerCase())) return false;
    if (process.env.CALIBER_ALLOW_NOAUTH_ADMIN !== "1") return false;
    return true;
  }
  if (LOCAL_SETUP_HOSTS.has(HOST.toLowerCase())) return true;
  if (!ALLOW_ALL_USERS_AS_ADMINS) return false;
  return (await currentUser(req)) !== null;
}

// Serializes first-run setup so concurrent POSTs cannot both pass the
// needsInitialSetup check and create duplicate bootstrap accounts.
let setupMutex: Promise<void> = Promise.resolve();

// Initialize FTS on startup. A missing default library should leave the UI
// reachable so the local operator can select a different database in Settings.
let libraryReady = initFTS();
onDbRefresh(() => {
  libraryReady = true;
  apiCache.clear();
});

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

// Authenticated responses must never be served from shared caches: any
// request carrying an Authorization header or a session cookie gets a
// private (or no-store, for per-user endpoints) Cache-Control, including on
// 304s. Only anonymous-public responses get public.
function requestLooksAuthenticated(req: Request): boolean {
  if (req.headers.get("Authorization")) return true;
  const cookie = req.headers.get("Cookie");
  return cookie !== null && /(?:^|;\s*)(?:caliber-session|caliber-user)=/.test(cookie);
}

function cacheControlFor(req: Request, isSensitive = false): string {
  if (isSensitive || requestLooksAuthenticated(req)) {
    return isSensitive ? "private, no-store" : "private, max-age=60";
  }
  return "public, max-age=60";
}

function coverCacheControlFor(req: Request): string {
  if (requestLooksAuthenticated(req)) return "private, max-age=60, must-revalidate";
  return "public, max-age=300, must-revalidate";
}

// Shared-cache key: includes the snapshot revision (normalized params are
// already part of `base` at each call site) so a DB refresh invalidates
// stale list/detail/OPDS entries. Auth is kept separate from the shared
// cache: authenticated requests get a private namespace and never
// read/populate anonymous entries.
function sharedCacheKey(base: string, req: Request): string {
  const revision = getSnapshotRevision();
  if (requestLooksAuthenticated(req)) {
    return `auth-private:rev${revision}:${base}`;
  }
  return `shared:rev${revision}:${base}`;
}

function getCachedResponse(
  cacheKey: string,
  dataOrProducer: unknown | (() => unknown),
  req: Request,
): Response {
  const key = sharedCacheKey(cacheKey, req);
  const now = Date.now();
  const cached = apiCache.get(key);
  const cacheControl = cacheControlFor(req);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === cached.etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: cached.etag, "Cache-Control": cacheControl },
      });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControl,
        ETag: cached.etag,
      },
    });
  }

  // Lazy producer: the DB query only runs on a cache miss. A producer may
  // return a Response to bypass the cache (e.g. 404s, which must not be stored).
  const data =
    typeof dataOrProducer === "function" ? (dataOrProducer as () => unknown)() : dataOrProducer;
  if (data instanceof Response) return data;

  const jsonData = JSON.stringify(data);
  const etag = generateETag(jsonData);

  apiCache.set(key, { data: jsonData, etag, timestamp: now });

  return new Response(jsonData, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}

function getCachedTextResponse(
  cacheKey: string,
  dataOrProducer: string | (() => string | Response),
  req: Request,
  contentType: string,
  cacheControl: string = "public, max-age=60",
): Response {
  const key = sharedCacheKey(cacheKey, req);
  const now = Date.now();
  const cached = apiCache.get(key);
  // Sensitive callers pass no-store explicitly; otherwise derive from auth.
  const effectiveControl = cacheControl.includes("no-store") ? cacheControl : cacheControlFor(req);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === cached.etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: cached.etag, "Cache-Control": effectiveControl },
      });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": effectiveControl,
        ETag: cached.etag,
      },
    });
  }

  const data = typeof dataOrProducer === "function" ? dataOrProducer() : dataOrProducer;
  if (data instanceof Response) return data;

  const etag = generateETag(data);
  apiCache.set(key, { data, etag, timestamp: now });

  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": effectiveControl,
      ETag: etag,
    },
  });
}

function getPublicBaseUrl(req: Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const url = new URL(req.url);
  const forwardedProto = TRUST_PROXY
    ? req.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim()
    : undefined;
  const forwardedHost = TRUST_PROXY
    ? req.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim()
    : undefined;
  const host = forwardedHost || req.headers.get("Host") || url.host;
  const protocol = forwardedProto || url.protocol.replace(":", "");

  return `${protocol}://${host}`;
}

function getRequestPath(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}

// F24: deployment path prefix shared with OPDS absoluteUrl (X-Forwarded-Prefix
// when behind a trusted proxy, else BASE_PATH). Threaded into every feed
// render so entry hrefs keep working under a sub-path mount.
function opdsPathPrefix(req: Request): string {
  return getRequestPrefix(req, TRUST_PROXY);
}

// F22: catalog/nav feed instant is the published snapshot's mtime (stable
// across renders of unchanged state, invalidated by the revision-scoped cache
// keys on refresh). Only acquisition feeds use max(last_modified), via
// acquisitionFeedUpdated() with this value as the empty-feed fallback.
function opdsCatalogUpdated(): string {
  return getSnapshotUpdated();
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
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Mirrors the 1MB stdio MCP frame limit in mcp-server.ts so both transports
// accept the same maximum JSON-RPC payload.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

async function readJsonBodyOr400(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await req.text()) as unknown;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

function opdsCatalogResponse(
  req: Request,
  title: string,
  basePath: string,
  queryOrResult: CursorPaginatedResult<CatalogEntry> | (() => CursorPaginatedResult<CatalogEntry>),
  entryHref: (entry: CatalogEntry) => string,
): Response {
  const { limit } = parseOpdsCatalogParams(req);
  const baseUrl = getPublicBaseUrl(req);
  const selfPath = getRequestPath(req);
  const pathPrefix = opdsPathPrefix(req);

  // Lazy: the catalog query + feed render only run on a cache miss.
  return getCachedTextResponse(
    `opds:catalog:${baseUrl}:${pathPrefix}:${selfPath}`,
    () => {
      const result = typeof queryOrResult === "function" ? queryOrResult() : queryOrResult;
      const nextPath = result.nextCursor
        ? buildPath(basePath, { cursor: result.nextCursor, limit })
        : undefined;
      return renderCatalogFeed({
        baseUrl,
        pathPrefix,
        selfPath,
        title,
        id: new URL(selfPath, baseUrl).toString(),
        updated: opdsCatalogUpdated(),
        result,
        nextPath,
        entryHref,
      });
    },
    req,
    `${OPDS_NAVIGATION_TYPE}; charset=utf-8`,
  );
}

function opdsAcquisitionResponse(
  req: Request,
  title: string,
  basePath: string,
  queryOrResult: CursorPaginatedResult<BookListItem> | (() => CursorPaginatedResult<BookListItem>),
  options?: { sortBy?: SortField; sortOrder?: SortOrder; noStore?: boolean },
): Response {
  const params = parseOpdsPageParams(req);
  const sortBy = options?.sortBy ?? params.sortBy;
  const sortOrder = options?.sortOrder ?? params.sortOrder;
  const baseUrl = getPublicBaseUrl(req);
  const selfPath = getRequestPath(req);
  const pathPrefix = opdsPathPrefix(req);

  const renderFeed = (result: CursorPaginatedResult<BookListItem>): string => {
    const nextPath = result.nextCursor
      ? buildPath(basePath, {
          cursor: result.nextCursor,
          limit: params.limit,
          sortBy,
          sortOrder,
        })
      : undefined;
    return renderAcquisitionFeed({
      baseUrl,
      pathPrefix,
      selfPath,
      title,
      id: new URL(selfPath, baseUrl).toString(),
      updated: opdsCatalogUpdated(),
      result,
      nextPath,
    });
  };

  if (options?.noStore) {
    const result = typeof queryOrResult === "function" ? queryOrResult() : queryOrResult;
    return new Response(renderFeed(result), {
      headers: {
        "Content-Type": `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Lazy: the book query + feed render only run on a cache miss.
  return getCachedTextResponse(
    `opds:acquisition:${baseUrl}:${pathPrefix}:${selfPath}`,
    () => {
      const result = typeof queryOrResult === "function" ? queryOrResult() : queryOrResult;
      return renderFeed(result);
    },
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
    if (!/^\d+$/.test(endPart)) return null;
    const suffixLength = Number(endPart);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;

    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  if (!/^\d+$/.test(startPart) || (endPart !== "" && !/^\d+$/.test(endPart))) {
    return null;
  }
  const start = Number(startPart);
  const end = endPart === "" ? size - 1 : Number(endPart);

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
    contentSecurityPolicy?: string;
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
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  });
  if (lastModified) baseHeaders.set("Last-Modified", lastModified);
  if (options.contentDisposition) {
    baseHeaders.set("Content-Disposition", options.contentDisposition);
  }
  if (options.contentSecurityPolicy) {
    baseHeaders.set("Content-Security-Policy", options.contentSecurityPolicy);
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

  // Bun.serve auto-slices any BunFile body when the request carries a Range
  // header — ignoring If-Range entirely. When the range was denied (stale
  // If-Range), buffer the body so the runtime cannot re-slice it into a 206.
  // This path only triggers on Range + failed If-Range, so the extra copy
  // stays off the hot path.
  const rangeDenied =
    Boolean(rangeHeader) && !ifRangeAllowsRange(req.headers.get("If-Range"), etag, mtimeMs);
  const body = !includeBody ? null : rangeDenied ? await file.arrayBuffer() : file;
  return new Response(body, { headers: baseHeaders });
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
  const effectiveDisposition =
    disposition === "inline" && !canReadInBrowser(format) ? "attachment" : disposition;

  return serveLocalFile(req, filePath, {
    contentType,
    contentDisposition: contentDisposition(effectiveDisposition, filename),
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
    contentSecurityPolicy:
      "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;",
  });
}

function routeErrorResponse(error: unknown, logLabel: string, message: string): Response {
  if (error instanceof CursorError) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }
  console.error(logLabel, error);
  return Response.json({ error: message }, { status: 500 });
}

// F24: shared artwork handlers behind both /api and the challenge-capable
// /opds file routes so OPDS clients use the same bytes and validators.
async function serveCoverById(req: Request, id: number): Promise<Response> {
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
        "Cache-Control": coverCacheControlFor(req),
      },
    });
  }

  return new Response(file, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": coverCacheControlFor(req),
      ETag: etag,
    },
  });
}

async function serveThumbById(req: Request, id: number): Promise<Response> {
  const url = new URL(req.url);
  const size = parseThumbSize(url.searchParams.get("size"));

  const coverPath = getBookCoverPath(id);
  if (!coverPath) {
    return Response.json({ error: "Cover not found" }, { status: 404 });
  }

  const coverFile = Bun.file(coverPath);
  if (!(await coverFile.exists())) {
    return Response.json({ error: "Cover file not found" }, { status: 404 });
  }

  // Revision key over (library, cover size, cover mtime).
  const fileStat = await coverFile.stat();
  const mtimeMs = fileStat.mtime?.getTime() || 0;
  const sig = Bun.hash(`${LIBRARY_PATH}:${fileStat.size}:${mtimeMs}`).toString(36);
  const etag = `"t${size}-${sig}"`;
  const cacheControl = coverCacheControlFor(req);

  const ifNoneMatch = req.headers.get("If-None-Match");
  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  const thumbDir = join(WORK_DIR, "thumbs");
  const thumbPath = join(thumbDir, `${id}-${size}-${sig}.jpg`);
  const thumbFile = Bun.file(thumbPath);

  if (!(await thumbFile.exists())) {
    let resizeUnavailable = false;
    await runThumbJob(async () => {
      if (await thumbFile.exists()) return;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(thumbDir, { recursive: true });
      const original = new Uint8Array(await coverFile.arrayBuffer());
      const resized = await tryResizeImage(original, THUMB_SIZES[size]);
      if (!resized) {
        resizeUnavailable = true;
        return;
      }
      await Bun.write(thumbPath, resized);
    });
    if (resizeUnavailable && !(await thumbFile.exists())) {
      // Resize pipeline unavailable (e.g. Bun without image support):
      // degrade to the original cover bytes with a 200 + marker header so
      // <img> clients keep working. 501 is reserved for the case where no
      // cover bytes exist at all (already 404'd above, or unreadable here).
      try {
        const originalBytes = new Uint8Array(await coverFile.arrayBuffer());
        if (!originalBytes || originalBytes.byteLength === 0) {
          return Response.json({ error: "thumbnail resize unavailable" }, { status: 501 });
        }
      } catch {
        return Response.json({ error: "thumbnail resize unavailable" }, { status: 501 });
      }
      if (!thumbDegradedLogged) {
        thumbDegradedLogged = true;
        console.warn(
          `[thumb] serving original cover for book ${id} (resize-unavailable, Bun ${Bun.version})`,
        );
      }
      return new Response(coverFile, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": cacheControl,
          ETag: etag,
          "X-Thumbnail-Degraded": "resize-unavailable",
        },
      });
    }
  }

  if (!(await thumbFile.exists())) {
    return Response.json({ error: "Failed to get thumbnail" }, { status: 500 });
  }
  return new Response(thumbFile, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
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
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }

  console.error("Error serving EPUB entry:", error);
  return Response.json({ error: "Failed to serve EPUB entry" }, { status: 500 });
}

const streamEncoder = new TextEncoder();

// --- Cover thumbnails (F17) ------------------------------------------------
// ?size=small (default, 256px wide) or ?size=medium (512px wide). Thumbnails
// are cached on disk as {id}-{size}-{sig}.jpg where sig is a revision key
// over (library path, cover size, cover mtime), so a changed cover naturally
// misses the old file. Resize uses Bun's built-in image pipeline when present
// (PRIMARY: file-backed Bun.file(tmp).image(), FALLBACK: new Bun.Image(bytes),
// each trying positional then object resize signatures for 1.3.x/1.4.x);
// when the pipeline is unavailable the endpoint degrades to the original
// cover bytes with a 200 + `X-Thumbnail-Degraded: resize-unavailable` header
// so <img> clients keep working (501 is reserved for no cover bytes at all).
// Generations run through a FIFO queue with max 2 concurrent jobs.
const THUMB_SIZES = { small: 256, medium: 512 } as const;
type ThumbSize = keyof typeof THUMB_SIZES;

function parseThumbSize(value: string | null): ThumbSize {
  return value === "medium" ? "medium" : "small";
}

const THUMB_MAX_CONCURRENT = 2;
let thumbActiveJobs = 0;
const thumbWaitQueue: Array<() => void> = [];
let thumbDegradedLogged = false;

function runThumbJob<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      thumbActiveJobs += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          thumbActiveJobs -= 1;
          const next = thumbWaitQueue.shift();
          if (next) next();
        });
    };
    if (thumbActiveJobs < THUMB_MAX_CONCURRENT) run();
    else thumbWaitQueue.push(run);
  });
}

// Bun's image pipeline is present in recent runtimes but absent from the
// pinned @types/bun, so it is detected structurally: missing pieces mean
// "unavailable" (the caller returns 501), never a crash.
interface BunImageEncoder {
  bytes(): Promise<Uint8Array>;
}
interface BunImageInstance {
  resize(width: number): { jpeg(): BunImageEncoder };
  resize(options: { width?: number; w?: number }): { jpeg(): BunImageEncoder };
  jpeg(): BunImageEncoder;
}
interface BunWithImagePipeline {
  Image?: new (input: Uint8Array) => BunImageInstance;
}
interface BunFileWithImagePipeline {
  image?: () => Promise<BunImageInstance>;
}

// Try every known resize signature against one live image instance.
// 1.4.x uses positional resize(width[, height[, options]]); some 1.3.x builds
// accept an object ({ width } / { w }). Each attempt chains .jpeg().bytes()
// immediately so a shape mismatch throws before any bytes are produced.
async function encodeResizedImage(
  image: BunImageInstance,
  targetWidth: number,
  pathLabel: string,
): Promise<Uint8Array | null> {
  const attempts: Array<{ label: string; run: () => { jpeg(): BunImageEncoder } }> = [
    {
      label: "resize(width)",
      run: () => (image.resize as (w: number) => { jpeg(): BunImageEncoder })(targetWidth),
    },
    {
      label: "resize({width})",
      run: () => image.resize({ width: targetWidth }),
    },
    { label: "resize({w})", run: () => image.resize({ w: targetWidth }) },
  ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const encoded = attempt.run().jpeg();
      if (!encoded || typeof encoded.bytes !== "function") continue;
      const out = await encoded.bytes();
      if (out && out.byteLength > 0) return out;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(
    `[thumb] resize signatures exhausted (Bun ${Bun.version}, path ${pathLabel}, last: ${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
  return null;
}

// Resize via Bun's built-in image pipeline when available; null means
// "unavailable, caller serves the degraded original". The FILE-BACKED
// `Bun.file(tmp).image()` path is PRIMARY (it is the shape known to work
// across 1.3.x/1.4.x); the in-memory `new Bun.Image(bytes)` constructor is
// the fallback. Both paths try positional then object resize signatures to
// tolerate API shape differences across Bun versions. Failures are logged
// (message + runtime + attempted path) instead of swallowed.
// CALIBER_THUMB_DISABLE_RESIZE=1 forces null immediately so tests can
// deterministically exercise the degraded fallback without stubbing.
async function tryResizeImage(bytes: Uint8Array, targetWidth: number): Promise<Uint8Array | null> {
  if (process.env.CALIBER_THUMB_DISABLE_RESIZE === "1") {
    return null;
  }
  // PRIMARY: sharp (libvips prebuild, runs everywhere Bun runs, including CI).
  // The Bun image-pipeline probes below stay as fallback for sharp-less installs.
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(bytes)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .jpeg()
      .toBuffer();
    if (out && out.byteLength > 0) return out;
  } catch (error) {
    console.warn(
      `[thumb] sharp resize failed (Bun ${Bun.version}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // FALLBACK: file-backed pipeline.
  try {
    const probe = Bun.file("") as BunFileWithImagePipeline;
    if (typeof probe.image === "function") {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "caliber-thumb-"));
      try {
        const tmpPath = join(dir, "cover");
        await Bun.write(tmpPath, bytes);
        const fileImage = Bun.file(tmpPath) as BunFileWithImagePipeline;
        const image = await fileImage.image?.();
        if (!image) {
          console.warn(
            `[thumb] file-backed resize returned no image (Bun ${Bun.version}, path Bun.file().image)`,
          );
        } else {
          const out = await encodeResizedImage(image, targetWidth, "Bun.file().image");
          if (out && out.byteLength > 0) return out;
          console.warn(
            `[thumb] file-backed pipeline returned empty bytes (Bun ${Bun.version}, path Bun.file().image)`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      console.warn(
        `[thumb] file-backed image pipeline unavailable (Bun ${Bun.version}, path Bun.file().image)`,
      );
    }
  } catch (error) {
    console.warn(
      `[thumb] file-backed resize failed (Bun ${Bun.version}, path Bun.file().image): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // FALLBACK: in-memory constructor.
  try {
    const ImageCtor = (Bun as BunWithImagePipeline).Image;
    if (typeof ImageCtor !== "function") {
      console.warn(
        `[thumb] Bun.Image constructor unavailable (Bun ${Bun.version}, path Bun.Image)`,
      );
      return null;
    }
    const out = await encodeResizedImage(new ImageCtor(bytes), targetWidth, "Bun.Image");
    if (out && out.byteLength > 0) return out;
    console.warn(
      `[thumb] Bun.Image pipeline returned empty bytes (Bun ${Bun.version}, path Bun.Image)`,
    );
    return null;
  } catch (error) {
    console.warn(
      `[thumb] Bun.Image resize failed (Bun ${Bun.version}, path Bun.Image): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

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

type RouteHandler = (req: Bun.BunRequest<string>) => Response | Promise<Response>;
type RouteTable = Record<string, RouteHandler | { [method: string]: RouteHandler } | typeof index>;

const routes: RouteTable = {
  // Health check
  "/api/health": {
    GET: () => Response.json({ status: "ok", timestamp: Date.now() }),
  },

  // Local setup/configuration surface. The server binds to loopback by
  // default; deployments exposing it beyond the host should add auth.
  "/api/config/library": {
    GET: () => {
      const snapshot = getSnapshotStatus();
      return Response.json(
        {
          ...getLibraryConfigStatus(),
          // Canonical scope id (same value as resolveLibraryId); clients
          // send it back as expectedLibraryId. libraryPath stays display only.
          libraryId: resolveLibraryId(),
          ready: libraryReady,
          // Snapshot generation status (F15): stale while a refresh is
          // pending/deferred, refreshing during publish, failed with the
          // last publish error (null when healthy).
          stale: snapshot.stale,
          refreshing: snapshot.refreshing,
          failed: snapshot.failed,
          generation: snapshot.generation,
          revision: snapshot.revision,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
    PUT: async (req) => {
      if (!LOCAL_SETUP_HOSTS.has(HOST.toLowerCase())) {
        return Response.json(
          {
            error:
              "Library selection is available only when Caliber is bound to loopback; configure CALIBRE_LIBRARY_PATH instead",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const rawBody = await readJsonBodyOr400(req);
      if (rawBody instanceof Response) return rawBody;
      if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
        return Response.json({ error: "Request body must be an object" }, { status: 400 });
      }

      const body = rawBody as {
        databasePath?: unknown;
        libraryPath?: unknown;
        dbName?: unknown;
      };
      try {
        const status = saveLibraryConfig({
          databasePath: typeof body.databasePath === "string" ? body.databasePath : undefined,
          libraryPath: typeof body.libraryPath === "string" ? body.libraryPath : undefined,
          dbName: typeof body.dbName === "string" ? body.dbName : undefined,
        });
        reconfigureLibraryDatabase();
        libraryReady = true;
        apiCache.clear();
        return Response.json(
          { ...status, ready: libraryReady, applied: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof LibraryConfigError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        console.error("Error changing Calibre library:", error);
        return Response.json({ error: "Could not change the Calibre library" }, { status: 500 });
      }
    },
  },

  // Library stats
  "/api/stats": {
    GET: (req) => {
      return getCachedResponse("stats", () => getLibraryStats(), req);
    },
  },

  // --- Auth configuration & account management (Settings UI) ---

  // Auth status for the Settings panel. The account list is only included
  // for operators allowed to manage auth.
  "/api/config/auth": {
    GET: async (req) => {
      const canManage = await canManageAuth(req);
      return Response.json(
        {
          authEnabled: AUTH_ENABLED,
          hasAccounts: countUsersWithPassword() > 0,
          canManage,
          envControlled: AUTH_ENV_CONTROLLED,
          users: canManage
            ? listAuthUsers().map((user) => ({
                id: user.id,
                username: user.username,
                hasPassword: user.hasPassword,
              }))
            : undefined,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
    PUT: async (req) => {
      if (!(await canManageAuth(req))) {
        return Response.json(
          {
            error:
              "Authentication settings are available only when Caliber runs on loopback or while signed in",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      const rawBody = await readJsonBodyOr400(req);
      if (rawBody instanceof Response) return rawBody;
      if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
        return Response.json({ error: "Request body must be an object" }, { status: 400 });
      }
      const body = rawBody as { enabled?: unknown; username?: unknown; password?: unknown };
      if (typeof body.enabled !== "boolean") {
        return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
      }

      if (body.enabled === AUTH_ENABLED) {
        return Response.json(
          { authEnabled: AUTH_ENABLED, changed: false },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      // When turning auth on with no accounts yet, the operator creates the
      // first account in the same request and is signed in immediately.
      // Prepare-then-commit: the credential is validated with the shared
      // isValidPassword (min + max) and prepared BEFORE authEnabled is
      // persisted, so a weak/oversized password can never leave auth
      // enabled with no usable account.
      const needsAccount = body.enabled && countUsersWithPassword() === 0;
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (needsAccount && !isValidUsername(username)) {
        return Response.json({ error: "Invalid username" }, { status: 400 });
      }
      if (needsAccount && !isValidPassword(password)) {
        return Response.json(
          { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
          { status: 400 },
        );
      }

      let preparedUser: User | null = null;
      if (needsAccount) {
        try {
          preparedUser = await setPasswordForUser(username, password);
        } catch (error) {
          if (error instanceof PasswordError) {
            return Response.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      }

      try {
        setAuthEnabled(body.enabled);
      } catch (error) {
        if (error instanceof AuthConfigError) {
          return Response.json(
            { error: error.message },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          );
        }
        throw error;
      }

      if (preparedUser) {
        purgeExpiredSessions();
        const session = createSessionToken(preparedUser.id);
        return Response.json(
          { authEnabled: true, changed: true, user: publicUser(preparedUser) },
          {
            headers: {
              "Set-Cookie": sessionCookieHeader(session.token),
              "Cache-Control": "no-store",
            },
          },
        );
      }

      return Response.json(
        { authEnabled: AUTH_ENABLED, changed: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  },

  // Account administration for the Settings panel. Same operator rules as
  // the auth toggle above; the guard additionally requires a session
  // whenever auth is enabled.
  "/api/auth/users": {
    POST: async (req) => {
      if (!(await canManageAuth(req))) {
        return Response.json(
          { error: "Account management is available only on loopback or while signed in" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      const rawBody = await readJsonBodyOr400(req);
      if (rawBody instanceof Response) return rawBody;
      if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
        return Response.json({ error: "Request body must be an object" }, { status: 400 });
      }
      const body = rawBody as { username?: unknown; password?: unknown };
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!isValidUsername(username)) {
        return Response.json({ error: "Invalid username" }, { status: 400 });
      }
      if (!isValidPassword(password)) {
        return Response.json(
          { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
          { status: 400 },
        );
      }

      const existing = getCredentialByUsername(username);
      if (existing?.passwordHash) {
        return Response.json(
          { error: `${existing.username} already has a password` },
          { status: 409 },
        );
      }

      try {
        const user = await setPasswordForUser(username, password);
        return Response.json(
          { user: publicUser(user) },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof PasswordError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    },
  },

  "/api/auth/users/:username": {
    DELETE: async (req) => {
      if (!(await canManageAuth(req))) {
        return Response.json(
          { error: "Account management is available only on loopback or while signed in" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const username = decodeURIComponent(req.params.username ?? "");
      const target = getCredentialByUsername(username);
      if (!target) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      // Never delete the last account that can log in.
      if (target.passwordHash && countUsersWithPassword() <= 1) {
        return Response.json(
          { error: "Cannot delete the last user with a password" },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      const removed = deleteUser(username);
      if (!removed) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      return Response.json(
        { removed: removed.username },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  },

  "/api/auth/users/:username/password": {
    POST: async (req) => {
      if (!(await canManageAuth(req))) {
        return Response.json(
          { error: "Account management is available only on loopback or while signed in" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const username = decodeURIComponent(req.params.username ?? "");
      const target = getUserByUsername(username);
      if (!target) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const rawBody = await readJsonBodyOr400(req);
      if (rawBody instanceof Response) return rawBody;
      if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
        return Response.json({ error: "Request body must be an object" }, { status: 400 });
      }
      const body = rawBody as { password?: unknown };
      const password = typeof body.password === "string" ? body.password : "";
      if (!isValidPassword(password)) {
        return Response.json(
          { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
          { status: 400 },
        );
      }

      try {
        const user = await setPasswordForUser(target.username, password);
        return Response.json(
          { user: publicUser(user) },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof PasswordError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    },
  },

  // All tags with book counts (for the tag filter UI)
  "/api/tags": {
    GET: (req) => {
      return getCachedResponse("tags", () => listAllTags(), req);
    },
  },

  // All formats with book counts (for the format filter UI)
  "/api/formats": {
    GET: (req) => {
      return getCachedResponse("formats", () => listAllFormats(), req);
    },
  },

  // Book count (lightweight)
  "/api/books/count": {
    GET: (req) => {
      return getCachedResponse("count", () => ({ count: getBookCount() }), req);
    },
  },

  // --- Users & reading progress (local profile cookie, not authentication) ---

  // Who am I? (reads the cookie or session). Public so the SPA can render
  // a login screen when auth is enabled.
  "/api/user/me": {
    GET: async (req) => {
      const user = await currentUser(req);
      return Response.json(
        {
          user: user ? publicUser(user) : null,
          authRequired: AUTH_ENABLED,
          needsSetup: needsInitialSetup(),
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
  },

  // Log in. With auth enabled this verifies a password and starts a
  // server-side session; without auth it just remembers a username for
  // reading progress.
  "/api/user/login": {
    POST: async (req) => {
      const rawBody = await readJsonBodyOr400(req);
      if (rawBody instanceof Response) return rawBody;
      if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
        return Response.json({ error: "Request body must be an object" }, { status: 400 });
      }
      const body = rawBody as { username?: unknown; password?: unknown };
      const username = typeof body.username === "string" ? body.username : "";
      if (!isValidUsername(username)) {
        return Response.json({ error: "Invalid username" }, { status: 400 });
      }

      if (AUTH_ENABLED) {
        const password = typeof body.password === "string" ? body.password : "";
        if (loginRateLimited(req, username)) {
          return Response.json(
            { error: "Too many failed attempts; try again later" },
            { status: 429, headers: { "Cache-Control": "no-store" } },
          );
        }
        const user = await authenticateWithPassword(req, username, password);
        if (!user) {
          return Response.json(
            { error: "Invalid username or password" },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          );
        }
        purgeExpiredSessions();
        const session = createSessionToken(user.id);
        return Response.json(
          { user: publicUser(user) },
          {
            headers: {
              "Set-Cookie": sessionCookieHeader(session.token),
              "Cache-Control": "private, no-store",
            },
          },
        );
      }

      const user = getOrCreateUser(username);
      if (!user) {
        return Response.json({ error: "Could not create user" }, { status: 500 });
      }
      return Response.json(
        { user: publicUser(user) },
        {
          headers: {
            "Set-Cookie": userCookieHeader(user.username),
            "Cache-Control": "private, no-store",
          },
        },
      );
    },
  },

  // First-run account creation: allowed only while auth is enabled and no
  // user can log in yet, so an exposed instance cannot be claimed later.
  "/api/auth/setup": {
    POST: async (req) => {
      // Serialize bootstrap: recheck inside the mutex so concurrent
      // requests cannot both create the first account.
      const previous = setupMutex;
      let release!: () => void;
      setupMutex = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (!AUTH_ENABLED) {
          return Response.json(
            { error: "Authentication is disabled" },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }
        if (!needsInitialSetup()) {
          return Response.json(
            {
              error:
                "Setup is already complete; ask an existing user or use the CLI to add accounts",
            },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }

        const rawBody = await readJsonBodyOr400(req);
        if (rawBody instanceof Response) return rawBody;
        if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
          return Response.json({ error: "Request body must be an object" }, { status: 400 });
        }
        const body = rawBody as { username?: unknown; password?: unknown };
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!isValidUsername(username)) {
          return Response.json({ error: "Invalid username" }, { status: 400 });
        }
        if (!isValidPassword(password)) {
          return Response.json(
            { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
            { status: 400 },
          );
        }
        if (loginRateLimited(req, username)) {
          return Response.json(
            { error: "Too many failed attempts; try again later" },
            { status: 429, headers: { "Cache-Control": "no-store" } },
          );
        }

        // Recheck after validation: another request may have completed setup
        // while this one was awaiting the mutex or hashing inputs.
        if (!needsInitialSetup()) {
          return Response.json(
            {
              error:
                "Setup is already complete; ask an existing user or use the CLI to add accounts",
            },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }

        try {
          const user = await setPasswordForUser(username, password);
          const session = createSessionToken(user.id);
          return Response.json(
            { user: publicUser(user) },
            {
              headers: {
                "Set-Cookie": sessionCookieHeader(session.token),
                "Cache-Control": "private, no-store",
              },
            },
          );
        } catch (error) {
          if (error instanceof PasswordError) {
            return Response.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      } finally {
        release();
      }
    },
  },

  // Forget the current user (clear cookie / revoke session)
  "/api/user/logout": {
    POST: (req) => {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (AUTH_ENABLED) {
        revokeSessionToken(sessionTokenFromRequest(req));
        headers.append("Set-Cookie", sessionCookieHeader(null));
      }
      headers.append("Set-Cookie", userCookieHeader(null));
      return Response.json({ ok: true }, { headers });
    },
  },

  // Recently-read shelf: progress rows enriched with book metadata for cards.
  "/api/user/reading": {
    DELETE: async (req) => {
      const user = await currentUser(req);
      if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
      const libraryId = resolveLibraryId(req);
      const removed = clearProgress(user.id, libraryId);
      return Response.json(
        { removed, deletionSeq: getLibraryDeletion(user.id, libraryId).seq },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
    GET: async (req) => {
      const user = await currentUser(req);
      if (!user) return Response.json({ items: [] });
      const url = new URL(req.url);
      const limit = parseBoundedInt(url.searchParams.get("limit"), 200, { min: 1, max: 500 });
      const libraryId = resolveLibraryId(req);
      const rows = listProgress(user.id, libraryId, limit);
      // Per-format rows collapse to one shelf item per book: finished
      // wins, then furthest progress, then most recent. Enrichment reads
      // the same server library, so foreign-library rows never resolve.
      const bestByBook = new Map<number, (typeof rows)[number]>();
      for (const row of rows) {
        const prev = bestByBook.get(row.bookId);
        if (
          !prev ||
          Number(row.finished) > Number(prev.finished) ||
          (Number(row.finished) === Number(prev.finished) &&
            (row.furthestPercentage > prev.furthestPercentage ||
              (row.furthestPercentage === prev.furthestPercentage &&
                row.updatedAt > prev.updatedAt)))
        ) {
          bestByBook.set(row.bookId, row);
        }
      }
      // Batch enrichment: one WHERE id IN (...) lookup instead of one
      // getBookByIdOptimized round-trip per row.
      const scoped = [...bestByBook.values()];
      const booksById = getBooksByIdsOptimized(scoped.map((row) => row.bookId));
      const items = [];
      for (const row of scoped) {
        const book = booksById.get(row.bookId);
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
    GET: async (req) => {
      const bookId = parseBookId(req.params.bookId ?? "");
      if (bookId === null) {
        return Response.json({ error: "Invalid book id" }, { status: 400 });
      }
      const user = await currentUser(req);
      if (!user) {
        return Response.json(
          { progress: null },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }
      const libraryId = resolveLibraryId(req);
      const format = parseFormatQuery(new URL(req.url).searchParams.get("format"));
      if (format === null) {
        return Response.json({ error: "Invalid format" }, { status: 400 });
      }
      const progress = getProgress(user.id, libraryId, bookId, format);
      return Response.json(
        {
          progress,
          formats: listProgressFormats(user.id, libraryId, bookId),
          serverSeq: progress?.serverSeq ?? null,
          // T5: writers acknowledge this generation via baseDeletionSeq; a
          // fresh value resurrects, a stale/absent one is rejected on write.
          deletionSeq: getProgressDeletion(user.id, libraryId, bookId, format).seq,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
    PUT: async (req) => {
      const bookId = parseBookId(req.params.bookId ?? "");
      if (bookId === null) {
        return Response.json({ error: "Invalid book id" }, { status: 400 });
      }
      const user = await currentUser(req);
      if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
      // S3: catalog context captured BEFORE the body is awaited.
      const libraryId = resolveLibraryId(req);
      const book = getBookByIdOptimized(bookId);
      if (!book) return Response.json({ error: "Book not found" }, { status: 404 });
      return handleProgressWrite(req, bookId, user, libraryId, book);
    },
    // POST alias for PUT: navigator.sendBeacon can only POST, and the
    // client treats beacon queueing as unacked until a PUT/POST returns ok.
    POST: async (req) => {
      const bookId = parseBookId(req.params.bookId ?? "");
      if (bookId === null) {
        return Response.json({ error: "Invalid book id" }, { status: 400 });
      }
      const user = await currentUser(req);
      if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
      // S3: catalog context captured BEFORE the body is awaited.
      const libraryId = resolveLibraryId(req);
      const book = getBookByIdOptimized(bookId);
      if (!book) return Response.json({ error: "Book not found" }, { status: 404 });
      return handleProgressWrite(req, bookId, user, libraryId, book);
    },
    DELETE: async (req) => {
      const bookId = parseBookId(req.params.bookId ?? "");
      if (bookId === null) {
        return Response.json({ error: "Invalid book id" }, { status: 400 });
      }
      const user = await currentUser(req);
      if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
      const format = parseFormatQuery(new URL(req.url).searchParams.get("format"));
      if (format === null) {
        return Response.json({ error: "Invalid format" }, { status: 400 });
      }
      const libraryId = resolveLibraryId(req);
      const removed = deleteProgress(user.id, libraryId, bookId, format);
      return Response.json(
        {
          removed,
          deletionSeq: getProgressDeletion(user.id, libraryId, bookId, format).seq,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
  },

  // OPDS catalog root
  "/opds": {
    GET: (req) => {
      try {
        const baseUrl = getPublicBaseUrl(req);
        const pathPrefix = opdsPathPrefix(req);
        const updated = opdsCatalogUpdated();
        const selfPath = getRequestPath(req);

        return getCachedTextResponse(
          `opds:root:${baseUrl}:${pathPrefix}:${selfPath}`,
          () =>
            renderNavigationFeed({
              baseUrl,
              pathPrefix,
              updated,
              totalBooks: getBookCount(),
            }),
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
        const pathPrefix = opdsPathPrefix(req);
        const selfPath = getRequestPath(req);

        return getCachedTextResponse(
          `opds:search-description:${baseUrl}:${pathPrefix}:${selfPath}`,
          () => renderOpenSearchDescription(baseUrl, pathPrefix),
          req,
          `${OPENSEARCH_TYPE}; charset=utf-8`,
          "public, max-age=3600",
        );
      } catch (error) {
        console.error("Error rendering OPDS search descriptor:", error);
        return Response.json({ error: "Failed to render OPDS search descriptor" }, { status: 500 });
      }
    },
  },

  // Paged OPDS acquisition feed
  "/opds/books": {
    GET: (req) => {
      try {
        const params = parseOpdsPageParams(req);
        const title = params.sortBy === "added" ? "Recently added" : "All books";
        return opdsAcquisitionResponse(req, title, "/opds/books", () =>
          listBooksCursor({ ...params, requireFormats: true }),
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS books:",
          "Failed to render OPDS books",
        );
      }
    },
  },

  // Recently-added OPDS acquisition feed
  "/opds/recent": {
    GET: (req) => {
      try {
        const params = parseOpdsPageParams(req);
        return opdsAcquisitionResponse(
          req,
          "Recently added",
          "/opds/recent",
          () =>
            listBooksCursor({
              cursor: params.cursor,
              limit: params.limit,
              sortBy: "added",
              sortOrder: "desc",
              requireFormats: true,
            }),
          {
            sortBy: "added",
            sortOrder: "desc",
          },
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS recent books:",
          "Failed to render OPDS recent books",
        );
      }
    },
  },

  // OPDS author navigation feed
  "/opds/authors": {
    GET: (req) => {
      try {
        const params = parseOpdsCatalogParams(req);
        return opdsCatalogResponse(
          req,
          "Authors",
          "/opds/authors",
          () => listAuthorsCursor(params),
          (entry) => `/opds/authors/${encodeURIComponent(String(entry.id))}/books`,
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS authors:",
          "Failed to render OPDS authors",
        );
      }
    },
  },

  "/opds/authors/:id/books": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid author ID" }, { status: 400 });
        }

        const entry = getCatalogEntry("authors", id);
        if (!entry) {
          return Response.json({ error: "Author not found" }, { status: 404 });
        }

        const params = parseOpdsPageParams(req);
        return opdsAcquisitionResponse(
          req,
          `Author: ${entry.title}`,
          `/opds/authors/${id}/books`,
          () => listBooksByAuthorCursor(id, { ...params, requireFormats: true }),
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS author books:",
          "Failed to render OPDS author books",
        );
      }
    },
  },

  // OPDS series navigation feed
  "/opds/series": {
    GET: (req) => {
      try {
        const params = parseOpdsCatalogParams(req);
        return opdsCatalogResponse(
          req,
          "Series",
          "/opds/series",
          () => listSeriesCursor(params),
          (entry) => `/opds/series/${encodeURIComponent(String(entry.id))}/books`,
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS series:",
          "Failed to render OPDS series",
        );
      }
    },
  },

  "/opds/series/:id/books": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid series ID" }, { status: 400 });
        }

        const entry = getCatalogEntry("series", id);
        if (!entry) {
          return Response.json({ error: "Series not found" }, { status: 404 });
        }

        const params = parseOpdsPageParams(req);
        // F25: series books default to series_index order unless the caller
        // passes an explicit sortBy.
        const explicitSortBy = new URL(req.url).searchParams.get("sortBy");
        const seriesSortBy = explicitSortBy ? params.sortBy : "series_index";
        return opdsAcquisitionResponse(
          req,
          `Series: ${entry.title}`,
          `/opds/series/${id}/books`,
          () =>
            listBooksBySeriesCursor(id, { ...params, sortBy: seriesSortBy, requireFormats: true }),
          { sortBy: seriesSortBy, sortOrder: params.sortOrder },
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS series books:",
          "Failed to render OPDS series books",
        );
      }
    },
  },

  // OPDS tag navigation feed
  "/opds/tags": {
    GET: (req) => {
      try {
        const params = parseOpdsCatalogParams(req);
        return opdsCatalogResponse(
          req,
          "Tags",
          "/opds/tags",
          () => listTagsCursor(params),
          (entry) => `/opds/tags/${encodeURIComponent(String(entry.id))}/books`,
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS tags:",
          "Failed to render OPDS tags",
        );
      }
    },
  },

  "/opds/tags/:id/books": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid tag ID" }, { status: 400 });
        }

        const entry = getCatalogEntry("tags", id);
        if (!entry) {
          return Response.json({ error: "Tag not found" }, { status: 404 });
        }

        const params = parseOpdsPageParams(req);
        return opdsAcquisitionResponse(req, `Tag: ${entry.title}`, `/opds/tags/${id}/books`, () =>
          listBooksByTagCursor(id, { ...params, requireFormats: true }),
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS tag books:",
          "Failed to render OPDS tag books",
        );
      }
    },
  },

  // OPDS format navigation feed
  "/opds/formats": {
    GET: (req) => {
      try {
        const params = parseOpdsCatalogParams(req);
        return opdsCatalogResponse(
          req,
          "Formats",
          "/opds/formats",
          () => listFormatsCursor(params),
          (entry) => `/opds/formats/${encodeURIComponent(String(entry.id))}/books`,
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS formats:",
          "Failed to render OPDS formats",
        );
      }
    },
  },

  "/opds/formats/:format/books": {
    GET: (req) => {
      try {
        const format = decodeURIComponent(req.params.format ?? "").toUpperCase();
        const entry = getCatalogEntry("formats", format);
        if (!entry) {
          return Response.json({ error: "Format not found" }, { status: 404 });
        }

        const params = parseOpdsPageParams(req);
        return opdsAcquisitionResponse(
          req,
          `Format: ${entry.title}`,
          `/opds/formats/${encodeURIComponent(format)}/books`,
          () => listBooksByFormatCursor(format, { ...params, requireFormats: true }),
        );
      } catch (error) {
        return routeErrorResponse(
          error,
          "Error rendering OPDS format books:",
          "Failed to render OPDS format books",
        );
      }
    },
  },

  // Paged OPDS search feed
  "/opds/search": {
    GET: (req) => {
      try {
        const url = new URL(req.url);
        const baseUrl = getPublicBaseUrl(req);
        const pathPrefix = opdsPathPrefix(req);
        const query = url.searchParams.get("q") || "";
        const cursor = url.searchParams.get("cursor") || undefined;
        const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
          min: 1,
          max: MAX_QUERY_LIMIT,
        });
        const sortBy = parseSortField(url.searchParams.get("sortBy"));
        const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
        const result = searchBooksCursor({
          query,
          cursor,
          limit,
          sortBy,
          sortOrder,
          requireFormats: true,
        });
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
          pathPrefix,
          selfPath,
          title,
          id: new URL(selfPath, baseUrl).toString(),
          updated: opdsCatalogUpdated(),
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
        return routeErrorResponse(
          error,
          "Error rendering OPDS search:",
          "Failed to render OPDS search",
        );
      }
    },
  },

  // OPDS single-book acquisition feed
  "/opds/book/:id": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        const baseUrl = getPublicBaseUrl(req);
        const pathPrefix = opdsPathPrefix(req);
        const selfPath = getRequestPath(req);

        return getCachedTextResponse(
          `opds:book:${baseUrl}:${pathPrefix}:${selfPath}`,
          () => {
            const book = getBookByIdOptimized(id);
            if (!book) {
              return Response.json({ error: "Book not found" }, { status: 404 });
            }
            return renderSingleBookFeed({
              baseUrl,
              pathPrefix,
              selfPath,
              updated: opdsCatalogUpdated(),
              book,
            });
          },
          req,
          `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
        );
      } catch (error) {
        console.error("Error rendering OPDS book:", error);
        return Response.json({ error: "Failed to render OPDS book" }, { status: 500 });
      }
    },
  },

  // F23: compat alias for the single-book acquisition feed (see
  // /opds/book/:id/complete for the bare entry document).
  "/opds/book/:id/feed": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        const baseUrl = getPublicBaseUrl(req);
        const pathPrefix = opdsPathPrefix(req);
        const selfPath = getRequestPath(req);

        return getCachedTextResponse(
          `opds:book-feed:${baseUrl}:${pathPrefix}:${selfPath}`,
          () => {
            const book = getBookByIdOptimized(id);
            if (!book) {
              return Response.json({ error: "Book not found" }, { status: 404 });
            }
            return renderSingleBookFeed({
              baseUrl,
              pathPrefix,
              selfPath,
              updated: opdsCatalogUpdated(),
              book,
            });
          },
          req,
          `${OPDS_ACQUISITION_TYPE}; charset=utf-8`,
        );
      } catch (error) {
        console.error("Error rendering OPDS book feed:", error);
        return Response.json({ error: "Failed to render OPDS book" }, { status: 500 });
      }
    },
  },

  // F23: complete-entry document for a single book: a bare <entry> served
  // with `application/atom+xml;type=entry;profile=opds-catalog`.
  "/opds/book/:id/complete": {
    GET: (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        const baseUrl = getPublicBaseUrl(req);
        const pathPrefix = opdsPathPrefix(req);
        const selfPath = getRequestPath(req);

        return getCachedTextResponse(
          `opds:book-complete:${baseUrl}:${pathPrefix}:${selfPath}`,
          () => {
            const book = getBookByIdOptimized(id);
            if (!book) {
              return Response.json({ error: "Book not found" }, { status: 404 });
            }
            return renderBookCompleteEntry({ baseUrl, pathPrefix, book });
          },
          req,
          `${OPDS_ENTRY_TYPE}; charset=utf-8`,
        );
      } catch (error) {
        console.error("Error rendering OPDS complete book:", error);
        return Response.json({ error: "Failed to render OPDS book" }, { status: 500 });
      }
    },
  },

  // F24: OPDS acquisition/artwork routes. Challenge-capable (matched by the
  // /opds auth guard) proxies to the same file handlers as /api.
  "/opds/book/:id/download/:format": {
    GET: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveBookFile(req, id, req.params.format ?? "", "attachment");
      } catch (error) {
        console.error("Error downloading OPDS book:", error);
        return Response.json({ error: "Failed to download book" }, { status: 500 });
      }
    },
    HEAD: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveBookFile(req, id, req.params.format ?? "", "attachment");
      } catch (error) {
        console.error("Error downloading OPDS book:", error);
        return Response.json({ error: "Failed to download book" }, { status: 500 });
      }
    },
  },

  "/opds/book/:id/file/:format": {
    GET: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveBookFile(req, id, req.params.format ?? "", "inline");
      } catch (error) {
        console.error("Error streaming OPDS book:", error);
        return Response.json({ error: "Failed to stream book" }, { status: 500 });
      }
    },
    HEAD: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveBookFile(req, id, req.params.format ?? "", "inline");
      } catch (error) {
        console.error("Error streaming OPDS book:", error);
        return Response.json({ error: "Failed to stream book" }, { status: 500 });
      }
    },
  },

  "/opds/book/:id/cover": {
    GET: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveCoverById(req, id);
      } catch (error) {
        console.error("Error getting OPDS cover:", error);
        return Response.json({ error: "Failed to get cover" }, { status: 500 });
      }
    },
  },

  "/opds/book/:id/thumb": {
    GET: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        return await serveThumbById(req, id);
      } catch (error) {
        console.error("Error getting OPDS thumb:", error);
        return Response.json({ error: "Failed to get thumbnail" }, { status: 500 });
      }
    },
  },

  // Stream all books (for massive datasets). Pull-driven: each pull()
  // awaits the next DB batch (streamBooks checks out and releases a pool
  // connection per batch), backpressure propagates to the database cursor,
  // a generation lease pins the snapshot for the export duration, and a
  // client abort stops iteration immediately.
  "/api/books/stream": {
    GET: async (req) => {
      const url = new URL(req.url);
      const batchSize = parseBoundedInt(url.searchParams.get("batchSize"), 1000, {
        min: 1,
        max: MAX_STREAM_BATCH_SIZE,
      });

      const releaseLease = acquireSnapshotLease();
      let leaseReleased = false;
      const finishLease = () => {
        if (!leaseReleased) {
          leaseReleased = true;
          releaseLease();
        }
      };
      const jsonGen = streamBooksJSON(streamBooks(batchSize));

      const stream = new ReadableStream({
        async pull(controller) {
          if (req.signal.aborted) {
            finishLease();
            controller.close();
            return;
          }
          try {
            const next = await jsonGen.next();
            if (req.signal.aborted || next.done) {
              finishLease();
              controller.close();
              return;
            }
            controller.enqueue(streamEncoder.encode(next.value));
          } catch (error) {
            finishLease();
            controller.error(error);
          }
        },
        async cancel() {
          finishLease();
          try {
            await jsonGen.return(undefined);
          } catch {
            // ignore teardown errors
          }
        },
      });
      req.signal.addEventListener("abort", finishLease, { once: true });

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
        const formats = parseFormats(url);
        // S7: cheap first-page total. Explicit ?includeTotal=0/false opts
        // out; otherwise the first page (cursor == null) includes total via
        // COUNT(*) with the same filters and later pages omit it.
        const includeParam = url.searchParams.get("includeTotal");
        const wantTotal =
          includeParam === null
            ? !cursor
            : includeParam === "1" || includeParam.toLowerCase() === "true";

        const cacheKey = `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}:tags:${tagIds.join(",")}:formats:${formats.join(",")}:total:${wantTotal ? 1 : 0}`;
        return getCachedResponse(
          cacheKey,
          () =>
            listBooksCursor({
              cursor,
              limit,
              sortBy,
              sortOrder,
              tagIds,
              formats,
              includeTotal: wantTotal,
            }),
          req,
        );
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
        const formats = parseFormats(url);
        // S7: same first-page-total contract as /api/books (see above).
        const includeParam = url.searchParams.get("includeTotal");
        const wantTotal =
          includeParam === null
            ? !cursor
            : includeParam === "1" || includeParam.toLowerCase() === "true";

        if (!query.trim()) {
          return getCachedResponse(
            `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}:tags:${tagIds.join(",")}:formats:${formats.join(",")}:total:${wantTotal ? 1 : 0}`,
            () =>
              listBooksCursor({
                cursor,
                limit,
                sortBy,
                sortOrder,
                tagIds,
                formats,
                includeTotal: wantTotal,
              }),
            req,
          );
        }

        const result = searchBooksCursor({
          query,
          cursor,
          limit,
          sortBy,
          sortOrder,
          tagIds,
          formats,
          includeTotal: wantTotal,
        });

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
        const id = parseBookId(req.params.id ?? "");

        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return getCachedResponse(
          `book:${id}`,
          () => {
            const book = getBookByIdOptimized(id);
            if (!book) {
              return Response.json({ error: "Book not found" }, { status: 404 });
            }
            return book;
          },
          req,
        );
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
        const id = parseBookId(req.params.id ?? "");

        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveBookFile(req, id, req.params.format ?? "", "attachment");
      } catch (error) {
        console.error("Error downloading book:", error);
        return Response.json({ error: "Failed to download book" }, { status: 500 });
      }
    },
    HEAD: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");

        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveBookFile(req, id, req.params.format ?? "", "attachment");
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
        const id = parseBookId(req.params.id ?? "");

        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveBookFile(req, id, req.params.format ?? "", "inline");
      } catch (error) {
        console.error("Error streaming book:", error);
        return Response.json({ error: "Failed to stream book" }, { status: 500 });
      }
    },
    HEAD: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");

        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveBookFile(req, id, req.params.format ?? "", "inline");
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
      url.pathname = `/api/books/${req.params.id ?? ""}/epub/`;
      return Response.redirect(url, 308);
    },
    HEAD: (req) => {
      const url = new URL(req.url);
      url.pathname = `/api/books/${req.params.id ?? ""}/epub/`;
      return Response.redirect(url, 308);
    },
  },

  "/api/books/:id/epub/**": {
    GET: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");

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
        const id = parseBookId(req.params.id ?? "");

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
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        if (!FORMAT_PATTERN.test(req.params.format ?? "")) {
          return Response.json({ error: "Invalid format" }, { status: 400 });
        }

        const manifest = await getPageManifest(id, req.params.format ?? "");
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
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }
        if (!FORMAT_PATTERN.test(req.params.format ?? "")) {
          return Response.json({ error: "Invalid format" }, { status: 400 });
        }

        await getPageManifest(id, req.params.format ?? "");
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
        const id = parseBookId(req.params.id ?? "");
        const page = parseBookId(req.params.page ?? "");
        if (id === null || page === null) {
          return Response.json({ error: "Invalid page request" }, { status: 400 });
        }
        if (!FORMAT_PATTERN.test(req.params.format ?? "")) {
          return Response.json({ error: "Invalid format" }, { status: 400 });
        }

        const pageFile = await getPageFile(id, req.params.format ?? "", page);
        return serveLocalFile(req, pageFile.path, {
          contentType: pageFile.contentType,
          cacheControl: "no-cache",
          // Defense in depth now that SVG pages are filtered upstream: pages
          // render in <img>, never as documents. Sandbox + nosniff (set by
          // serveLocalFile) limits damage if a hostile image is mislabeled.
          contentSecurityPolicy: "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        });
      } catch (error) {
        return pageStreamingErrorResponse(error);
      }
    },
    HEAD: async (req) => {
      try {
        const id = parseBookId(req.params.id ?? "");
        const page = parseBookId(req.params.page ?? "");
        if (id === null || page === null) {
          return Response.json({ error: "Invalid page request" }, { status: 400 });
        }
        if (!FORMAT_PATTERN.test(req.params.format ?? "")) {
          return Response.json({ error: "Invalid format" }, { status: 400 });
        }

        const pageFile = await getPageFile(id, req.params.format ?? "", page);
        return serveLocalFile(req, pageFile.path, {
          contentType: pageFile.contentType,
          cacheControl: "no-cache",
          contentSecurityPolicy: "sandbox; default-src 'none'; style-src 'unsafe-inline'",
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
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveCoverById(req, id);
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
        const id = parseBookId(req.params.id ?? "");
        if (id === null) {
          return Response.json({ error: "Invalid book ID" }, { status: 400 });
        }

        return await serveThumbById(req, id);
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
      if (!MCP_ENABLED) {
        return Response.json({ error: "MCP is disabled" }, { status: 404 });
      }
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
} satisfies RouteTable;

// --- Host header validation --------------------------------------------------
//
// Requests are only served when the effective host is one the operator
// configured (loopback names plus CALIBER_HOST / PUBLIC_BASE_URL). This keeps
// DNS-rebinding browsers out of privileged endpoints and stops attacker-chosen
// Host values from reaching OPDS feed rendering and cache keys. Behind a
// trusted proxy the forwarded host is authoritative and is accepted as-is.
// When bound to a non-loopback address without PUBLIC_BASE_URL, client host
// names cannot be enumerated, so any Host is accepted and DNS-rebinding
// protection is delegated to the optional auth gate.

const ALLOWED_HOST_NAMES = new Set<string>(LOCAL_SETUP_HOSTS);

function normalizedHostName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? "" : trimmed.slice(1, end);
  }
  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  const host =
    firstColon === -1 || firstColon !== lastColon ? trimmed : trimmed.slice(0, firstColon);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function allowHostName(candidate: string | null | undefined): void {
  const name = candidate ? normalizedHostName(candidate) : "";
  if (name && !ALLOWED_HOST_NAMES.has(name)) ALLOWED_HOST_NAMES.add(name);
}

allowHostName(HOST);
if (PUBLIC_BASE_URL) {
  try {
    allowHostName(new URL(PUBLIC_BASE_URL).hostname);
  } catch {
    // PUBLIC_BASE_URL is validated at load; ignore unexpected shapes.
  }
}

const HOST_IS_LOOPBACK = LOCAL_SETUP_HOSTS.has(normalizedHostName(HOST));
const HOST_VALIDATION_PERMISSIVE = !PUBLIC_BASE_URL && !HOST_IS_LOOPBACK;

function isRequestHostAllowed(req: Request): boolean {
  if (TRUST_PROXY && req.headers.get("X-Forwarded-Host")) return true;
  if (HOST_VALIDATION_PERMISSIVE) return true;
  const host = req.headers.get("Host");
  if (host === null) return HOST_IS_LOOPBACK;
  return ALLOWED_HOST_NAMES.has(normalizedHostName(host));
}

function hostValidationErrorResponse(): Response {
  return Response.json(
    { error: "Request host is not allowed" },
    { status: 421, headers: { "Cache-Control": "no-store" } },
  );
}

function withHostValidation(routeTable: Record<string, unknown>): Record<string, unknown> {
  const validated: Record<string, unknown> = {};
  for (const [pattern, route] of Object.entries(routeTable)) {
    if (typeof route !== "object" || route === null || pattern === "/*") {
      validated[pattern] = route;
      continue;
    }
    const wrapped: { [method: string]: RouteHandler } = {};
    for (const [method, handler] of Object.entries(route as { [method: string]: RouteHandler })) {
      wrapped[method] = async (req) => {
        if (!isRequestHostAllowed(req)) return hostValidationErrorResponse();
        return handler(req);
      };
    }
    validated[pattern] = wrapped;
  }
  return validated;
}

// --- Optional auth guard -----------------------------------------------------
//
// Handlers are always wrapped; on each request the wrapper checks the live
// AUTH_ENABLED binding so the Settings UI can toggle auth without a restart.
// When enabled, every /api, /opds, /mcp, and /pdfjs route requires a valid
// session cookie or HTTP Basic credentials (the mechanism OPDS clients use).
// The SPA shell and the endpoints above stay public.

const PUBLIC_AUTH_PATHS = new Set([
  "/api/health",
  "/api/user/me",
  "/api/user/login",
  "/api/user/logout",
  "/api/auth/setup",
]);

function isAuthProtectedPattern(pattern: string): boolean {
  return (
    pattern === "/api" ||
    pattern === "/mcp" ||
    pattern.startsWith("/api/") ||
    pattern.startsWith("/opds") ||
    pattern.startsWith("/pdfjs")
  );
}

function unauthorizedResponse(pathname: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  // Advertise Basic auth only on OPDS paths: on /api it would pop up the
  // browser's native login dialog over the SPA's own login screen.
  if (pathname.startsWith("/opds")) {
    headers["WWW-Authenticate"] = 'Basic realm="Caliber", charset="UTF-8"';
  }
  return Response.json({ error: "Authentication required" }, { status: 401, headers });
}

function withAuthGuard(routeTable: RouteTable): Record<string, unknown> {
  const guarded: Record<string, unknown> = {};
  for (const [pattern, route] of Object.entries(routeTable)) {
    if (typeof route !== "object" || route === null || !isAuthProtectedPattern(pattern)) {
      guarded[pattern] = route;
      continue;
    }
    const wrapped: { [method: string]: RouteHandler } = {};
    for (const [method, handler] of Object.entries(route as { [method: string]: RouteHandler })) {
      wrapped[method] = async (req) => {
        if (!AUTH_ENABLED) return handler(req);
        const pathname = new URL(req.url).pathname;
        if (PUBLIC_AUTH_PATHS.has(pathname)) return handler(req);
        const authenticated = await authenticateRequest(req);
        if (!authenticated) return unauthorizedResponse(pathname);
        setRequestUser(req, authenticated);
        return handler(req);
      };
    }
    guarded[pattern] = wrapped;
  }
  return guarded;
}

const server = serve({
  hostname: HOST,
  port: parseBoundedInt(PORT, DEFAULT_PORT, { min: 1, max: 65535 }),
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  routes: withHostValidation(withAuthGuard(routes)) as typeof routes,
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
console.log(`📚 Library: ${LIBRARY_PATH}`);
console.log(`⚙️ Runtime: Bun ${Bun.version} (${process.execPath})`);
if (AUTH_ENABLED) {
  console.log(
    needsInitialSetup()
      ? "🔒 Auth enabled: no accounts yet — create one in the browser or with `bun src/cli.ts user add <name>`"
      : "🔒 Auth enabled",
  );
}
