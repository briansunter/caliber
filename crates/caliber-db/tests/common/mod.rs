//! Shared fixture helpers for caliber-db integration tests.
//!
//! The schema mirrors `createFixtureLibrary` in `tests/auth.test.ts` and the
//! book/tag/format seed data mirrors `tests/cursor-pagination.test.ts`, so the
//! Rust ports assert against the same expectations as the TS suites.

use rusqlite::{params, Connection};
use std::path::Path;

pub struct BookSpec {
    pub id: i64,
    pub title: &'static str,
    pub sort: &'static str,
    pub author_sort: &'static str,
    pub timestamp: &'static str,
    pub rating: Option<i64>,
}

/// 22 books: ids 1-10 ASCII fixtures; ids 11-22 add non-ASCII regression
/// coverage where JS `.toLowerCase()` and SQLite's ASCII-only `lower()`
/// disagree (É/é, İ, ß, Ü, Å, Æ).
pub const BOOKS: &[BookSpec] = &[
    BookSpec {
        id: 1,
        title: "Aardvark Tales",
        sort: "Aardvark Tales",
        author_sort: "Smith, Alice",
        timestamp: "2024-01-10 00:00:00+00:00",
        rating: Some(10),
    },
    BookSpec {
        id: 2,
        title: "Banana Dreams",
        sort: "Banana Dreams",
        author_sort: "Jones, Bob",
        timestamp: "2024-01-02 00:00:00+00:00",
        rating: Some(8),
    },
    BookSpec {
        id: 3,
        title: "Cherry Picking",
        sort: "Cherry Picking",
        author_sort: "Doe, Carol",
        timestamp: "2024-01-08 00:00:00+00:00",
        rating: Some(8),
    },
    BookSpec {
        id: 4,
        title: "Dragon Fire",
        sort: "Dragon Fire",
        author_sort: "Brown, Dave",
        timestamp: "2024-01-04 00:00:00+00:00",
        rating: Some(6),
    },
    BookSpec {
        id: 5,
        title: "Elephant Walk",
        sort: "Elephant Walk",
        author_sort: "White, Eve",
        timestamp: "2024-01-06 00:00:00+00:00",
        rating: Some(6),
    },
    BookSpec {
        id: 6,
        title: "Fox Trot",
        sort: "Fox Trot",
        author_sort: "Green, Frank",
        timestamp: "2024-01-01 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 7,
        title: "Grape Vine",
        sort: "Grape Vine",
        author_sort: "Black, Grace",
        timestamp: "2024-01-09 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 8,
        title: "Honey Bee",
        sort: "Honey Bee",
        author_sort: "Clark, Hank",
        timestamp: "2024-01-03 00:00:00+00:00",
        rating: Some(4),
    },
    BookSpec {
        id: 9,
        title: "Igloo Nights",
        sort: "Igloo Nights",
        author_sort: "Davis, Iris",
        timestamp: "2024-01-07 00:00:00+00:00",
        rating: Some(2),
    },
    BookSpec {
        id: 10,
        title: "Jungle Book",
        sort: "Jungle Book",
        author_sort: "Evans, Jack",
        timestamp: "2024-01-05 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 11,
        title: "Alpha",
        sort: "Alpha",
        author_sort: "Adams, John",
        timestamp: "2024-01-13 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 12,
        title: "Apfel",
        sort: "Apfel",
        author_sort: "Böll, Heinrich",
        timestamp: "2024-01-14 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 13,
        title: "Banane",
        sort: "Banane",
        author_sort: "Céline, Louis-Ferdinand",
        timestamp: "2024-01-15 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 14,
        title: "Cidre",
        sort: "Cidre",
        author_sort: "Dumas, Alexandre",
        timestamp: "2024-01-16 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 15,
        title: "Éclair",
        sort: "Éclair",
        author_sort: "Eco, Umberto",
        timestamp: "2024-01-17 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 16,
        title: "étagère",
        sort: "étagère",
        author_sort: "Foer, Jonathan Safran",
        timestamp: "2024-01-18 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 17,
        title: "İstanbul",
        sort: "İstanbul",
        author_sort: "Gauguin, Paul",
        timestamp: "2024-01-19 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 18,
        title: "Straße",
        sort: "Straße",
        author_sort: "Høeg, Peter",
        timestamp: "2024-01-20 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 19,
        title: "Überfall",
        sort: "Überfall",
        author_sort: "Ibsen, Henrik",
        timestamp: "2024-01-21 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 20,
        title: "Zebra",
        sort: "Zebra",
        author_sort: "Jansson, Tove",
        timestamp: "2024-01-22 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 21,
        title: "Ångström",
        sort: "Ångström",
        author_sort: "Knausgård, Karl Ove",
        timestamp: "2024-01-23 00:00:00+00:00",
        rating: None,
    },
    BookSpec {
        id: 22,
        title: "Ærø",
        sort: "Ærø",
        author_sort: "Lagerlöf, Selma",
        timestamp: "2024-01-24 00:00:00+00:00",
        rating: None,
    },
];

