import { Database } from "bun:sqlite";
import type {
  Book,
  Author,
  Tag,
  Series,
  Publisher,
  Rating,
  BookFormat,
  BookWithMetadata,
  BookListItem,
} from "../types/calibre";

// Path to the Calibre library metadata database
const CALIBRE_LIBRARY_PATH =
  process.env.CALIBRE_LIBRARY_PATH ?? "/Users/bsunter/Calibre Library/metadata.db";

// Singleton database instance
let db: Database | null = null;

// Prepared statement cache
const statementCache = new Map<string, ReturnType<Database["query"]>>();

/**
 * Get the database connection (singleton)
 * Configured with performance optimizations for read-heavy workloads
 */
export function getDatabase(): Database {
  if (!db) {
    db = new Database(CALIBRE_LIBRARY_PATH, { readonly: true });
    // Enable foreign keys
    db.run("PRAGMA foreign_keys = ON");
    // Performance optimizations for read-heavy workloads
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -64000"); // 64MB cache
    db.run("PRAGMA temp_store = MEMORY");
    db.run("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
  }
  return db;
}

/**
 * Get or create a cached prepared statement
 */
function getCachedStatement(sql: string): ReturnType<Database["query"]> {
  if (!statementCache.has(sql)) {
    const database = getDatabase();
    statementCache.set(sql, database.query(sql));
  }
  return statementCache.get(sql)!;
}

/**
 * Clear the statement cache (useful for testing or memory management)
 */
export function clearStatementCache(): void {
  statementCache.clear();
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get all books with basic metadata
 */
export function getBooks(limit: number = 100, offset: number = 0): BookListItem[] {
  const _database = getDatabase();

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
      (
        SELECT GROUP_CONCAT(a.name, ', ')
        FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE bal.book = b.id
      ) as authors,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM books_tags_link btl
        JOIN tags t ON btl.tag = t.id
        WHERE btl.book = b.id
      ) as tags,
      (
        SELECT GROUP_CONCAT(d.format, ', ')
        FROM data d
        WHERE d.book = b.id
      ) as formats
    FROM books b
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    ORDER BY b.sort COLLATE NOCASE
    LIMIT ? OFFSET ?
  `;

  const stmt = getCachedStatement(query);
  const rows = stmt.all(limit, offset) as Array<{
    id: number;
    title: string;
    author_sort: string | null;
    series_index: number;
    has_cover: boolean;
    pubdate: string;
    timestamp: string;
    series: string | null;
    authors: string | null;
    tags: string | null;
    formats: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(", ") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(", ") : [],
    formats: row.formats ? row.formats.split(", ") : [],
    has_cover: row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
  }));
}

/**
 * Search books across title, author, and tags
 */
export function searchBooks(
  query: string,
  limit: number = 100,
  offset: number = 0
): BookListItem[] {
  const _database = getDatabase();

  const searchQuery = `%${query}%`;

  const sql = `
    SELECT DISTINCT
      b.id,
      b.title,
      b.author_sort,
      b.series_index,
      b.has_cover,
      b.pubdate,
      b.timestamp,
      s.name as series,
      (
        SELECT GROUP_CONCAT(a.name, ', ')
        FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE bal.book = b.id
      ) as authors,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM books_tags_link btl
        JOIN tags t ON btl.tag = t.id
        WHERE btl.book = b.id
      ) as tags,
      (
        SELECT GROUP_CONCAT(d.format, ', ')
        FROM data d
        WHERE d.book = b.id
      ) as formats
    FROM books b
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    LEFT JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN authors a ON bal.author = a.id
    LEFT JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN tags t ON btl.tag = t.id
    WHERE
      b.title LIKE ? COLLATE NOCASE
      OR b.sort LIKE ? COLLATE NOCASE
      OR a.name LIKE ? COLLATE NOCASE
      OR t.name LIKE ? COLLATE NOCASE
    ORDER BY b.sort COLLATE NOCASE
    LIMIT ? OFFSET ?
  `;

  const stmt = getCachedStatement(sql);
  const rows = stmt.all(
    searchQuery,
    searchQuery,
    searchQuery,
    searchQuery,
    limit,
    offset
  ) as Array<{
    id: number;
    title: string;
    author_sort: string | null;
    series_index: number;
    has_cover: boolean;
    pubdate: string;
    timestamp: string;
    series: string | null;
    authors: string | null;
    tags: string | null;
    formats: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(", ") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(", ") : [],
    formats: row.formats ? row.formats.split(", ") : [],
    has_cover: row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
  }));
}

/**
 * Get a single book by ID with full metadata
 */
export function getBookById(id: number): BookWithMetadata | null {
  const _database = getDatabase();

  // Get the book
  const bookStmt = getCachedStatement("SELECT * FROM books WHERE id = ?");
  const book = bookStmt.get(id) as Book | undefined;

  if (!book) {
    return null;
  }

  // Get authors
  const authorsStmt = getCachedStatement(`
    SELECT a.* FROM authors a
    JOIN books_authors_link bal ON a.id = bal.author
    WHERE bal.book = ?
    ORDER BY bal.id
  `);
  const authors = authorsStmt.all(id) as Author[];

  // Get tags
  const tagsStmt = getCachedStatement(`
    SELECT t.* FROM tags t
    JOIN books_tags_link btl ON t.id = btl.tag
    WHERE btl.book = ?
  `);
  const tags = tagsStmt.all(id) as Tag[];

  // Get series
  const seriesStmt = getCachedStatement(`
    SELECT s.* FROM series s
    JOIN books_series_link bsl ON s.id = bsl.series
    WHERE bsl.book = ?
  `);
  const series = (seriesStmt.get(id) as Series | undefined) ?? null;

  // Get publisher
  const publisherStmt = getCachedStatement(`
    SELECT p.* FROM publishers p
    JOIN books_publishers_link bpl ON p.id = bpl.publisher
    WHERE bpl.book = ?
  `);
  const publisher = (publisherStmt.get(id) as Publisher | undefined) ?? null;

  // Get rating
  const ratingStmt = getCachedStatement(`
    SELECT r.* FROM ratings r
    JOIN books_ratings_link brl ON r.id = brl.rating
    WHERE brl.book = ?
  `);
  const rating = (ratingStmt.get(id) as Rating | undefined) ?? null;

  // Get formats
  const formatsStmt = getCachedStatement(`
    SELECT * FROM data WHERE book = ? ORDER BY format
  `);
  const formats = formatsStmt.all(id) as BookFormat[];

  // Get comments
  const commentsStmt = getCachedStatement("SELECT text FROM comments WHERE book = ?");
  const commentsRow = commentsStmt.get(id) as { text: string } | undefined;
  const comments = commentsRow?.text ?? null;

  return {
    ...book,
    authors: authors.map((author) => author.name),
    tags: tags.map((tag) => tag.name),
    series: series?.name ?? null,
    publisher: publisher?.name ?? null,
    rating: rating?.rating ?? null,
    formats,
    comments,
  };
}

/**
 * Get formats for a specific book
 */
export function getBookFormats(bookId: number): BookFormat[] {
  const _database = getDatabase();

  const stmt = getCachedStatement(`
    SELECT * FROM data WHERE book = ? ORDER BY format
  `);

  return stmt.all(bookId) as BookFormat[];
}

/**
 * Get total count of books
 */
export function getBookCount(): number {
  const _database = getDatabase();

  const stmt = getCachedStatement("SELECT COUNT(*) as count FROM books");
  const result = stmt.get() as { count: number };

  return result.count;
}

/**
 * Get all authors with book counts
 */
export function getAuthors(): Array<Author & { bookCount: number }> {
  const _database = getDatabase();

  const stmt = getCachedStatement(`
    SELECT
      a.*,
      (SELECT COUNT(*) FROM books_authors_link WHERE author = a.id) as bookCount
    FROM authors a
    ORDER BY a.sort COLLATE NOCASE
  `);

  return stmt.all() as Array<Author & { bookCount: number }>;
}

/**
 * Get all tags with book counts
 */
export function getTags(): Array<Tag & { bookCount: number }> {
  const _database = getDatabase();

  const stmt = getCachedStatement(`
    SELECT
      t.*,
      (SELECT COUNT(*) FROM books_tags_link WHERE tag = t.id) as bookCount
    FROM tags t
    ORDER BY t.name COLLATE NOCASE
  `);

  return stmt.all() as Array<Tag & { bookCount: number }>;
}

/**
 * Get all series with book counts
 */
export function getSeries(): Array<Series & { bookCount: number }> {
  const _database = getDatabase();

  const stmt = getCachedStatement(`
    SELECT
      s.*,
      (SELECT COUNT(*) FROM books_series_link WHERE series = s.id) as bookCount
    FROM series s
    ORDER BY s.sort COLLATE NOCASE
  `);

  return stmt.all() as Array<Series & { bookCount: number }>;
}

/**
 * Get books by author ID
 */
export function getBooksByAuthor(authorId: number): BookListItem[] {
  const _database = getDatabase();

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
      (
        SELECT GROUP_CONCAT(a.name, ', ')
        FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE bal.book = b.id
      ) as authors,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM books_tags_link btl
        JOIN tags t ON btl.tag = t.id
        WHERE btl.book = b.id
      ) as tags,
      (
        SELECT GROUP_CONCAT(d.format, ', ')
        FROM data d
        WHERE d.book = b.id
      ) as formats
    FROM books b
    JOIN books_authors_link bal ON b.id = bal.book
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    WHERE bal.author = ?
    ORDER BY b.sort COLLATE NOCASE
  `;

  const stmt = getCachedStatement(query);
  const rows = stmt.all(authorId) as Array<{
    id: number;
    title: string;
    author_sort: string | null;
    series_index: number;
    has_cover: boolean;
    pubdate: string;
    timestamp: string;
    series: string | null;
    authors: string | null;
    tags: string | null;
    formats: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(", ") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(", ") : [],
    formats: row.formats ? row.formats.split(", ") : [],
    has_cover: row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
  }));
}

