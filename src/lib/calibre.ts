import { Database } from "bun:sqlite";
import { join } from "node:path";

const LIBRARY_PATH =
  process.env.CALIBRE_LIBRARY_PATH ?? "/Users/bsunter/Calibre Library";
const DB_PATH = join(LIBRARY_PATH, "metadata.db");

export interface Book {
  id: number;
  title: string;
  sort: string | null;
  timestamp: string;
  pubdate: string;
  series_index: number;
  author_sort: string | null;
  isbn: string;
  lccn: string;
  path: string;
  flags: number;
  uuid: string;
  has_cover: boolean;
  last_modified: string;
  authors?: string[];
  formats?: BookFormat[];
  tags?: string[];
  series?: string | null;
  publisher?: string | null;
  rating?: number | null;
  comments?: string | null;
}

export interface BookFormat {
  id: number;
  book: number;
  format: string;
  uncompressed_size: number;
  name: string;
}

export interface BookListResult {
  books: Book[];
  total: number;
  page: number;
  perPage: number;
}

let db: Database | null = null;

// Prepared statement cache for frequently used queries
const statementCache = new Map<string, ReturnType<Database["query"]>>();

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    // Note: PRAGMAs that require write access cannot be used with readonly database
    // The following are set via connection options instead:
    // - cache_size is managed by SQLite automatically
    // - temp_store defaults to memory for in-memory databases
  }
  return db;
}

/**
 * Get or create a cached prepared statement
 */
function getCachedStatement(sql: string): ReturnType<Database["query"]> {
  if (!statementCache.has(sql)) {
    const database = getDb();
    statementCache.set(sql, database.query(sql));
  }
  return statementCache.get(sql)!;
}

/**
 * Clear the prepared statement cache
 */
export function clearStatementCache(): void {
  statementCache.clear();
}

export function getLibraryPath(): string {
  return LIBRARY_PATH;
}

export function getBookPath(book: Book): string {
  return join(LIBRARY_PATH, book.path);
}

export function getCoverPath(book: Book): string | null {
  if (!book.has_cover) return null;
  return join(LIBRARY_PATH, book.path, "cover.jpg");
}

export function getFormatPath(book: Book, format: string): string | null {
  const formatInfo = book.formats?.find(f => f.format === format.toUpperCase());
  if (!formatInfo) return null;

  const ext = format.toLowerCase();
  return join(LIBRARY_PATH, book.path, `${formatInfo.name}.${ext}`);
}

export function listBooks(page: number = 1, perPage: number = 20): BookListResult {
  const db = getDb();
  const offset = (page - 1) * perPage;

  const totalRow = getCachedStatement("SELECT COUNT(*) as count FROM books").get() as { count: number };
  const total = totalRow.count;

  const books = getCachedStatement(
    `SELECT * FROM books ORDER BY sort, title LIMIT ? OFFSET ?`
  ).all(perPage, offset) as Book[];

  for (const book of books) {
    book.authors = getBookAuthors(book.id);
    book.formats = getBookFormats(book.id);
    book.tags = getBookTags(book.id);
    book.series = getBookSeries(book.id);
  }

  return { books, total, page, perPage };
}

export function searchBooks(query: string, page: number = 1, perPage: number = 20): BookListResult {
  const db = getDb();
  const offset = (page - 1) * perPage;
  const searchTerm = `%${query}%`;

  const totalRow = getCachedStatement(
    `SELECT COUNT(DISTINCT books.id) as count
     FROM books
     LEFT JOIN books_authors_link ON books.id = books_authors_link.book
     LEFT JOIN authors ON books_authors_link.author = authors.id
     WHERE books.title LIKE ? OR authors.name LIKE ?`
  ).get(searchTerm, searchTerm) as { count: number };

  const total = totalRow.count;

  const books = getCachedStatement(
    `SELECT DISTINCT books.*
     FROM books
     LEFT JOIN books_authors_link ON books.id = books_authors_link.book
     LEFT JOIN authors ON books_authors_link.author = authors.id
     WHERE books.title LIKE ? OR authors.name LIKE ?
     ORDER BY books.sort, books.title
     LIMIT ? OFFSET ?`
  ).all(searchTerm, searchTerm, perPage, offset) as Book[];

  for (const book of books) {
    book.authors = getBookAuthors(book.id);
    book.formats = getBookFormats(book.id);
    book.tags = getBookTags(book.id);
    book.series = getBookSeries(book.id);
  }

  return { books, total, page, perPage };
}

