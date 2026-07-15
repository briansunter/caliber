import { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  CONFIG_DIR_PATH,
  DB_NAME,
  DB_REFRESH_INTERVAL_MS,
  LIBRARY_PATH,
} from "./config";
import {
  type SourceSignature,
  getDatabaseSignature,
  isSameSignature,
} from "./file-signature";

let DB_PATH = join(LIBRARY_PATH, DB_NAME);

// Writable copy in ~/.config/caliber for FTS support
const WORK_DIR = CONFIG_DIR_PATH;
const WRITABLE_DB_PATH = join(WORK_DIR, "metadata.db");
const DB_SOURCE_SIGNATURE_PATH = join(WORK_DIR, "metadata.source.json");

interface SnapshotMetadata {
  sourcePath: string;
  signature: SourceSignature;
}

function readSnapshotMetadata(): SnapshotMetadata | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(DB_SOURCE_SIGNATURE_PATH, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.sourcePath !== "string" || typeof record.signature !== "object") {
      return null;
    }
    return {
      sourcePath: record.sourcePath,
      signature: record.signature as SourceSignature,
    };
  } catch {
    return null;
  }
}

function copyDbToWritable(): void {
  if (resolve(DB_PATH) === resolve(WRITABLE_DB_PATH)) {
    throw new Error("Calibre source database must be outside Caliber's cache directory");
  }
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Calibre database not found at ${DB_PATH}. Set CALIBRE_LIBRARY_PATH (or CALIBER_LIBRARY_PATH) to a library containing ${DB_NAME}.`,
    );
  }

  mkdirSync(WORK_DIR, { recursive: true });
  for (const suffix of ["-wal", "-shm"]) {
    const p = WRITABLE_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }

  // SQLite can have committed changes in the source WAL. serialize() asks
  // SQLite for a consistent snapshot instead of copying only metadata.db.
  const sourceDb = new Database(DB_PATH, { readonly: true });
  const temporaryPath = `${WRITABLE_DB_PATH}.tmp-${process.pid}`;
  try {
    const tables = new Set(
      (sourceDb.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const missingTables = ["books", "authors", "data", "books_authors_link"].filter(
      (table) => !tables.has(table),
    );
    if (missingTables.length > 0) {
      throw new Error(`Unsupported Calibre database; missing ${missingTables.join(", ")}`);
    }
    writeFileSync(temporaryPath, sourceDb.serialize());
    try {
      renameSync(temporaryPath, WRITABLE_DB_PATH);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      unlinkSync(WRITABLE_DB_PATH);
      renameSync(temporaryPath, WRITABLE_DB_PATH);
    }
  } finally {
    sourceDb.close();
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }

  const signature = getDatabaseSignature(DB_PATH);
  writeFileSync(
    DB_SOURCE_SIGNATURE_PATH,
    `${JSON.stringify({ sourcePath: resolve(DB_PATH), signature })}\n`,
  );
  console.error(`📋 Copied database snapshot to ${WRITABLE_DB_PATH}`);
}

// Connection pool for concurrent requests
const dbPool: Database[] = [];
const MAX_POOL_SIZE = 5;
let activeStreams = 0;
let refreshPending = false;

const dbRefreshCallbacks: Array<() => void> = [];

export function onDbRefresh(cb: () => void): void {
  dbRefreshCallbacks.push(cb);
}

function closePool(): void {
  for (const db of dbPool) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  dbPool.length = 0;
}

function runRefresh(): void {
  if (activeStreams > 0) {
    refreshPending = true;
    return;
  }
  closePool();
  copyDbToWritable();
  runFtsSetup();
  for (const cb of dbRefreshCallbacks) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

/** Switch to a validated library selection without restarting the server. */
export function reconfigureLibraryDatabase(): void {
  closePool();
  DB_PATH = join(LIBRARY_PATH, DB_NAME);
  copyDbToWritable();
  runFtsSetup();
  for (const cb of dbRefreshCallbacks) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

// Ensure writable DB exists and is up-to-date with the source Calibre DB
function ensureWritableDb(): void {
  if (!existsSync(WRITABLE_DB_PATH)) {
    copyDbToWritable();
    return;
  }

  try {
    const sourceSignature = getDatabaseSignature(DB_PATH);
    const snapshot = readSnapshotMetadata();
    if (
      !snapshot ||
      snapshot.sourcePath !== resolve(DB_PATH) ||
      !isSameSignature(snapshot.signature, sourceSignature)
    ) {
      copyDbToWritable();
    }
  } catch {
    // If stat fails, leave existing copy in place
  }
}

// Get database connection from pool or create new one — never touches the filesystem
function getDb(): Database {
  if (dbPool.length < MAX_POOL_SIZE) {
    const db = new Database(WRITABLE_DB_PATH);
    try {
      db.exec("PRAGMA cache_size = -64000;"); // 64MB cache
      db.exec("PRAGMA temp_store = memory;");
      db.exec("PRAGMA mmap_size = 268435456;"); // 256MB memory map
      db.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // Ignore if these fail
    }
    dbPool.push(db);
    return db;
  }
  // Round-robin through pool
  const idx = Math.floor(Math.random() * dbPool.length);
  const db = dbPool[idx];
  if (!db) throw new Error("DB pool unexpectedly empty");
  return db;
}

function runFtsSetup(): void {
  const db = getDb();
  const sourceSignature = getDatabaseSignature(DB_PATH);
  const sourceSignatureValue = JSON.stringify(sourceSignature);

  // Expression indexes for keyset pagination (match LOWER() calls in WHERE clauses)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_sort_lower ON books(lower(sort), id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_author_sort_lower ON books(lower(author_sort), id);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_timestamp ON books(timestamp, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_ratings_link_book ON books_ratings_link(book);`);

  // Link-table indexes
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_authors_link_book ON books_authors_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_tags_link_book ON books_tags_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_series_link_book ON books_series_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_publishers_link_book ON books_publishers_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_series_link_series ON books_series_link(series);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_tags_link_tag ON books_tags_link(tag);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name);`);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      title,
      author_sort,
      content='books',
      content_rowid='id'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS caliber_fts_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const bookCount = db.query("SELECT COUNT(*) as count FROM books").get() as { count: number };
  const ftsCount = db.query("SELECT COUNT(*) as count FROM books_fts").get() as { count: number };
  const meta = db
    .query("SELECT value FROM caliber_fts_meta WHERE key = 'source_signature'")
    .get() as { value: string } | null;

  if (meta?.value !== sourceSignatureValue || ftsCount.count !== bookCount.count) {
    console.error("🔍 Building FTS index...");
    db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild');`);
    db.query(
      "INSERT OR REPLACE INTO caliber_fts_meta (key, value) VALUES ('source_signature', ?)",
    ).run(sourceSignatureValue);
  }

  const total = db.query("SELECT COUNT(*) as count FROM books_fts").get() as { count: number };
  console.error(`🔍 FTS index ready (${total.count} books)`);
}

