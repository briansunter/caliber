/**
 * Unit / integration tests for cursor pagination, rating sort, invalid cursor errors,
 * and FTS search — exercising calibre-optimized.ts directly (no HTTP server).
 *
 * Each test group uses a fresh temp directory so module-level paths are set once
 * via env vars before the dynamic import.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types imported lazily so we don't evaluate calibre-optimized at top-level
// ---------------------------------------------------------------------------
type CalibrerLib = typeof import("../src/lib/calibre-optimized");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface BookSpec {
  id: number;
  title: string;
  sort: string;
  authorSort: string;
  timestamp: string;
  rating?: number;
}

function buildFixtureDb(dbPath: string, books: BookSpec[]): void {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT NOT NULL DEFAULT '');
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      sort TEXT,
      timestamp TEXT,
      pubdate TEXT,
      series_index REAL NOT NULL DEFAULT 1.0,
      author_sort TEXT,
      path TEXT NOT NULL DEFAULT '',
      flags INTEGER NOT NULL DEFAULT 1,
      uuid TEXT NOT NULL DEFAULT '',
      has_cover INTEGER DEFAULT 0,
      last_modified TEXT
    );
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
    CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book, publisher));
    CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT);
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
    CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER NOT NULL UNIQUE);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
  `);

  // Insert distinct ratings rows so we can link books to them
  const ratingValues = [...new Set(books.map((b) => b.rating).filter((r): r is number => r != null))];
  for (const rv of ratingValues) {
    db.run("INSERT OR IGNORE INTO ratings (rating) VALUES (?)", [rv]);
  }

  for (const book of books) {
    db.run(
      `INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
       VALUES (?, ?, ?, ?, '2023-01-01 00:00:00+00:00', 1.0, ?, '', 1, '', 0, ?)`,
      [book.id, book.title, book.sort, book.timestamp, book.authorSort, book.timestamp],
    );

    if (book.rating != null) {
      const ratingRow = db.query("SELECT id FROM ratings WHERE rating = ?").get(book.rating) as
        | { id: number }
        | null;
      if (ratingRow) {
        db.run("INSERT OR IGNORE INTO books_ratings_link (book, rating) VALUES (?, ?)", [
          book.id,
          ratingRow.id,
        ]);
      }
    }
  }

  for (const [id, name] of TAG_FIXTURE) {
    db.run("INSERT INTO tags (id, name) VALUES (?, ?)", [id, name]);
  }
  for (const [book, tag] of TAG_BOOKS) {
    db.run("INSERT INTO books_tags_link (book, tag) VALUES (?, ?)", [book, tag]);
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Shared test environment — one tempDir for all tests in this file.
// We need to import calibre-optimized AFTER setting env vars, so we use a
// module-level lazy reference populated in beforeAll.
// ---------------------------------------------------------------------------

let tempDir = "";
let libraryPath = "";
let configDir = "";
let lib: CalibrerLib;

// 22 books: ids 1-10 ASCII fixtures; ids 11-22 add non-ASCII regression
// coverage where JS `.toLowerCase()` and SQLite's ASCII-only `lower()`
// disagree (É/é, İ, ß, Ü, Å, Æ) — see "non-ASCII" describes below.
const BOOKS: BookSpec[] = [
  { id: 1, title: "Aardvark Tales", sort: "Aardvark Tales", authorSort: "Smith, Alice", timestamp: "2024-01-10 00:00:00+00:00", rating: 10 },
  { id: 2, title: "Banana Dreams", sort: "Banana Dreams", authorSort: "Jones, Bob", timestamp: "2024-01-02 00:00:00+00:00", rating: 8 },
  { id: 3, title: "Cherry Picking", sort: "Cherry Picking", authorSort: "Doe, Carol", timestamp: "2024-01-08 00:00:00+00:00", rating: 8 },
  { id: 4, title: "Dragon Fire", sort: "Dragon Fire", authorSort: "Brown, Dave", timestamp: "2024-01-04 00:00:00+00:00", rating: 6 },
  { id: 5, title: "Elephant Walk", sort: "Elephant Walk", authorSort: "White, Eve", timestamp: "2024-01-06 00:00:00+00:00", rating: 6 },
  { id: 6, title: "Fox Trot", sort: "Fox Trot", authorSort: "Green, Frank", timestamp: "2024-01-01 00:00:00+00:00" },
  { id: 7, title: "Grape Vine", sort: "Grape Vine", authorSort: "Black, Grace", timestamp: "2024-01-09 00:00:00+00:00" },
  { id: 8, title: "Honey Bee", sort: "Honey Bee", authorSort: "Clark, Hank", timestamp: "2024-01-03 00:00:00+00:00", rating: 4 },
  { id: 9, title: "Igloo Nights", sort: "Igloo Nights", authorSort: "Davis, Iris", timestamp: "2024-01-07 00:00:00+00:00", rating: 2 },
  { id: 10, title: "Jungle Book", sort: "Jungle Book", authorSort: "Evans, Jack", timestamp: "2024-01-05 00:00:00+00:00" },
  { id: 11, title: "Alpha", sort: "Alpha", authorSort: "Adams, John", timestamp: "2024-01-13 00:00:00+00:00" },
  { id: 12, title: "Apfel", sort: "Apfel", authorSort: "Böll, Heinrich", timestamp: "2024-01-14 00:00:00+00:00" },
  { id: 13, title: "Banane", sort: "Banane", authorSort: "Céline, Louis-Ferdinand", timestamp: "2024-01-15 00:00:00+00:00" },
  { id: 14, title: "Cidre", sort: "Cidre", authorSort: "Dumas, Alexandre", timestamp: "2024-01-16 00:00:00+00:00" },
  { id: 15, title: "Éclair", sort: "Éclair", authorSort: "Eco, Umberto", timestamp: "2024-01-17 00:00:00+00:00" },
  { id: 16, title: "étagère", sort: "étagère", authorSort: "Foer, Jonathan Safran", timestamp: "2024-01-18 00:00:00+00:00" },
  { id: 17, title: "İstanbul", sort: "İstanbul", authorSort: "Gauguin, Paul", timestamp: "2024-01-19 00:00:00+00:00" },
  { id: 18, title: "Straße", sort: "Straße", authorSort: "Høeg, Peter", timestamp: "2024-01-20 00:00:00+00:00" },
  { id: 19, title: "Überfall", sort: "Überfall", authorSort: "Ibsen, Henrik", timestamp: "2024-01-21 00:00:00+00:00" },
  { id: 20, title: "Zebra", sort: "Zebra", authorSort: "Jansson, Tove", timestamp: "2024-01-22 00:00:00+00:00" },
  { id: 21, title: "Ångström", sort: "Ångström", authorSort: "Knausgård, Karl Ove", timestamp: "2024-01-23 00:00:00+00:00" },
  { id: 22, title: "Ærø", sort: "Ærø", authorSort: "Lagerlöf, Selma", timestamp: "2024-01-24 00:00:00+00:00" },
];

// Tags for the tag-filter (OR) tests. Membership:
//   Fiction (1): books 1,2,3,4   -> count 4
//   History (2): books 3,4,5     -> count 3
//   Sci-Fi  (3): books 5,6       -> count 2
// Union Fiction ∪ History = {1,2,3,4,5} (titles Aardvark..Elephant align with id order).
const TAG_FIXTURE: Array<[number, string]> = [
  [1, "Fiction"],
  [2, "History"],
  [3, "Sci-Fi"],
];
const TAG_BOOKS: Array<[number, number]> = [
  [1, 1], [2, 1], [3, 1], [4, 1], // Fiction
  [3, 2], [4, 2], [5, 2], // History
  [5, 3], [6, 3], // Sci-Fi
];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "caliber-unit-"));
  libraryPath = join(tempDir, "library");
  configDir = join(tempDir, "config");
  mkdirSync(libraryPath, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  buildFixtureDb(join(libraryPath, "metadata.db"), BOOKS);

  // Point calibre-optimized at our temp dirs; must be set before dynamic import.
  // CALIBER_CONFIG_DIR keeps the writable DB copy out of the real ~/.config/caliber.
  process.env.CALIBRE_LIBRARY_PATH = libraryPath;
  process.env.CALIBER_CONFIG_DIR = configDir;

  lib = await import("../src/lib/calibre-optimized") as CalibrerLib;

  lib.initFTS();
}, 30_000);

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: collect all ids from pages following cursors
// ---------------------------------------------------------------------------
function allIds(
  fetchPage: (cursor: string | undefined) => ReturnType<CalibrerLib["listBooksCursor"]>,
  pageSize: number,
): number[] {
  const ids: number[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const result = fetchPage(cursor);
    for (const item of result.items) ids.push(item.id);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return ids;
}

type ListOpts = NonNullable<Parameters<CalibrerLib["listBooksCursor"]>[0]>;

// Follows nextCursor to assemble the full ordered item list.
function collectPages(
  sortBy: NonNullable<ListOpts["sortBy"]>,
  sortOrder: NonNullable<ListOpts["sortOrder"]>,
  pageSize = 5,
): ReturnType<CalibrerLib["listBooksCursor"]>["items"] {
  const items: ReturnType<CalibrerLib["listBooksCursor"]>["items"] = [];
  let cursor: string | undefined = undefined;
  let guard = 0;
  for (;;) {
    const page = lib.listBooksCursor({ limit: pageSize, sortBy, sortOrder, cursor });
    for (const item of page.items) items.push(item);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    guard += 1;
    expect(guard).toBeLessThan(100); // no runaway pagination loops
  }
  return items;
}

// ---------------------------------------------------------------------------
// 1. Cursor round-trip tests
// ---------------------------------------------------------------------------

describe("cursor round-trip: title sort", () => {
  function expectWalkMatchesSingleQuery(sortBy: "title", sortOrder: "asc" | "desc") {
    const walked = collectPages(sortBy, sortOrder);
    const ids = walked.map((b) => b.id);
    expect(ids).toHaveLength(BOOKS.length);
    expect(new Set(ids).size).toBe(BOOKS.length);

    const expected = lib.listBooksCursor({ limit: 200, sortBy, sortOrder }).items.map((b) => b.id);
    expect(ids).toEqual(expected);
  }

  test("asc: walk covers every book once and matches single-query order", () => {
    expectWalkMatchesSingleQuery("title", "asc");
  });

  test("desc: walk covers every book once and matches single-query order", () => {
    expectWalkMatchesSingleQuery("title", "desc");
  });

  test("non-ASCII titles survive page-size-1 boundaries", () => {
    const ids = collectPages("title", "asc", 1).map((b) => b.id);
    const expected = lib.listBooksCursor({ limit: 200, sortBy: "title", sortOrder: "asc" }).items.map(
      (b) => b.id,
    );
    expect(ids).toEqual(expected);
    // Titles whose JS-lowercased key differs from the SQL sort key are present
    expect(ids).toEqual(expect.arrayContaining([15, 16, 17, 18, 19, 21, 22]));
  });
});

describe("cursor round-trip: author sort", () => {
  test("asc: walk covers every book once and matches single-query order", () => {
    const walked = collectPages("author", "asc");
    const ids = walked.map((b) => b.id);
    expect(ids).toHaveLength(BOOKS.length);
    expect(new Set(ids).size).toBe(BOOKS.length);

    const expected = lib.listBooksCursor({ limit: 200, sortBy: "author", sortOrder: "asc" }).items.map(
      (b) => b.id,
    );
    expect(ids).toEqual(expected);
  });

  test("desc: walk covers every book once and matches single-query order", () => {
    const walked = collectPages("author", "desc");
    const ids = walked.map((b) => b.id);
    expect(ids).toHaveLength(BOOKS.length);
    expect(new Set(ids).size).toBe(BOOKS.length);

    const expected = lib.listBooksCursor({ limit: 200, sortBy: "author", sortOrder: "desc" }).items.map(
      (b) => b.id,
    );
    expect(ids).toEqual(expected);
  });

  test("non-ASCII author_sort survives page-size-1 boundaries", () => {
    const ids = collectPages("author", "asc", 1).map((b) => b.id);
    const expected = lib.listBooksCursor({ limit: 200, sortBy: "author", sortOrder: "asc" }).items.map(
      (b) => b.id,
    );
    expect(ids).toEqual(expected);
  });
});

describe("cursor round-trip: added (timestamp) sort", () => {
  test("asc: page1 + page2 no dups, ordering holds", () => {
    const page1 = lib.listBooksCursor({ limit: 5, sortBy: "added", sortOrder: "asc" });
    expect(page1.nextCursor).toBeTruthy();

    const page2 = lib.listBooksCursor({
      limit: 5,
      sortBy: "added",
      sortOrder: "asc",
      cursor: page1.nextCursor!,
    });

    const allItems = [...page1.items, ...page2.items];
    expect(new Set(allItems.map((b) => b.id)).size).toBe(10);

    for (let i = 1; i < allItems.length; i++) {
      const prev = allItems[i - 1]!;
      const curr = allItems[i]!;
      expect(prev.timestamp <= curr.timestamp).toBe(true);
    }
  });

  test("desc: page1 + page2 no dups, ordering holds", () => {
    const page1 = lib.listBooksCursor({ limit: 5, sortBy: "added", sortOrder: "desc" });
    const page2 = lib.listBooksCursor({
      limit: 5,
      sortBy: "added",
      sortOrder: "desc",
      cursor: page1.nextCursor!,
    });

    const allItems = [...page1.items, ...page2.items];
    expect(new Set(allItems.map((b) => b.id)).size).toBe(10);

    for (let i = 1; i < allItems.length; i++) {
      const prev = allItems[i - 1]!;
      const curr = allItems[i]!;
      expect(prev.timestamp >= curr.timestamp).toBe(true);
    }
  });
});

describe("cursor round-trip: rating sort", () => {
  function ratingVal(item: { rating: number | null }): number {
    return item.rating != null ? item.rating : 0;
  }

  test("asc: page1 + page2 no dups, rating ordering holds across boundary", () => {
    const page1 = lib.listBooksCursor({ limit: 5, sortBy: "rating", sortOrder: "asc" });
    expect(page1.nextCursor).toBeTruthy();

    const page2 = lib.listBooksCursor({
      limit: 5,
      sortBy: "rating",
      sortOrder: "asc",
      cursor: page1.nextCursor!,
    });

    const allItems = [...page1.items, ...page2.items];
    expect(new Set(allItems.map((b) => b.id)).size).toBe(10);

    for (let i = 1; i < allItems.length; i++) {
      const prev = allItems[i - 1]!;
      const curr = allItems[i]!;
      expect(ratingVal(prev) <= ratingVal(curr)).toBe(true);
    }

    const lastPage1 = page1.items[page1.items.length - 1]!;
    const firstPage2 = page2.items[0]!;
    expect(ratingVal(lastPage1) <= ratingVal(firstPage2)).toBe(true);
  });

  test("desc: page1 + page2 no dups, rating ordering holds across boundary", () => {
    const page1 = lib.listBooksCursor({ limit: 5, sortBy: "rating", sortOrder: "desc" });
    expect(page1.nextCursor).toBeTruthy();

    const page2 = lib.listBooksCursor({
      limit: 5,
      sortBy: "rating",
      sortOrder: "desc",
      cursor: page1.nextCursor!,
    });

    const allItems = [...page1.items, ...page2.items];
    expect(new Set(allItems.map((b) => b.id)).size).toBe(10);

    for (let i = 1; i < allItems.length; i++) {
      const prev = allItems[i - 1]!;
      const curr = allItems[i]!;
      expect(ratingVal(prev) >= ratingVal(curr)).toBe(true);
    }

    const lastPage1 = page1.items[page1.items.length - 1]!;
    const firstPage2 = page2.items[0]!;
    expect(ratingVal(lastPage1) >= ratingVal(firstPage2)).toBe(true);
  });

  test("all pages together contain exactly all books with no dups", () => {
    const collected = allIds(
      (cursor) => lib.listBooksCursor({ limit: 3, sortBy: "rating", sortOrder: "asc", cursor }),
      3,
    );
    expect(collected).toHaveLength(BOOKS.length);
    expect(new Set(collected).size).toBe(BOOKS.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid cursor tests
// ---------------------------------------------------------------------------

describe("invalid cursor", () => {
  test("garbage cursor throws CursorError from listBooksCursor", () => {
    expect(() => {
      lib.listBooksCursor({ cursor: "not-valid-base64url-json!!!" });
    }).toThrow(lib.CursorError);
  });

  test("cursor that decodes to non-JSON throws CursorError", () => {
    const badCursor = Buffer.from("this is not json").toString("base64url");
    expect(() => {
      lib.listBooksCursor({ cursor: badCursor });
    }).toThrow(lib.CursorError);
  });

  test("garbage cursor throws CursorError for all sort fields", () => {
    const sortFields = ["title", "author", "added", "rating"] as const;
    for (const sortBy of sortFields) {
      expect(() => {
        lib.listBooksCursor({ cursor: "garbage!!!", sortBy });
      }).toThrow(lib.CursorError);
    }
  });

  test("garbage cursor throws CursorError from searchBooksCursor", () => {
    expect(() => {
      lib.searchBooksCursor({ query: "Aardvark", cursor: "garbage!!!" });
    }).toThrow(lib.CursorError);
  });

  test("CursorError is an instance of Error", () => {
    let thrown: unknown;
    try {
      lib.listBooksCursor({ cursor: "garbage!!!" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(lib.CursorError);
    expect((thrown as InstanceType<typeof lib.CursorError>).name).toBe("CursorError");
  });
});

// ---------------------------------------------------------------------------
// 3. Rating sort correctness
// ---------------------------------------------------------------------------

describe("rating sort correctness", () => {
  // BOOKS has: id1=10, id2=8, id3=8, id4=6, id5=6, id6=null, id7=null, id8=4, id9=2, id10=null
  // null treated as 0

  test("desc: highest-rated book is first", () => {
    const result = lib.listBooksCursor({ limit: 10, sortBy: "rating", sortOrder: "desc" });
    const first = result.items[0]!;
    expect(first.id).toBe(1);
    expect(first.rating).toBe(10);
  });

  test("asc: books with no rating (treated as 0) appear before rated books", () => {
    const result = lib.listBooksCursor({ limit: 10, sortBy: "rating", sortOrder: "asc" });
    const zeroRatedIds = result.items.filter((b) => (b.rating ?? 0) === 0).map((b) => b.id);
    const ratedIds = result.items.filter((b) => (b.rating ?? 0) > 0).map((b) => b.id);
    // All zero-rated items must appear before all non-zero-rated items
    const lastZeroIndex = Math.max(...zeroRatedIds.map((id) => result.items.findIndex((b) => b.id === id)));
    const firstRatedIndex = Math.min(...ratedIds.map((id) => result.items.findIndex((b) => b.id === id)));
    expect(lastZeroIndex).toBeLessThan(firstRatedIndex);
  });

  test("ties in rating are broken by id, no dups across pages", () => {
    // ids 2 and 3 both have rating 8; ids 4 and 5 both have rating 6
    const page1 = lib.listBooksCursor({ limit: 5, sortBy: "rating", sortOrder: "desc" });
    const page2 = lib.listBooksCursor({
      limit: 5,
      sortBy: "rating",
      sortOrder: "desc",
      cursor: page1.nextCursor!,
    });

    const allItems = [...page1.items, ...page2.items];
    const ids = allItems.map((b) => b.id);
    expect(new Set(ids).size).toBe(10);

    // Find both books with rating 8 — they must appear consecutively (no dup, no gap)
    const rating8 = allItems.filter((b) => b.rating === 8);
    expect(rating8).toHaveLength(2);

    // Find both books with rating 6 — both present, no dup
    const rating6 = allItems.filter((b) => b.rating === 6);
    expect(rating6).toHaveLength(2);
  });

  test("ascending rating: lowest rated first, ties ordered by id ascending", () => {
    const result = lib.listBooksCursor({ limit: 10, sortBy: "rating", sortOrder: "asc" });
    // All 10 books should be returned
    expect(result.items).toHaveLength(10);

    // Verify monotonic order
    for (let i = 1; i < result.items.length; i++) {
      const prev = result.items[i - 1]!;
      const curr = result.items[i]!;
      const prevRating = prev.rating ?? 0;
      const currRating = curr.rating ?? 0;
      if (prevRating === currRating) {
        expect(prev.id).toBeLessThan(curr.id);
      } else {
        expect(prevRating).toBeLessThan(currRating);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. FTS search tests
// ---------------------------------------------------------------------------

describe("FTS search", () => {
  test("prefix match: searching a title prefix finds the book", () => {
    const result = lib.searchBooksCursor({ query: "Aardv" });
    const ids = result.items.map((b) => b.id);
    expect(ids).toContain(1);
  });

  test("full word match: finds correct book", () => {
    const result = lib.searchBooksCursor({ query: "Banana" });
    const ids = result.items.map((b) => b.id);
    expect(ids).toContain(2);
    expect(ids).not.toContain(1);
  });

  test("multi-word query: finds book matching all words", () => {
    const result = lib.searchBooksCursor({ query: "Jungle Book" });
    const ids = result.items.map((b) => b.id);
    expect(ids).toContain(10);
  });

  test("double quotes in query do not throw and return sane results", () => {
    expect(() => {
      lib.searchBooksCursor({ query: '"Aardvark"' });
    }).not.toThrow();

    const result = lib.searchBooksCursor({ query: '"Aardvark"' });
    expect(Array.isArray(result.items)).toBe(true);
  });

  test("FTS-special characters (AND, OR, NOT, *) in query do not throw", () => {
    const specialQueries = [
      "AND OR",
      "book OR fire",
      "title NOT found",
      "fire*",
      "book AND dragon",
      '"double ""quoted"" word"',
    ];
    for (const q of specialQueries) {
      expect(() => {
        lib.searchBooksCursor({ query: q });
      }).not.toThrow();
    }
  });

  test("empty query falls back to full list", () => {
    const result = lib.searchBooksCursor({ query: "   " });
    expect(result.items.length).toBeGreaterThan(0);
  });

  test("query that matches nothing returns empty items array", () => {
    const result = lib.searchBooksCursor({ query: "zzznomatch999" });
    expect(result.items).toHaveLength(0);
  });

  test("searchBooksByTitle prefix match", () => {
    const results = lib.searchBooksByTitle("Honey");
    const ids = results.map((b) => b.id);
    expect(ids).toContain(8);
  });

  test("searchBooksByTitle with double quotes does not throw", () => {
    expect(() => {
      lib.searchBooksByTitle('"Cherry"');
    }).not.toThrow();

    const results = lib.searchBooksByTitle('"Cherry"');
    expect(Array.isArray(results)).toBe(true);
  });

  test("searchBooksByTitle with FTS special chars does not throw", () => {
    expect(() => {
      lib.searchBooksByTitle("book AND fire OR dragon");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Tag filter (OR logic) tests
// ---------------------------------------------------------------------------

describe("tag filter (OR logic)", () => {
  // TAG_BOOKS: Fiction(1)={1,2,3,4}, History(2)={3,4,5}, Sci-Fi(3)={5,6}

  test("listAllTags: sorted by book count desc then name, with counts", () => {
    const tags = lib.listAllTags();
    expect(tags.map((t) => t.name)).toEqual(["Fiction", "History", "Sci-Fi"]);
    expect(tags.map((t) => t.bookCount)).toEqual([4, 3, 2]);
    expect(tags[0]).toMatchObject({ id: 1, name: "Fiction", bookCount: 4 });
  });

  test("no tagIds returns all books (filter disabled)", () => {
    const all = lib.listBooksCursor({ sortBy: "title", sortOrder: "asc" }).items.map((b) => b.id);
    expect(all).toHaveLength(BOOKS.length);
  });

  test("single tag filters to its books", () => {
    expect(
      lib.listBooksCursor({ tagIds: [2], sortBy: "title", sortOrder: "asc" }).items.map((b) => b.id),
    ).toEqual([3, 4, 5]); // History
    expect(
      lib.listBooksCursor({ tagIds: [3], sortBy: "title", sortOrder: "asc" }).items.map((b) => b.id),
    ).toEqual([5, 6]); // Sci-Fi
  });

  test("multiple tags union without duplicates", () => {
    expect(
      lib.listBooksCursor({ tagIds: [1, 2], sortBy: "title", sortOrder: "asc" }).items.map((b) => b.id),
    ).toEqual([1, 2, 3, 4, 5]); // Fiction ∪ History
    expect(
      lib.listBooksCursor({ tagIds: [1, 3], sortBy: "title", sortOrder: "asc" }).items.map((b) => b.id),
    ).toEqual([1, 2, 3, 4, 5, 6]); // Fiction ∪ Sci-Fi
  });

  test("duplicate / non-existent / invalid tag ids are handled", () => {
    expect(lib.listBooksCursor({ tagIds: [1, 1, 2, 2], sortBy: "title" }).items.map((b) => b.id)).toEqual(
      [1, 2, 3, 4, 5],
    );
    // Non-existent id 9999 contributes nothing; valid ones still OR together
    expect(lib.listBooksCursor({ tagIds: [1, 9999], sortBy: "title" }).items.map((b) => b.id)).toEqual([
      1, 2, 3, 4,
    ]);
    // Invalid ids (<=0, NaN) are ignored
    expect(
      lib.listBooksCursor({ tagIds: [1, 0, -5, Number.NaN], sortBy: "title" }).items.map((b) => b.id),
    ).toEqual([1, 2, 3, 4]);
    expect(lib.listBooksCursor({ tagIds: [9999] }).items).toHaveLength(0);
  });

  test("union paginates with no dups and monotonic title order", () => {
    const collected: number[] = [];
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = lib.listBooksCursor({
        tagIds: [1, 2],
        limit: 2,
        sortBy: "title",
        sortOrder: "asc",
        cursor,
      });
      for (const b of page.items) collected.push(b.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Membership (copy before sorting so the ordering check below isn't corrupted)
    expect([...collected].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(collected).size).toBe(collected.length);
    // Titles Aardvark..Elephant already align with id order
    expect(collected).toEqual([1, 2, 3, 4, 5]);
  });

  test("search × tag filter compose (AND across, OR within tags)", () => {
    expect(lib.searchBooksCursor({ query: "Aardvark", tagIds: [1] }).items.map((b) => b.id)).toEqual([
      1,
    ]);
    // Aardvark (book 1) is not History
    expect(lib.searchBooksCursor({ query: "Aardvark", tagIds: [2] }).items).toHaveLength(0);
    // Dragon (book 4) is in Fiction and History, not Sci-Fi
    expect(lib.searchBooksCursor({ query: "Dragon", tagIds: [1, 3] }).items.map((b) => b.id)).toEqual([
      4,
    ]);
    expect(lib.searchBooksCursor({ query: "Dragon", tagIds: [3] }).items).toHaveLength(0);
  });
});