// Tags: Fiction (1): books 1,2,3,4; History (2): books 3,4,5; Sci-Fi (3):
// books 5,6. Union Fiction ∪ History = {1,2,3,4,5}.
pub const TAG_FIXTURE: &[(i64, &str)] = &[(1, "Fiction"), (2, "History"), (3, "Sci-Fi")];
pub const TAG_BOOKS: &[(i64, i64)] = &[
    (1, 1),
    (2, 1),
    (3, 1),
    (4, 1),
    (3, 2),
    (4, 2),
    (5, 2),
    (5, 3),
    (6, 3),
];

// Formats: EPUB: books 1,2,3,4; PDF: books 3,4,5; MOBI: books 5,6.
pub const FORMAT_BOOKS: &[(i64, &str)] = &[
    (1, "EPUB"),
    (2, "EPUB"),
    (3, "EPUB"),
    (4, "EPUB"),
    (3, "PDF"),
    (4, "PDF"),
    (5, "PDF"),
    (5, "MOBI"),
    (6, "MOBI"),
];

pub const FIXTURE_SCHEMA: &str = "
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
";

/// Build the fixture source library at `db_path` (schema + books + ratings +
/// tags + formats). Extra fixtures (authors/series/isbn/paths) are added by
/// the individual test binaries on the same connection before it closes.
pub fn build_fixture_db(db_path: &Path, books: &[BookSpec]) -> Connection {
    let db = Connection::open(db_path).expect("create fixture db");
    db.execute_batch(FIXTURE_SCHEMA).unwrap();

    for book in books {
        if let Some(rv) = book.rating {
            db.execute("INSERT OR IGNORE INTO ratings (rating) VALUES (?1)", [rv])
                .unwrap();
        }
    }
    for book in books {
        db.execute(
            "INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
             VALUES (?1, ?2, ?3, ?4, '2023-01-01 00:00:00+00:00', 1.0, ?5, '', 1, '', 0, ?4)",
            params![book.id, book.title, book.sort, book.timestamp, book.author_sort],
        )
        .unwrap();
        if let Some(rv) = book.rating {
            let rating_id: i64 = db
                .query_row("SELECT id FROM ratings WHERE rating = ?1", [rv], |r| {
                    r.get(0)
                })
                .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO books_ratings_link (book, rating) VALUES (?1, ?2)",
                params![book.id, rating_id],
            )
            .unwrap();
        }
    }

    for (id, name) in TAG_FIXTURE {
        db.execute(
            "INSERT INTO tags (id, name) VALUES (?1, ?2)",
            params![id, name],
        )
        .unwrap();
    }
    for (book, tag) in TAG_BOOKS {
        db.execute(
            "INSERT INTO books_tags_link (book, tag) VALUES (?1, ?2)",
            params![book, tag],
        )
        .unwrap();
    }
    for (book, format) in FORMAT_BOOKS {
        db.execute(
            "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?1, ?2, 1000, ?3)",
            params![book, format, format!("{book}.{}", format.to_lowercase())],
        )
        .unwrap();
    }
    db
}

/// Create `library/` inside `root`, build the standard 22-book fixture, and
/// return the library path.
#[allow(dead_code)]
pub fn create_source_library(root: &Path) -> std::path::PathBuf {
    let library = root.join("library");
    std::fs::create_dir_all(&library).unwrap();
    let conn = build_fixture_db(&library.join("metadata.db"), BOOKS);
    conn.close().unwrap();
    library
}