// Initialize FTS5 virtual table on writable copy — runs once at startup
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function initFTS(): boolean {
  let ready = false;
  try {
    ensureWritableDb();

    runFtsSetup();

    // Warm up: run initial query to populate mmap/cache
    console.error("🔥 Warming up database...");
    const db = getDb();
    db.query("SELECT COUNT(*) FROM books").get();
    db.query(`
      SELECT b.id FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN data d ON b.id = d.book
      ORDER BY b.sort ASC LIMIT 1
    `).get();
    console.error("🔥 Database warm");
    ready = true;
  } catch (error) {
    console.error("📚 Library is not ready:", error instanceof Error ? error.message : error);
  }

  // Low-frequency freshness check, unref'd so it doesn't block process exit.
  if (refreshTimer) return ready;
  refreshTimer = setInterval(() => {
    try {
      const sig = getDatabaseSignature(DB_PATH);
      const snapshot = readSnapshotMetadata();
      if (
        !snapshot ||
        snapshot.sourcePath !== resolve(DB_PATH) ||
        !isSameSignature(snapshot.signature, sig)
      ) {
        console.error("🔄 Source DB changed — refreshing...");
        runRefresh();
      }
    } catch {
      // If stat fails just skip this tick
    }
  }, DB_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer === "object" && refreshTimer !== null && "unref" in refreshTimer) {
    (refreshTimer as NodeJS.Timeout).unref();
  }
  return ready;
}