/**
 * Get books by tag ID
 */
export function getBooksByTag(tagId: number): BookListItem[] {
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
      (
        SELECT GROUP_CONCAT(a.name, ', ')
        FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE bal.book = b.id
      ) as authors,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM books_tags_link btl
        JOIN tags t ON btl.tag = t.id
        WHERE btl.book = b.id
      ) as tags,
      (
        SELECT GROUP_CONCAT(d.format, ', ')
        FROM data d
        WHERE d.book = b.id
      ) as formats
    FROM books b
    JOIN books_tags_link btl ON b.id = btl.book
    LEFT JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    WHERE btl.tag = ?
    ORDER BY b.sort COLLATE NOCASE
  `;

  const stmt = getCachedStatement(query);
  const rows = stmt.all(tagId) as Array<{
    id: number;
    title: string;
    author_sort: string | null;
    series_index: number;
    has_cover: boolean;
    pubdate: string;
    timestamp: string;
    series: string | null;
    authors: string | null;
    tags: string | null;
    formats: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(", ") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(", ") : [],
    formats: row.formats ? row.formats.split(", ") : [],
    has_cover: row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
  }));
}

/**
 * Get books by series ID
 */
export function getBooksBySeries(seriesId: number): BookListItem[] {
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
      (
        SELECT GROUP_CONCAT(a.name, ', ')
        FROM books_authors_link bal
        JOIN authors a ON bal.author = a.id
        WHERE bal.book = b.id
      ) as authors,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM books_tags_link btl
        JOIN tags t ON btl.tag = t.id
        WHERE btl.book = b.id
      ) as tags,
      (
        SELECT GROUP_CONCAT(d.format, ', ')
        FROM data d
        WHERE d.book = b.id
      ) as formats
    FROM books b
    JOIN books_series_link bsl ON b.id = bsl.book
    LEFT JOIN series s ON bsl.series = s.id
    WHERE bsl.series = ?
    ORDER BY b.series_index, b.sort COLLATE NOCASE
  `;

  const stmt = getCachedStatement(query);
  const rows = stmt.all(seriesId) as Array<{
    id: number;
    title: string;
    author_sort: string | null;
    series_index: number;
    has_cover: boolean;
    pubdate: string;
    timestamp: string;
    series: string | null;
    authors: string | null;
    tags: string | null;
    formats: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author_sort: row.author_sort,
    authors: row.authors ? row.authors.split(", ") : [],
    series: row.series,
    series_index: row.series_index,
    tags: row.tags ? row.tags.split(", ") : [],
    formats: row.formats ? row.formats.split(", ") : [],
    has_cover: row.has_cover,
    pubdate: row.pubdate,
    timestamp: row.timestamp,
  }));
}
