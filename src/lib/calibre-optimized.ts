import { Database } from "bun:sqlite";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

// Calibre library path (set CALIBRE_LIBRARY_PATH env var to your library location)
const LIBRARY_PATH = process.env.CALIBRE_LIBRARY_PATH || join(homedir(), "Calibre Library");
const DB_NAME = process.env.CALIBRE_DB_NAME || "metadata.db";
const DB_PATH = join(LIBRARY_PATH, DB_NAME);

// Writable copy in ~/.config/caliber for FTS support
const WORK_DIR = join(homedir(), ".config", "caliber");
const WRITABLE_DB_PATH = join(WORK_DIR, "metadata.db");

function copyDbToWritable(): void {
  mkdirSync(WORK_DIR, { recursive: true });
  copyFileSync(DB_PATH, WRITABLE_DB_PATH);
  console.log(`📋 Copied database to ${WRITABLE_DB_PATH}`);
}

// Connection pool for concurrent requests
const dbPool: Database[] = [];
const MAX_POOL_SIZE = 5;

export interface BookListItem {
  id: number;
  title: string;
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
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

// Ensure writable DB exists and is up-to-date with the source Calibre DB
function ensureWritableDb(): void {
  if (!existsSync(WRITABLE_DB_PATH)) {
    copyDbToWritable();
    return;
  }
  // Refresh if source DB is newer than the writable copy
  try {
    const srcMtime = statSync(DB_PATH).mtimeMs;
    const dstMtime = statSync(WRITABLE_DB_PATH).mtimeMs;
    if (srcMtime > dstMtime) {
      copyDbToWritable();
      dbPool.length = 0;
    }
  } catch {
    // If stat fails, leave existing copy in place
  }
}

// Get database connection from pool or create new one
function getDb(): Database {
  if (dbPool.length === 0) {
    ensureWritableDb();
  }
  // Simple round-robin: return a db from the pool
  if (dbPool.length < MAX_POOL_SIZE) {
    const db = new Database(WRITABLE_DB_PATH);
    // Optimize for read-heavy workload
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

// Initialize FTS5 virtual table on writable copy
export function initFTS(): void {
  copyDbToWritable();
  dbPool.length = 0;
  const db = getDb();

  // Add indexes for sort performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_sort ON books(sort, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_author_sort ON books(author_sort, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_timestamp ON books(timestamp, id);`);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      title,
      author_sort,
      content='books',
      content_rowid='id'
    );
  `);

  // Always rebuild to ensure FTS content-sync table is populated correctly
  console.log("🔍 Building FTS index...");
  db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild');`);
  const total = db.query("SELECT COUNT(*) as count FROM books_fts").get() as { count: number };
  console.log(`🔍 FTS index ready (${total.count} books)`);

  // Warm up: run initial query to populate mmap/cache
  console.log("🔥 Warming up database...");
  db.query("SELECT COUNT(*) FROM books").get();
  db.query(`
    SELECT b.id FROM books b
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN data d ON b.id = d.book
    ORDER BY b.sort ASC LIMIT 1
  `).get();
  console.log("🔥 Database warm");
}

// Parse book row with aggregated fields
function parseBookRow(row: BookRow): BookListItem {
  return {
    id: row.id,
    title: row.title,
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
    isbn: row.isbn,
    uuid: row.uuid,
    path: row.path,
  };
}

// Encode cursor from book data
function encodeCursor(book: BookListItem, sortField: string): string {
  let sortVal: string | number;
  switch (sortField) {
    case "title":
      sortVal = book.title.toLowerCase();
      break;
    case "author":
      sortVal = (book.author_sort || "").toLowerCase();
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
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

interface ListOptions {
  cursor?: string;
  limit?: number;
  sortBy?: "title" | "author" | "added" | "rating";
  sortOrder?: "asc" | "desc";
}

// Cursor-based paginated list with CTE for O(1) performance
export function listBooksCursor(options: ListOptions = {}): CursorPaginatedResult<BookListItem> {
  const db = getDb();
  const limit = Math.min(options.limit || 100, 200);
  const sortBy = options.sortBy || "title";
  const sortOrder = options.sortOrder || "asc";

  let bookWhere = "WHERE 1=1";
  const params: (string | number)[] = [];

  if (options.cursor) {
    const cursorData = decodeCursor(options.cursor);
    if (cursorData) {
      const sortOp = sortOrder === "asc" ? ">" : "<";
      if (sortBy === "title") {
        bookWhere += ` AND (b.sort ${sortOp} ? OR (b.sort = ? AND b.id ${sortOp} ?))`;
        params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
      } else if (sortBy === "author") {
        bookWhere += ` AND (b.author_sort ${sortOp} ? OR (b.author_sort = ? AND b.id ${sortOp} ?))`;
        params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
      } else {
        bookWhere += ` AND b.id ${sortOp} ?`;
        params.push(cursorData.id);
      }
    }
  }

  // Build ORDER BY for books CTE
  let bookOrderBy = "";
  switch (sortBy) {
    case "title":
      bookOrderBy = `ORDER BY b.sort ${sortOrder.toUpperCase()}, b.id ${sortOrder.toUpperCase()}`;
      break;
    case "author":
      bookOrderBy = `ORDER BY b.author_sort ${sortOrder.toUpperCase()}, b.id ${sortOrder.toUpperCase()}`;
      break;
    case "added":
      bookOrderBy = `ORDER BY b.timestamp ${sortOrder.toUpperCase()}, b.id ${sortOrder.toUpperCase()}`;
      break;
    case "rating":
      bookOrderBy = `ORDER BY b.id ${sortOrder.toUpperCase()}`; // Fallback for rating
      break;
    default:
      bookOrderBy = `ORDER BY b.sort ASC, b.id ASC`;
  }

  // Lightweight list query — only fields needed for list/grid view
  const query = `
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
      GROUP_CONCAT(DISTINCT a.name) as authors,
      GROUP_CONCAT(DISTINCT t.name) as tags,
      GROUP_CONCAT(DISTINCT d.format) as formats
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

interface SearchOptions extends ListOptions {
  query: string;
}

// Helper function to build lightweight list query with CTE
function buildBookQuery(bookWhere: string, bookOrderBy: string, limit: number): string {
  return `
    WITH book_page AS (
      SELECT b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp
      FROM books b
      ${bookWhere}
      ${bookOrderBy}
      LIMIT ${limit}
    )
    SELECT
      b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover, b.pubdate, b.timestamp,
      s.name as series,
      r.rating,
      GROUP_CONCAT(DISTINCT a.name) as authors,
      GROUP_CONCAT(DISTINCT t.name) as tags,
      GROUP_CONCAT(DISTINCT d.format) as formats
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
  const db = getDb();
  const limit = Math.min(options.limit || 100, 200);

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
  const params: (string | number)[] = [ftsQuery];

  let bookWhere = `WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)`;

  const sortBy = options.sortBy || "title";
  const sortOrder = options.sortOrder || "asc";
  const dir = sortOrder.toUpperCase();

  if (options.cursor) {
    const cursorData = decodeCursor(options.cursor);
    if (cursorData) {
      if (sortBy === "title") {
        const sortOp = sortOrder === "asc" ? ">" : "<";
        bookWhere += ` AND (b.sort ${sortOp} ? OR (b.sort = ? AND b.id ${sortOp} ?))`;
        params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
      } else if (sortBy === "author") {
        const sortOp = sortOrder === "asc" ? ">" : "<";
        bookWhere += ` AND (b.author_sort ${sortOp} ? OR (b.author_sort = ? AND b.id ${sortOp} ?))`;
        params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
      } else {
        const sortOp = sortOrder === "asc" ? ">" : "<";
        bookWhere += ` AND b.id ${sortOp} ?`;
        params.push(cursorData.id);
      }
    }
  }

  let bookOrderBy: string;
  switch (sortBy) {
    case "author":
      bookOrderBy = `ORDER BY b.author_sort ${dir}, b.id ${dir}`;
      break;
    case "added":
      bookOrderBy = `ORDER BY b.timestamp ${dir}, b.id ${dir}`;
      break;
    case "rating":
      bookOrderBy = `ORDER BY b.id ${dir}`;
      break;
    default:
      bookOrderBy = `ORDER BY b.sort ${dir}, b.id ${dir}`;
  }
  const query = buildBookQuery(bookWhere, bookOrderBy, limit + 1);
  const rows = db.query(query).all(...params) as BookRow[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(parseBookRow);
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem, sortBy) : null;

  return { items, nextCursor, hasMore };
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
        b.isbn,
        b.uuid,
        b.path
      FROM books b
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
      GROUP_CONCAT(DISTINCT a.name) as authors,
      GROUP_CONCAT(DISTINCT t.name) as tags,
      GROUP_CONCAT(DISTINCT d.format) as formats
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

// Search books by title only
export function searchBooksByTitle(title: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const searchTerm = `%${title.trim()}%`;

  const query = `
    SELECT
      b.id,
      b.title,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      s.name as series,
      r.rating,
      GROUP_CONCAT(DISTINCT a.name) as authors,
      GROUP_CONCAT(DISTINCT t.name) as tags,
      GROUP_CONCAT(DISTINCT d.format) as formats
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
    WHERE b.title LIKE ?
    GROUP BY b.id
    ORDER BY b.sort ASC
    LIMIT ?
  `;

  const results = db.query(query).all(searchTerm, limit) as BookRow[];

  return results.map(parseBookRow);
}

// Search books by author name
export function searchBooksByAuthor(authorName: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const searchTerm = `%${authorName.trim()}%`;

  const query = `
    SELECT
      b.id,
      b.title,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      s.name as series,
      r.rating,
      GROUP_CONCAT(DISTINCT a.name) as authors,
      GROUP_CONCAT(DISTINCT t.name) as tags,
      GROUP_CONCAT(DISTINCT d.format) as formats
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

  const results = db.query(query).all(searchTerm, searchTerm, limit) as BookRow[];

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
  const db = getDb();
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
          b.timestamp,
          b.isbn,
          b.uuid,
          b.path
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
        b.isbn,
        b.uuid,
        b.path,
        s.name as series,
        r.rating,
        p.name as publisher,
        c.text as comments,
        GROUP_CONCAT(DISTINCT a.name) as authors,
        GROUP_CONCAT(DISTINCT t.name) as tags,
        GROUP_CONCAT(DISTINCT d.format) as formats
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
      ORDER BY b.id ASC
    `;

    const rows = db.query(query).all(lastId, batchSize) as BookRow[];

    if (rows.length === 0) break;

    const items = rows.map(parseBookRow);
    const lastItem = items[items.length - 1];
    if (!lastItem) break;
    lastId = lastItem.id;

    yield items;

    if (rows.length < batchSize) break;
  }
}

// Get file paths for downloads
export function getLibraryPath(): string {
  return LIBRARY_PATH;
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
  return join(LIBRARY_PATH, row.path, `${row.name}.${ext}`);
}

export function getBookCoverPath(bookId: number): string | null {
  const db = getDb();

  const row = db.query("SELECT path, has_cover FROM books WHERE id = ?").get(bookId) as
    | { path: string; has_cover: number }
    | undefined;

  if (!row || !row.has_cover) return null;

  return join(LIBRARY_PATH, row.path, "cover.jpg");
}