export interface BookListItem {
  id: number;
  title: string;
  sort: string | null;
  author_sort: string | null;
  authors: string[];
  series: string | null;
  series_index: number;
  tags: string[];
  formats: string[];
  has_cover: boolean;
  pubdate: string;
  timestamp: string;
  rating: number | null;
  publisher?: string | null;
  comments?: string | null;
  isbn?: string;
  uuid?: string;
  path?: string;
}

export interface BookWithDetails extends BookListItem {
  publisher: string | null;
  comments: string | null;
  isbn: string;
  uuid: string;
  path: string;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export type CatalogKind = "authors" | "series" | "tags" | "formats";

export interface CatalogEntry {
  id: number | string;
  title: string;
  sort: string;
  bookCount: number;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

interface BookRow {
  id: number;
  title: string;
  sort: string | null;
  author_sort: string | null;
  series: string | null;
  series_index: number;
  has_cover: number;
  pubdate: string;
  timestamp: string;
  rating: number | null;
  publisher: string | null;
  comments: string | null;
  isbn: string;
  uuid: string;
  path: string;
  authors: string | null;
  tags: string | null;
  formats: string | null;
}

function splitAggregatedField(value: string | null): string[] {
  if (!value) return [];

  // Current queries use JSON aggregates so commas in author/tag names remain
  // intact. Keep the comma fallback for older writable snapshots.
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  } catch {
    // Legacy GROUP_CONCAT value; fall through to the compatibility parser.
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Parse book row with aggregated fields
function parseBookRow(row: BookRow): BookListItem {
  return {
    id: row.id,
    title: row.title,
    sort: row.sort,
    author_sort: row.author_sort,
    authors: splitAggregatedField(row.authors),
    series: row.series,
    series_index: row.series_index,
    tags: splitAggregatedField(row.tags),
    formats: splitAggregatedField(row.formats),
    has_cover: Boolean(row.has_cover),
    pubdate: row.pubdate,
    timestamp: row.timestamp,
    rating: row.rating,
  };
}

// Parse book row with full details
function parseBookDetailsRow(row: BookRow): BookWithDetails {
  return {
    ...parseBookRow(row),
    publisher: row.publisher,
    comments: row.comments,
    isbn: row.isbn ?? "",
    uuid: row.uuid,
    path: row.path,
  };
}

// Encode cursor from book data
function encodeCursor(book: BookListItem, sortField: string): string {
  let sortVal: string | number;
  switch (sortField) {
    case "title":
      sortVal = (book.sort || book.title).toLowerCase();
      break;
    case "author":
      sortVal = (book.author_sort || "").toLowerCase();
      break;
    case "added":
      sortVal = book.timestamp || "";
      break;
    case "rating":
      sortVal = book.rating != null ? book.rating : 0;
      break;
    default:
      sortVal = book.id;
  }
  const cursorData = { id: book.id, sort: sortVal };
  return Buffer.from(JSON.stringify(cursorData)).toString("base64url");
}

// Decode cursor to get pagination info
function decodeCursor(cursor: string): { id: number; sort: string | number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString();
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "number" ||
      !Number.isSafeInteger(record.id) ||
      record.id <= 0 ||
      (typeof record.sort !== "string" && typeof record.sort !== "number")
    ) {
      return null;
    }
    if (typeof record.sort === "number" && !Number.isFinite(record.sort)) return null;
    return { id: record.id, sort: record.sort };
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined, fallback = 100, max = 200): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : fallback;
  return Math.min(max, Math.max(1, value));
}

function isSafeLibraryPath(filePath: string): boolean {
  const resolvedLibrary = resolve(LIBRARY_PATH);
  const lexicalPath = resolve(filePath);
  if (!lexicalPath.startsWith(`${resolvedLibrary}${sep}`)) return false;

  // Resolve symlinks when the target exists so a Calibre row cannot point
  // outside the configured library through a linked directory.
  if (existsSync(filePath)) {
    try {
      const realLibrary = realpathSync(resolvedLibrary);
      const realFile = realpathSync(filePath);
      return realFile.startsWith(`${realLibrary}${sep}`);
    } catch {
      return false;
    }
  }

  return true;
}

interface ListOptions {
  cursor?: string;
  limit?: number;
  sortBy?: "title" | "author" | "added" | "rating";
  sortOrder?: "asc" | "desc";
  // Tag IDs to filter by (OR logic: a book matches if it has ANY of these tags).
  // Combined with any search/FTS clause via AND.
  tagIds?: number[];
}

// Build a `b.id IN (...)` clause for OR-logic tag filtering, or "" if none valid.
// Returns the clause fragment and the deduped, valid IDs to bind.
function buildTagFilterClause(
  tagIds: number[] | undefined,
): { clause: string; ids: number[] } {
  if (!tagIds || tagIds.length === 0) return { clause: "", ids: [] };
  const seen = new Set<number>();
  for (const id of tagIds) {
    if (Number.isFinite(id) && id > 0) seen.add(id);
  }
  const ids = Array.from(seen);
  if (ids.length === 0) return { clause: "", ids: [] };
  const placeholders = ids.map(() => "?").join(",");
  return {
    clause: `b.id IN (SELECT book FROM books_tags_link WHERE tag IN (${placeholders}))`,
    ids,
  };
}

function buildBookOrderBy(
  sortBy: NonNullable<ListOptions["sortBy"]>,
  sortOrder: NonNullable<ListOptions["sortOrder"]>,
): string {
  const dir = sortOrder.toUpperCase();
  switch (sortBy) {
    case "title":
      return `ORDER BY COALESCE(NULLIF(lower(b.sort), ''), lower(b.title)) ${dir}, b.id ${dir}`;
    case "author":
      return `ORDER BY COALESCE(lower(b.author_sort), '') ${dir}, b.id ${dir}`;
    case "added":
      return `ORDER BY COALESCE(b.timestamp, '') ${dir}, b.id ${dir}`;
    case "rating":
      return `ORDER BY COALESCE(r.rating, 0) ${dir}, b.id ${dir}`;
    default:
      return `ORDER BY COALESCE(NULLIF(lower(b.sort), ''), lower(b.title)) ASC, b.id ASC`;
  }
}

function appendBookCursorWhere(
  bookWhere: string,
  params: (string | number)[],
  options: ListOptions,
): string {
  if (!options.cursor) return bookWhere;

  const cursorData = decodeCursor(options.cursor);
  if (!cursorData) {
    throw new CursorError("Invalid cursor");
  }

  const sortBy = options.sortBy || "title";
  const sortOrder = options.sortOrder || "asc";
  const sortOp = sortOrder === "asc" ? ">" : "<";

  if (sortBy === "title") {
    params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
    return `${bookWhere} AND (COALESCE(NULLIF(lower(b.sort), ''), lower(b.title)) ${sortOp} ? OR (COALESCE(NULLIF(lower(b.sort), ''), lower(b.title)) = ? AND b.id ${sortOp} ?))`;
  }

  if (sortBy === "author") {
    params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
    return `${bookWhere} AND (COALESCE(lower(b.author_sort), '') ${sortOp} ? OR (COALESCE(lower(b.author_sort), '') = ? AND b.id ${sortOp} ?))`;
  }

  if (sortBy === "added") {
    params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
    return `${bookWhere} AND (COALESCE(b.timestamp, '') ${sortOp} ? OR (COALESCE(b.timestamp, '') = ? AND b.id ${sortOp} ?))`;
  }

  if (sortBy === "rating") {
    const ratingVal = Number(cursorData.sort);
    params.push(ratingVal, ratingVal, cursorData.id);
    return `${bookWhere} AND (COALESCE(r.rating, 0) ${sortOp} ? OR (COALESCE(r.rating, 0) = ? AND b.id ${sortOp} ?))`;
  }

  params.push(cursorData.id);
  return `${bookWhere} AND b.id ${sortOp} ?`;
}

function listBooksWithWhere(
  options: ListOptions = {},
  initialWhere: string = "WHERE 1=1",
  initialParams: (string | number)[] = [],
): CursorPaginatedResult<BookListItem> {
  const db = getDb();
  const limit = clampLimit(options.limit);
  const sortBy = options.sortBy || "title";
  const sortOrder = options.sortOrder || "asc";
  const dir = sortOrder.toUpperCase();
  const params = [...initialParams];
  const needsRatingInCte = sortBy === "rating";
  // OR-logic tag filter is part of the base predicate (inside the book_page CTE's
  // WHERE), so it composes with search/FTS via AND and is covered by idx_books_tags_link_tag.
  const tagFilter = buildTagFilterClause(options.tagIds);
  const baseWhere =
    tagFilter.clause.length > 0 ? `${initialWhere} AND ${tagFilter.clause}` : initialWhere;
  if (tagFilter.ids.length > 0) params.push(...tagFilter.ids);
  const bookWhere = appendBookCursorWhere(baseWhere, params, options);
  const bookOrderBy = buildBookOrderBy(sortBy, sortOrder);

  let query: string;

  if (needsRatingInCte) {
    // Include rating join inside the CTE so ORDER BY and WHERE can reference it
    query = `
      WITH book_page AS (
        SELECT b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp,
               COALESCE(r.rating, 0) AS rating_val
        FROM books b
        LEFT JOIN books_ratings_link brl ON b.id = brl.book
        LEFT JOIN ratings r ON brl.rating = r.id
        ${bookWhere}
        ORDER BY COALESCE(r.rating, 0) ${dir}, b.id ${dir}
        LIMIT ${limit + 1}
      )
      SELECT
        b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp,
        s.name as series,
        b.rating_val as rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM book_page b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      GROUP BY b.id
      ORDER BY b.rating_val ${dir}, b.id ${dir}
    `;
  } else {
    query = `
      WITH book_page AS (
        SELECT b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp
        FROM books b
        ${bookWhere}
        ${bookOrderBy}
        LIMIT ${limit + 1}
      )
      SELECT
        b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp,
        s.name as series,
        r.rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM book_page b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      GROUP BY b.id
      ${bookOrderBy}
    `;
  }

  const rows = db.query(query).all(...params) as BookRow[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(parseBookRow);

  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem, sortBy) : null;

  return {
    items,
    nextCursor,
    hasMore,
  };
}

// Cursor-based paginated list with CTE for O(1) performance
export function listBooksCursor(options: ListOptions = {}): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(options);
}

