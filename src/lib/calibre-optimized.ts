import { Database } from "bun:sqlite";
import { join } from "path";

// Use Desktop Calibre library
const LIBRARY_PATH = process.env.CALIBRE_LIBRARY_PATH || "/Users/bsunter/Desktop";
const DB_NAME = process.env.CALIBRE_DB_NAME || "metadata.db";
const DB_PATH = join(LIBRARY_PATH, DB_NAME);

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

// Get database connection from pool or create new one
function getDb(): Database {
  // Simple round-robin: return a db from the pool
  if (dbPool.length < MAX_POOL_SIZE) {
    const db = new Database(DB_PATH, { readonly: true });
    // Optimize for read-heavy workload (these are connection-level settings that work with readonly)
    try {
      db.exec("PRAGMA cache_size = -64000;"); // 64MB cache
      db.exec("PRAGMA temp_store = memory;");
      db.exec("PRAGMA mmap_size = 268435456;"); // 256MB memory map
    } catch {
      // Ignore if these fail
    }
    dbPool.push(db);
    return db;
  }
  // Round-robin through pool
  const db = dbPool[Math.floor(Math.random() * dbPool.length)]!;
  return db;
}

// Initialize FTS5 virtual table if not exists
export function initFTS(): void {
  // FTS requires write access, skip if readonly
  console.log("FTS initialization skipped (requires write access)");
}

// Build the optimized query using CTE for fast pagination
// This avoids scanning the entire table when using OFFSET/Cursor
function getPagedBooksCTE(
  whereClause: string,
  orderByClause: string,
  limit: number
): string {
  return `
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
      ${whereClause}
      ${orderByClause}
      LIMIT ${limit}
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
    ${orderByClause.replace('b.sort', 'b.title').replace('b.', 'b.').replace('ORDER BY', 'ORDER BY')}
  `;
}

// Parse book row with aggregated fields
function parseBookRow(row: BookRow): BookListItem {
  return {
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(",") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(",") : [],
    formats: row.formats ? row.formats.split(",") : [],
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
  const cursorData = {
    id: book.id,
    sort: sortField === "title" ? book.title.toLowerCase() : book.id,
  };
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
  const limit = Math.min(options.limit || 50, 100);
  const sortBy = options.sortBy || "title";
  const sortOrder = options.sortOrder || "asc";

  let bookWhere = "WHERE 1=1";
  const params: (string | number)[] = [];

  if (options.cursor) {
    const cursorData = decodeCursor(options.cursor);
    if (cursorData) {
      if (sortBy === "title") {
        const sortOp = sortOrder === "asc" ? ">" : "<";
        bookWhere += ` AND (b.sort ${sortOp} ? OR (b.sort = ? AND b.id ${sortOp} ?))`;
        params.push(cursorData.sort as string, cursorData.sort as string, cursorData.id);
      } else {
        const sortOp = sortOrder === "asc" ? ">" : "<";
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

  // Use CTE for efficient pagination
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
      ${bookWhere}
      ${bookOrderBy}
      LIMIT ${limit + 1}
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

// Helper function to build the full query with CTE
function buildBookQuery(
  bookWhere: string,
  bookOrderBy: string,
  limit: number,
  params: (string | number)[]
): string {
  return `
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
      ${bookWhere}
      ${bookOrderBy}
      LIMIT ${limit}
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
    ${bookOrderBy}
  `;
}

// FTS-powered search with cursor pagination
export function searchBooksCursor(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const db = getDb();
  const limit = Math.min(options.limit || 50, 100);
  const searchQuery = options.query.trim();

  if (!searchQuery) {
    return listBooksCursor(options);
  }

  // Use LIKE-based search (fallback since FTS requires write access)
  return fallbackSearch(options);
}

// Fallback LIKE-based search - searches title, author, and series
// Supports multi-word queries - all words must match (AND logic)
function fallbackSearch(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const db = getDb();
  const limit = Math.min(options.limit || 50, 100);

  // Split query into words and create individual search terms
  const words = options.query.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) {
    return listBooksCursor({ ...options, limit });
  }

  // Build WHERE clause that requires ALL words to match (AND logic)
  // Each word can match title, author, OR series
  const wordConditions: string[] = [];
  const params: (string | number)[] = [];

  for (const word of words) {
    const searchTerm = `%${word}%`;
    wordConditions.push(`(
      b.title LIKE ?
      OR b.id IN (
        SELECT bal.book FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE a.name LIKE ? OR a.sort LIKE ?
      )
      OR b.id IN (
        SELECT bsl.book FROM books_series_link bsl
        JOIN series s ON bsl.series = s.id
        WHERE s.name LIKE ?
      )
    )`);
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  let bookWhere = `WHERE ${wordConditions.join(" AND ")}`;

  if (options.cursor) {
    const cursorData = decodeCursor(options.cursor);
    if (cursorData) {
      bookWhere += " AND b.id > ?";
      params.push(cursorData.id);
    }
  }

  const bookOrderBy = `ORDER BY b.sort ASC, b.id ASC`;

  const query = buildBookQuery(bookWhere, bookOrderBy, limit + 1, params);

  const rows = db.query(query).all(...params) as BookRow[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(parseBookRow);

  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem, "title") : null;

  return {
    items,
    nextCursor,
    hasMore,
  };
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

  const books = db.query("SELECT COUNT(*) as count FROM books").get() as { count: number };
  const authors = db.query("SELECT COUNT(*) as count FROM authors").get() as { count: number };
  const series = db.query("SELECT COUNT(*) as count FROM series").get() as { count: number };
  const tags = db.query("SELECT COUNT(*) as count FROM tags").get() as { count: number };

  return {
    totalBooks: books.count,
    totalAuthors: authors.count,
    totalSeries: series.count,
    totalTags: tags.count,
  };
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

  const results = db.query(query).all(searchTerm, limit) as any[];

  return results.map(row => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(",") : [],
    series: row.series,
    series_index: row.series_index || 1,
    tags: row.tags ? row.tags.split(",") : [],
    formats: row.formats ? row.formats.split(",") : [],
    has_cover: !!row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
    rating: row.rating,
  }));
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

  const results = db.query(query).all(searchTerm, searchTerm, limit) as any[];

  return results.map(row => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(",") : [],
    series: row.series,
    series_index: row.series_index || 1,
    tags: row.tags ? row.tags.split(",") : [],
    formats: row.formats ? row.formats.split(",") : [],
    has_cover: !!row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
    rating: row.rating,
  }));
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

  const result = db.query(query).get(searchTerm, searchTerm) as any;

  if (!result) return null;

  return {
    name: result.name,
    bookCount: result.book_count,
  };
}

// Stream books in chunks for massive exports
export async function* streamBooks(
  batchSize: number = 1000
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

  const row = db.query(`
    SELECT b.path, d.name
    FROM books b
    JOIN data d ON b.id = d.book
    WHERE b.id = ? AND d.format = ?
  `).get(bookId, format.toUpperCase()) as { path: string; name: string } | undefined;

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
