//! Snapshot database setup: expression indexes, FTS5 table, verification
//! probes, and the rating projection — a line-for-line port of
//! `setupSnapshotDb` in `src/lib/calibre-optimized.ts` (SQL kept verbatim).

use crate::util::js_signature_json;
use caliber_common::signature::database_signature;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

/// FTS index schema version, stored in `caliber_fts_meta`. Bump to force a
/// rebuild when the FTS definition changes (v3 adds the book_list_projection
/// rating materialization + the timestamp/series_index expression indexes).
pub(crate) const FTS_SCHEMA_VERSION: &str = "3";

pub(crate) fn setup_snapshot_db(db: &Connection, source_db_path: &Path) -> Result<(), String> {
    let source_signature = database_signature(source_db_path);
    let source_signature_value = js_signature_json(&source_signature);

    // Expression indexes for keyset pagination. Each index matches the
    // normalized sort expression in `book_sort_expression()` exactly (same
    // function calls, same argument order, modulo alias/whitespace which
    // SQLite normalizes) so SQLite can seek instead of sorting. Aliases
    // (b./p.) are stripped here — expression indexes must reference bare
    // columns of the indexed table.
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_books_sort_key ON books(COALESCE(NULLIF(lower(sort), ''), lower(title)), id);
         CREATE INDEX IF NOT EXISTS idx_books_author_sort_key ON books(COALESCE(lower(author_sort), ''), id);
         CREATE INDEX IF NOT EXISTS idx_books_timestamp_key ON books(timestamp, id);
         CREATE INDEX IF NOT EXISTS idx_books_timestamp_matching ON books(COALESCE(timestamp,''), id);
         CREATE INDEX IF NOT EXISTS idx_books_series_index_key ON books(COALESCE(series_index,1), id);
         CREATE INDEX IF NOT EXISTS idx_books_ratings_link_book ON books_ratings_link(book);
         CREATE INDEX IF NOT EXISTS idx_ratings_value ON ratings(rating, id);
         CREATE INDEX IF NOT EXISTS idx_data_format ON data(format);
         CREATE INDEX IF NOT EXISTS idx_books_authors_link_book ON books_authors_link(book);
         CREATE INDEX IF NOT EXISTS idx_books_tags_link_book ON books_tags_link(book);
         CREATE INDEX IF NOT EXISTS idx_books_series_link_book ON books_series_link(book);
         CREATE INDEX IF NOT EXISTS idx_books_publishers_link_book ON books_publishers_link(book);
         CREATE INDEX IF NOT EXISTS idx_books_series_link_series ON books_series_link(series);
         CREATE INDEX IF NOT EXISTS idx_books_tags_link_tag ON books_tags_link(tag);
         CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name);",
    )
    .map_err(|e| e.to_string())?;

    // Create FTS5 virtual table for full-text search (bundled SQLite is
    // compiled with SQLITE_ENABLE_FTS5; verified by unit test).
    db.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
           title,
           author_sort,
           content='books',
           content_rowid='id'
         );
         CREATE TABLE IF NOT EXISTS caliber_fts_meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;

    let book_count: i64 = db
        .query_row("SELECT COUNT(*) as count FROM books", [], |row| {
            row.get::<_, i64>("count")
        })
        .map_err(|e| e.to_string())?;
    let fts_count: i64 = db
        .query_row("SELECT COUNT(*) as count FROM books_fts", [], |row| {
            row.get::<_, i64>("count")
        })
        .map_err(|e| e.to_string())?;
    let mut meta_by_key: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = db
            .prepare(
                "SELECT key, value FROM caliber_fts_meta WHERE key IN ('source_signature', 'fts_schema_version')",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let key: String = row.get(0).map_err(|e| e.to_string())?;
            let value: String = row.get(1).map_err(|e| e.to_string())?;
            meta_by_key.insert(key, value);
        }
    }
    let schema_version = meta_by_key.get("fts_schema_version").cloned();

    // MATCH probes verify the FTS index actually answers queries, not just
    // that the row COUNT(*) looks right (a corrupt/truncated FTS table can
    // still report a plausible count).
    if schema_version.as_deref() != Some(FTS_SCHEMA_VERSION)
        || meta_by_key.get("source_signature").map(String::as_str)
            != Some(source_signature_value.as_str())
        || fts_count != book_count
        || !fts_probes_pass(db)
    {
        eprintln!("🔍 Building FTS index...");
        // Publish atomically: rebuild + meta updates in one transaction so a
        // crash never leaves a half-built index advertised as current.
        db.execute("BEGIN IMMEDIATE;", [])
            .map_err(|e| e.to_string())?;
        let rebuild = (|| -> Result<(), String> {
            db.execute("INSERT INTO books_fts(books_fts) VALUES('rebuild');", [])
                .map_err(|e| e.to_string())?;
            db.execute(
                "INSERT OR REPLACE INTO caliber_fts_meta (key, value) VALUES ('source_signature', ?1)",
                [&source_signature_value],
            )
            .map_err(|e| e.to_string())?;
            db.execute(
                "INSERT OR REPLACE INTO caliber_fts_meta (key, value) VALUES ('fts_schema_version', ?1)",
                [FTS_SCHEMA_VERSION],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match rebuild {
            Ok(()) => {
                db.execute("COMMIT;", []).map_err(|e| e.to_string())?;
            }
            Err(error) => {
                let _ = db.execute("ROLLBACK;", []);
                return Err(error);
            }
        }
        if !fts_probes_pass(db) {
            return Err("FTS index rebuild failed verification probes".to_string());
        }
    }

    // Rating projection: materialized normalized rating (unrated → 0) so the
    // rating page query orders a single indexed column instead of joining
    // books_ratings_link/ratings at page time. Rebuilt transactionally
    // whenever the row count drifts from the book count (fresh copies always
    // rebuild).
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS book_list_projection (book INTEGER PRIMARY KEY, rating INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS idx_book_list_projection_rating ON book_list_projection(rating, book);",
    )
    .map_err(|e| e.to_string())?;
    let projection_count: i64 = db
        .query_row(
            "SELECT COUNT(*) as count FROM book_list_projection",
            [],
            |row| row.get::<_, i64>("count"),
        )
        .map_err(|e| e.to_string())?;
    if projection_count != book_count {
        db.execute("BEGIN IMMEDIATE;", [])
            .map_err(|e| e.to_string())?;
        let rebuild = (|| -> Result<(), String> {
            db.execute("DELETE FROM book_list_projection;", [])
                .map_err(|e| e.to_string())?;
            db.execute(
                "INSERT INTO book_list_projection (book, rating)
                SELECT b.id, COALESCE(r.rating, 0)
                FROM books b
                LEFT JOIN books_ratings_link brl ON b.id = brl.book
                LEFT JOIN ratings r ON brl.rating = r.id;",
                [],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match rebuild {
            Ok(()) => {
                db.execute("COMMIT;", []).map_err(|e| e.to_string())?;
            }
            Err(error) => {
                let _ = db.execute("ROLLBACK;", []);
                return Err(error);
            }
        }
    }

    let total: i64 = db
        .query_row("SELECT COUNT(*) as count FROM books_fts", [], |row| {
            row.get::<_, i64>("count")
        })
        .map_err(|e| e.to_string())?;
    eprintln!("🔍 FTS index ready ({total} books)");
    Ok(())
}

/// `ftsProbesPass`: an unlikely token must parse and match zero rows, and a
/// known title token (when the library is non-empty) must match at least one.
fn fts_probes_pass(db: &Connection) -> bool {
    let probe_zero = (|| -> Option<bool> {
        let mut stmt = db
            .prepare("SELECT rowid FROM books_fts WHERE books_fts MATCH ? LIMIT 1")
            .ok()?;
        let mut rows = stmt.query(["\"caliber_fts_probe_xyzzy_unlikely\""]).ok()?;
        match rows.next().ok()? {
            Some(_) => Some(false),
            None => Some(true),
        }
    })();
    if probe_zero != Some(true) {
        return false;
    }
    let title: Option<String> = db
        .query_row("SELECT title FROM books LIMIT 1", [], |row| {
            row.get::<_, rusqlite::types::Value>(0)
        })
        .ok()
        .map(|value| crate::util::value_string(&value));
    let Some(title) = title else {
        return true;
    };
    let Some(token) = first_ascii_token(&title.to_lowercase()) else {
        return true;
    };
    let escaped = token.replace('"', "\"\"");
    let query = format!("\"{escaped}\"*");
    match db.prepare("SELECT rowid FROM books_fts WHERE books_fts MATCH ? LIMIT 1") {
        Ok(mut stmt) => match stmt.query([query]) {
            Ok(mut rows) => matches!(rows.next(), Ok(Some(_))),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// First run of ≥2 `[a-z0-9]` characters (TS `title.toLowerCase().match(/[a-z0-9]{2,}/)`).
fn first_ascii_token(lowercased: &str) -> Option<String> {
    let mut current = String::new();
    for ch in lowercased.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            current.push(ch);
        } else {
            if current.len() >= 2 {
                return Some(current);
            }
            current.clear();
        }
    }
    if current.len() >= 2 {
        Some(current)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_virtual_table_works() {
        // Verifies the bundled SQLite build carries FTS5 before anything
        // depends on it.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(id INTEGER PRIMARY KEY, title TEXT, author_sort TEXT);
             CREATE VIRTUAL TABLE books_fts USING fts5(
               title, author_sort, content='books', content_rowid='id'
             );",
        )
        .expect("FTS5 must be available in the bundled SQLite build");
        conn.execute(
            "INSERT INTO books (id, title, author_sort) VALUES (1, 'Aardvark Tales', 'Smith')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO books_fts(books_fts) VALUES('rebuild');", [])
            .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM books_fts WHERE books_fts MATCH ?",
                ["\"aardv\"*"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    #[test]
    fn vacuum_into_works_on_readonly_source() {
        // The snapshot engine serializes the read-only source via
        // VACUUM INTO (the SQLite equivalent of Bun's `db.serialize()`).
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.db");
        let dst = dir.path().join("dst.db");
        {
            let conn = Connection::open(&src).unwrap();
            conn.execute("CREATE TABLE t (a)", []).unwrap();
            conn.execute("INSERT INTO t VALUES (1)", []).unwrap();
        }
        let ro = Connection::open_with_flags(
            &src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        ro.execute("VACUUM INTO ?1", [dst.to_string_lossy().to_string()])
            .expect("VACUUM INTO must work on a read-only connection");
        let count: i64 = Connection::open(&dst)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