interface SearchOptions extends ListOptions {
  query: string;
}

// FTS-powered search with cursor pagination
export function searchBooksCursor(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const searchQuery = options.query.trim();

  if (!searchQuery) {
    return listBooksCursor(options);
  }

  // Use FTS5 for fast full-text search
  return ftsSearch(options);
}

// FTS5-powered search
function ftsSearch(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const limit = clampLimit(options.limit);

  // Build FTS query: quote each word and join with AND
  const words = options.query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    return listBooksCursor({ ...options, limit });
  }

  // Escape double quotes and wrap each word as a prefix search
  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");
  return listBooksWithWhere(
    { ...options, limit },
    `WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)`,
    [ftsQuery],
  );
}

export function listBooksByAuthorCursor(
  authorId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM books_authors_link WHERE author = ?)",
    [authorId],
  );
}

export function listBooksBySeriesCursor(
  seriesId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM books_series_link WHERE series = ?)",
    [seriesId],
  );
}

export function listBooksByTagCursor(
  tagId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM books_tags_link WHERE tag = ?)",
    [tagId],
  );
}

export function listBooksByFormatCursor(
  format: string,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM data WHERE format = ?)",
    [format.toUpperCase()],
  );
}

// Get book details by ID
export function getBookByIdOptimized(id: number): BookWithDetails | null {
  const db = getDb();

  const query = `
    WITH book_page AS (
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        isbn_identifier.val as isbn,
        b.uuid,
        b.path
      FROM books b
      LEFT JOIN identifiers isbn_identifier
        ON b.id = isbn_identifier.book
        AND isbn_identifier.type = 'isbn'
      WHERE b.id = ?
    )
    SELECT
      b.id,
      b.title,
      b.sort,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      b.isbn,
      b.uuid,
      b.path,
      s.name as series,
      r.rating,
      p.name as publisher,
      c.text as comments,
      json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
      json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
      json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
    FROM book_page b
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    LEFT JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN tags t ON btl.tag = t.id
    LEFT JOIN data d ON b.id = d.book
    LEFT JOIN books_ratings_link brl ON b.id = brl.book
    LEFT JOIN ratings r ON brl.rating = r.id
    LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
    LEFT JOIN publishers p ON bpl.publisher = p.id
    LEFT JOIN comments c ON b.id = c.book
    GROUP BY b.id
  `;

  const row = db.query(query).get(id) as BookRow | undefined;

  if (!row) return null;

  return parseBookDetailsRow(row);
}