export interface BookWithDetails extends Book {
  authors: string[];
  formats: BookFormat[];
  tags: string[];
  series: string | null;
  publisher: string | null;
  rating: number | null;
  comments: string | null;
}

export function getBookById(id: number): BookWithDetails | null {
  const db = getDb();
  const book = getCachedStatement("SELECT * FROM books WHERE id = ?").get(id) as Book | undefined;

  if (!book) return null;

  return {
    ...book,
    authors: getBookAuthors(id),
    formats: getBookFormats(id),
    tags: getBookTags(id),
    series: getBookSeries(id),
    publisher: getBookPublisher(id),
    rating: getBookRating(id),
    comments: getBookComments(id),
  };
}

export function getBookAuthors(bookId: number): string[] {
  const db = getDb();
  const rows = getCachedStatement(
    `SELECT authors.name
     FROM authors
     JOIN books_authors_link ON authors.id = books_authors_link.author
     WHERE books_authors_link.book = ?
     ORDER BY books_authors_link.id`
  ).all(bookId) as { name: string }[];

  return rows.map(r => r.name);
}

export function getBookFormats(bookId: number): BookFormat[] {
  const db = getDb();
  return getCachedStatement(
    `SELECT * FROM data WHERE book = ? ORDER BY format`
  ).all(bookId) as BookFormat[];
}

export function getBookTags(bookId: number): string[] {
  const db = getDb();
  const rows = getCachedStatement(
    `SELECT tags.name
     FROM tags
     JOIN books_tags_link ON tags.id = books_tags_link.tag
     WHERE books_tags_link.book = ?
     ORDER BY books_tags_link.id`
  ).all(bookId) as { name: string }[];

  return rows.map(r => r.name);
}

export function getBookSeries(bookId: number): string | null {
  const db = getDb();
  const row = getCachedStatement(
    `SELECT series.name
     FROM series
     JOIN books_series_link ON series.id = books_series_link.series
     WHERE books_series_link.book = ?`
  ).get(bookId) as { name: string } | undefined;

  return row?.name || null;
}

export function getBookPublisher(bookId: number): string | null {
  const db = getDb();
  const row = getCachedStatement(
    `SELECT publishers.name
     FROM publishers
     JOIN books_publishers_link ON publishers.id = books_publishers_link.publisher
     WHERE books_publishers_link.book = ?`
  ).get(bookId) as { name: string } | undefined;

  return row?.name || null;
}

export function getBookRating(bookId: number): number | null {
  const db = getDb();
  const row = getCachedStatement(
    `SELECT ratings.rating
     FROM ratings
     JOIN books_ratings_link ON ratings.id = books_ratings_link.rating
     WHERE books_ratings_link.book = ?`
  ).get(bookId) as { rating: number } | undefined;

  return row?.rating || null;
}

export function getBookComments(bookId: number): string | null {
  const db = getDb();
  const row = getCachedStatement(
    `SELECT comments.text
     FROM comments
     WHERE comments.book = ?`
  ).get(bookId) as { text: string } | undefined;

  return row?.text || null;
}

export function bookHasFormat(bookId: number, format: string): boolean {
  const db = getDb();
  const row = getCachedStatement(
    "SELECT 1 FROM data WHERE book = ? AND format = ?"
  ).get(bookId, format.toUpperCase()) as { 1: number } | undefined;

  return !!row;
}