// Get total book count
export function getBookCount(): number {
  const db = getDb();
  const result = db.query("SELECT COUNT(*) as count FROM books").get() as { count: number };
  return result.count;
}

// Get library stats
export function getLibraryStats(): {
  totalBooks: number;
  totalAuthors: number;
  totalSeries: number;
  totalTags: number;
} {
  const db = getDb();

  const stats = db
    .query(
      `SELECT
        (SELECT COUNT(*) FROM books) as totalBooks,
        (SELECT COUNT(*) FROM authors) as totalAuthors,
        (SELECT COUNT(*) FROM series) as totalSeries,
        (SELECT COUNT(*) FROM tags) as totalTags`,
    )
    .get() as { totalBooks: number; totalAuthors: number; totalSeries: number; totalTags: number };

  return stats;
}

interface CatalogOptions {
  cursor?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
}

function encodeCatalogCursor(entry: CatalogEntry): string {
  return Buffer.from(JSON.stringify({ id: entry.id, sort: entry.sort })).toString("base64url");
}

function decodeCatalogCursor(cursor: string): { id: number | string; sort: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString();
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function listCatalogEntries(
  kind: CatalogKind,
  options: CatalogOptions = {},
): CursorPaginatedResult<CatalogEntry> {
  const db = getDb();
  const limit = clampLimit(options.limit);
  const sortOrder = options.sortOrder || "asc";
  const dir = sortOrder.toUpperCase();
  const sortOp = sortOrder === "asc" ? ">" : "<";

  const cursorData = options.cursor ? decodeCatalogCursor(options.cursor) : null;
  if (options.cursor && !cursorData) {
    throw new CursorError("Invalid cursor");
  }
  const cursorWhere = cursorData
    ? `WHERE (sort ${sortOp} ? OR (sort = ? AND id ${sortOp} ?))`
    : "";
  const cursorParams = cursorData ? [cursorData.sort, cursorData.sort, cursorData.id] : [];

  let catalogCte: string;
  switch (kind) {
    case "authors":
      catalogCte = `
        SELECT
          a.id,
          a.name AS title,
          LOWER(COALESCE(a.sort, a.name)) AS sort,
          COUNT(DISTINCT bal.book) AS bookCount
        FROM authors a
        JOIN books_authors_link bal ON a.id = bal.author
        GROUP BY a.id
      `;
      break;
    case "series":
      catalogCte = `
        SELECT
          s.id,
          s.name AS title,
          LOWER(COALESCE(s.sort, s.name)) AS sort,
          COUNT(DISTINCT bsl.book) AS bookCount
        FROM series s
        JOIN books_series_link bsl ON s.id = bsl.series
        GROUP BY s.id
      `;
      break;
    case "tags":
      catalogCte = `
        SELECT
          t.id,
          t.name AS title,
          LOWER(t.name) AS sort,
          COUNT(DISTINCT btl.book) AS bookCount
        FROM tags t
        JOIN books_tags_link btl ON t.id = btl.tag
        GROUP BY t.id
      `;
      break;
    case "formats":
      catalogCte = `
        SELECT
          UPPER(d.format) AS id,
          UPPER(d.format) AS title,
          LOWER(d.format) AS sort,
          COUNT(DISTINCT d.book) AS bookCount
        FROM data d
        GROUP BY UPPER(d.format)
      `;
      break;
  }

  const query = `
    WITH catalog AS (${catalogCte})
    SELECT id, title, sort, bookCount
    FROM catalog
    ${cursorWhere}
    ORDER BY sort ${dir}, id ${dir}
    LIMIT ${limit + 1}
  `;

  const rows = db.query(query).all(...cursorParams) as CatalogEntry[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCatalogCursor(lastItem) : null;

  return { items, nextCursor, hasMore };
}

export function listAuthorsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("authors", options);
}

export function listSeriesCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("series", options);
}

export function listTagsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("tags", options);
}

export function listFormatsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("formats", options);
}

// All tags with book counts, most-popular-first — drives the tag filter UI.
export interface TagSummary {
  id: number;
  name: string;
  bookCount: number;
}

export function listAllTags(limit: number = 2000): TagSummary[] {
  const db = getDb();
  const capped = Math.min(Math.max(Math.floor(limit) || 1, 1), 5000);
  const rows = db
    .query(
      `SELECT
        t.id AS id,
        t.name AS name,
        COUNT(DISTINCT btl.book) AS bookCount
      FROM tags t
      JOIN books_tags_link btl ON t.id = btl.tag
      GROUP BY t.id
      ORDER BY bookCount DESC, t.name COLLATE NOCASE ASC
      LIMIT ?`,
    )
    .all(capped) as TagSummary[];
  return rows;
}

export function getCatalogEntry(kind: CatalogKind, id: number | string): CatalogEntry | null {
  const db = getDb();

  if (kind === "formats") {
    const format = String(id).toUpperCase();
    const row = db
      .query(`
        SELECT
          UPPER(d.format) AS id,
          UPPER(d.format) AS title,
          LOWER(d.format) AS sort,
          COUNT(DISTINCT d.book) AS bookCount
        FROM data d
        WHERE d.format = ?
        GROUP BY UPPER(d.format)
      `)
      .get(format) as CatalogEntry | null;
    return row ?? null;
  }

  const numericId = typeof id === "number" ? id : Number.parseInt(String(id), 10);
  if (!Number.isFinite(numericId)) return null;

  const catalogQueries: Record<Exclude<CatalogKind, "formats">, string> = {
    authors: `
      SELECT
        a.id,
        a.name AS title,
        LOWER(COALESCE(a.sort, a.name)) AS sort,
        COUNT(DISTINCT bal.book) AS bookCount
      FROM authors a
      JOIN books_authors_link bal ON a.id = bal.author
      WHERE a.id = ?
      GROUP BY a.id
    `,
    series: `
      SELECT
        s.id,
        s.name AS title,
        LOWER(COALESCE(s.sort, s.name)) AS sort,
        COUNT(DISTINCT bsl.book) AS bookCount
      FROM series s
      JOIN books_series_link bsl ON s.id = bsl.series
      WHERE s.id = ?
      GROUP BY s.id
    `,
    tags: `
      SELECT
        t.id,
        t.name AS title,
        LOWER(t.name) AS sort,
        COUNT(DISTINCT btl.book) AS bookCount
      FROM tags t
      JOIN books_tags_link btl ON t.id = btl.tag
      WHERE t.id = ?
      GROUP BY t.id
    `,
  };

  const row = db.query(catalogQueries[kind]).get(numericId) as CatalogEntry | null;
  return row ?? null;
}

// Search books by title — uses FTS5 prefix MATCH for O(log n) performance
export function searchBooksByTitle(title: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const cappedLimit = clampLimit(limit, 10, 200);

  const words = title
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");

  const query = `
    SELECT
      b.id,
      b.title,
      b.sort,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      s.name as series,
      r.rating,
      json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
      json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
      json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
    FROM books b
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    LEFT JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN tags t ON btl.tag = t.id
    LEFT JOIN data d ON b.id = d.book
    LEFT JOIN books_ratings_link brl ON b.id = brl.book
    LEFT JOIN ratings r ON brl.rating = r.id
    WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
    GROUP BY b.id
    ORDER BY b.sort ASC
    LIMIT ?
  `;

  const results = db.query(query).all(ftsQuery, cappedLimit) as BookRow[];

  return results.map(parseBookRow);
}

// Search books by author name
export function searchBooksByAuthor(authorName: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const cappedLimit = clampLimit(limit, 10, 200);
  const searchTerm = `%${authorName.trim()}%`;

  const query = `
    SELECT
      b.id,
      b.title,
      b.sort,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      s.name as series,
      r.rating,
      json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
      json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
      json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
    FROM books b
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    LEFT JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN tags t ON btl.tag = t.id
    LEFT JOIN data d ON b.id = d.book
    LEFT JOIN books_ratings_link brl ON b.id = brl.book
    LEFT JOIN ratings r ON brl.rating = r.id
    WHERE b.id IN (
      SELECT bal2.book
      FROM books_authors_link bal2
      JOIN authors a2 ON bal2.author = a2.id
      WHERE a2.name LIKE ? OR a2.sort LIKE ?
    )
    GROUP BY b.id
    ORDER BY b.sort ASC
    LIMIT ?
  `;

  const results = db.query(query).all(searchTerm, searchTerm, cappedLimit) as BookRow[];

  return results.map(parseBookRow);
}

// Get author info by name
export function getAuthorByName(authorName: string): { name: string; bookCount: number } | null {
  const db = getDb();
  const searchTerm = `%${authorName.trim()}%`;

  const query = `
    SELECT a.name, COUNT(bal.book) as book_count
    FROM authors a
    LEFT JOIN books_authors_link bal ON a.id = bal.author
    WHERE a.name LIKE ? OR a.sort LIKE ?
    GROUP BY a.id
    ORDER BY book_count DESC
    LIMIT 1
  `;

  const result = db.query(query).get(searchTerm, searchTerm) as {
    name: string;
    book_count: number;
  } | null;

  if (!result) return null;

  return {
    name: result.name,
    bookCount: result.book_count,
  };
}

// Stream books in chunks for massive exports
export async function* streamBooks(
  batchSize: number = 1000,
): AsyncGenerator<BookListItem[], void, unknown> {
  activeStreams += 1;

  try {
    const db = getDb();
    const effectiveBatchSize = clampLimit(batchSize, 1000, 5000);
    let lastId = 0;
    while (true) {
      const query = `
      WITH book_page AS (
        SELECT
          b.id,
          b.title,
          b.sort,
          b.author_sort,
          b.series_index,
          b.has_cover,
          b.pubdate,
          b.timestamp
        FROM books b
        WHERE b.id > ?
        ORDER BY b.id ASC
        LIMIT ?
      )
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        s.name as series,
        r.rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM book_page b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      GROUP BY b.id
      ORDER BY b.id ASC
    `;

      const rows = db.query(query).all(lastId, effectiveBatchSize) as BookRow[];

      if (rows.length === 0) break;

      const items = rows.map(parseBookRow);
      const lastItem = items[items.length - 1];
      if (!lastItem) break;
      lastId = lastItem.id;

      yield items;

      if (rows.length < effectiveBatchSize) break;
    }
  } finally {
    activeStreams -= 1;
    if (activeStreams === 0 && refreshPending) {
      refreshPending = false;
      try {
        runRefresh();
      } catch (error) {
        console.error("🔄 Deferred database refresh failed:", error instanceof Error ? error.message : error);
      }
    }
  }
}

// Get file paths for downloads
export function getLibraryPath(): string {
  return LIBRARY_PATH;
}

export function getBookTitle(id: number): string | null {
  const db = getDb();
  const row = db.query("SELECT title FROM books WHERE id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

export function getBookFormatPath(bookId: number, format: string): string | null {
  const db = getDb();

  const row = db
    .query(`
    SELECT b.path, d.name
    FROM books b
    JOIN data d ON b.id = d.book
    WHERE b.id = ? AND d.format = ?
  `)
    .get(bookId, format.toUpperCase()) as { path: string; name: string } | undefined;

  if (!row) return null;

  const ext = format.toLowerCase();
  const filePath = join(LIBRARY_PATH, row.path, `${row.name}.${ext}`);
  if (!isSafeLibraryPath(filePath)) return null;
  return filePath;
}

export function getBookCoverPath(bookId: number): string | null {
  const db = getDb();

  const row = db.query("SELECT path, has_cover FROM books WHERE id = ?").get(bookId) as
    | { path: string; has_cover: number }
    | undefined;

  if (!row || !row.has_cover) return null;

  const filePath = join(LIBRARY_PATH, row.path, "cover.jpg");
  if (!isSafeLibraryPath(filePath)) return null;
  return filePath;
}
