//! Book detail lookup, batched details, the export stream, counts/stats, and
//! file-path resolution — ports of `getBookByIdOptimized`,
//! `getBooksByIdsOptimized`, `streamBooks`, `getBookCount`,
//! `getLibraryStats`, `getBookTitle`, `getBookFormatPath`, and
//! `getBookCoverPath`.

use crate::error::DbError;
use crate::snapshot::Shared;
use crate::util::{
    is_safe_library_path, js_join, value_bool, value_f64, value_opt_i64, value_opt_string,
    value_string,
};
use caliber_common::types::{BookListItem, BookWithDetails, LibraryStats};
use rusqlite::types::Value as V;
use rusqlite::{params_from_iter, Connection, Row};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// `splitAggregatedField`: JSON array first, legacy comma-split fallback.
pub(crate) fn split_aggregated(value: Option<String>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&value) {
        if let serde_json::Value::Array(items) = parsed {
            return items
                .into_iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    value
        .split(',')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(String::from)
        .collect()
}

fn row_detail(row: &Row<'_>) -> rusqlite::Result<BookWithDetails> {
    Ok(BookWithDetails {
        id: row.get::<_, i64>("id")?,
        title: value_string(&row.get::<_, V>("title")?),
        sort: value_opt_string(&row.get::<_, V>("sort")?),
        author_sort: value_opt_string(&row.get::<_, V>("author_sort")?),
        authors: split_aggregated(value_opt_string(&row.get::<_, V>("authors")?)),
        series: value_opt_string(&row.get::<_, V>("series")?),
        series_index: value_f64(&row.get::<_, V>("series_index")?),
        tags: split_aggregated(value_opt_string(&row.get::<_, V>("tags")?)),
        formats: split_aggregated(value_opt_string(&row.get::<_, V>("formats")?)),
        has_cover: value_bool(&row.get::<_, V>("has_cover")?),
        pubdate: value_string(&row.get::<_, V>("pubdate")?),
        timestamp: value_string(&row.get::<_, V>("timestamp")?),
        rating: value_opt_i64(&row.get::<_, V>("rating")?),
        // Details always carry uuid (possibly empty) like the TS parser.
        uuid: Some(value_string(&row.get::<_, V>("uuid")?)),
        last_modified: value_opt_string(&row.get::<_, V>("last_modified")?),
        publisher: value_opt_string(&row.get::<_, V>("publisher")?),
        comments: value_opt_string(&row.get::<_, V>("comments")?),
        isbn: value_opt_string(&row.get::<_, V>("isbn")?).unwrap_or_default(),
        path: value_string(&row.get::<_, V>("path")?),
    })
}

/// `parseBookRow` for the search/stream fan-out queries (no uuid /
/// last_modified columns in those queries).
pub(crate) fn parse_search_row(row: &Row<'_>) -> BookListItem {
    BookListItem {
        id: row.get::<_, i64>(0).unwrap_or_default(),
        title: value_string(&row.get::<_, V>(1).unwrap_or(V::Null)),
        sort: value_opt_string(&row.get::<_, V>(2).unwrap_or(V::Null)),
        author_sort: value_opt_string(&row.get::<_, V>(3).unwrap_or(V::Null)),
        authors: split_aggregated(value_opt_string(&row.get::<_, V>(10).unwrap_or(V::Null))),
        series: value_opt_string(&row.get::<_, V>(8).unwrap_or(V::Null)),
        series_index: value_f64(&row.get::<_, V>(4).unwrap_or(V::Null)),
        tags: split_aggregated(value_opt_string(&row.get::<_, V>(11).unwrap_or(V::Null))),
        formats: split_aggregated(value_opt_string(&row.get::<_, V>(12).unwrap_or(V::Null))),
        has_cover: value_bool(&row.get::<_, V>(5).unwrap_or(V::Null)),
        pubdate: value_string(&row.get::<_, V>(6).unwrap_or(V::Null)),
        timestamp: value_string(&row.get::<_, V>(7).unwrap_or(V::Null)),
        rating: value_opt_i64(&row.get::<_, V>(9).unwrap_or(V::Null)),
        uuid: None,
        last_modified: None,
    }
}

/// `getBookByIdOptimized` — SQL ported verbatim (isbn join + FILTER
/// aggregates inside a `book_page` CTE).
const BOOK_DETAIL_SQL: &str = "
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
          b.last_modified,
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
        b.last_modified,
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
      GROUP BY b.id";

pub(crate) fn get_book(shared: &Arc<Shared>, id: i64) -> Result<Option<BookWithDetails>, DbError> {
    let checkout = shared.checkout()?;
    match checkout.query_row(BOOK_DETAIL_SQL, [id], row_detail) {
        Ok(book) => Ok(Some(book)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::from(e)),
    }
}

/// `getBooksByIdsOptimized` — dedup + cap at 500 ids, one base query plus one
/// aggregate query per facet. Best-effort: failures return a partial map.
pub(crate) fn get_books_by_ids(shared: &Arc<Shared>, ids: &[i64]) -> HashMap<i64, BookWithDetails> {
    let mut found = HashMap::new();
    let mut unique: Vec<i64> = Vec::new();
    for id in ids {
        if *id > 0 && !unique.contains(id) {
            unique.push(*id);
        }
        if unique.len() >= 500 {
            break;
        }
    }
    if unique.is_empty() {
        return found;
    }
    let Ok(checkout) = shared.checkout() else {
        return found;
    };
    let placeholders = vec!["?"; unique.len()].join(",");
    let base_sql = format!(
        "SELECT
           b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover,
           b.pubdate, b.timestamp, b.last_modified,
           isbn_identifier.val as isbn, b.uuid, b.path,
           s.name as series, r.rating, p.name as publisher, c.text as comments
         FROM books b
         LEFT JOIN identifiers isbn_identifier
           ON b.id = isbn_identifier.book
           AND isbn_identifier.type = 'isbn'
         LEFT JOIN books_series_link bsl ON b.id = bsl.book
         LEFT JOIN series s ON bsl.series = s.id
         LEFT JOIN books_ratings_link brl ON b.id = brl.book
         LEFT JOIN ratings r ON brl.rating = r.id
         LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
         LEFT JOIN publishers p ON bpl.publisher = p.id
         LEFT JOIN comments c ON b.id = c.book
         WHERE b.id IN ({placeholders})"
    );
    let facet = |sql: &str| -> HashMap<i64, Vec<String>> {
        let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
        let Ok(mut stmt) = checkout.prepare(sql) else {
            return by_id;
        };
        let Ok(mut rows) = stmt.query(params_from_iter(unique.iter())) else {
            return by_id;
        };
        while let Ok(Some(row)) = rows.next() {
            let Ok(book) = row.get::<_, i64>(0) else {
                continue;
            };
            let Ok(name) = row.get::<_, V>(1) else {
                continue;
            };
            let Some(text) = value_opt_string(&name) else {
                continue;
            };
            let label = text.trim().to_string();
            if label.is_empty() {
                continue;
            }
            let list = by_id.entry(book).or_default();
            if !list.contains(&label) {
                list.push(label);
            }
        }
        by_id
    };
    let authors_by_id = facet(&format!(
        "SELECT bal.book as book, a.name as name FROM books_authors_link bal JOIN authors a ON bal.author = a.id WHERE bal.book IN ({placeholders})"
    ));
    let tags_by_id = facet(&format!(
        "SELECT btl.book as book, t.name as name FROM books_tags_link btl JOIN tags t ON btl.tag = t.id WHERE btl.book IN ({placeholders})"
    ));
    let formats_by_id = facet(&format!(
        "SELECT d.book as book, d.format as name FROM data d WHERE d.book IN ({placeholders})"
    ));

    let Ok(mut stmt) = checkout.prepare(&base_sql) else {
        return found;
    };
    let Ok(mut rows) = stmt.query(params_from_iter(unique.iter())) else {
        return found;
    };
    while let Ok(Some(row)) = rows.next() {
        let Ok(book) = row_detail_partial(row) else {
            continue;
        };
        found.insert(book.id, book);
    }
    // Attach facet aggregates (mirrors the TS JSON re-stringify round trip).
    for (id, book) in found.iter_mut() {
        book.authors = authors_by_id.get(id).cloned().unwrap_or_default();
        book.tags = tags_by_id.get(id).cloned().unwrap_or_default();
        book.formats = formats_by_id.get(id).cloned().unwrap_or_default();
    }
    found
}

/// Base-row parse for the batch query (no aggregate columns).
fn row_detail_partial(row: &Row<'_>) -> rusqlite::Result<BookWithDetails> {
    Ok(BookWithDetails {
        id: row.get::<_, i64>("id")?,
        title: value_string(&row.get::<_, V>("title")?),
        sort: value_opt_string(&row.get::<_, V>("sort")?),
        author_sort: value_opt_string(&row.get::<_, V>("author_sort")?),
        authors: Vec::new(),
        series: value_opt_string(&row.get::<_, V>("series")?),
        series_index: value_f64(&row.get::<_, V>("series_index")?),
        tags: Vec::new(),
        formats: Vec::new(),
        has_cover: value_bool(&row.get::<_, V>("has_cover")?),
        pubdate: value_string(&row.get::<_, V>("pubdate")?),
        timestamp: value_string(&row.get::<_, V>("timestamp")?),
        rating: value_opt_i64(&row.get::<_, V>("rating")?),
        uuid: Some(value_string(&row.get::<_, V>("uuid")?)),
        last_modified: value_opt_string(&row.get::<_, V>("last_modified")?),
        publisher: value_opt_string(&row.get::<_, V>("publisher")?),
        comments: value_opt_string(&row.get::<_, V>("comments")?),
        isbn: value_opt_string(&row.get::<_, V>("isbn")?).unwrap_or_default(),
        path: value_string(&row.get::<_, V>("path")?),
    })
}

pub(crate) fn get_book_count(shared: &Arc<Shared>) -> Result<i64, DbError> {
    let checkout = shared.checkout()?;
    let count: i64 =
        checkout.query_row("SELECT COUNT(*) as count FROM books", [], |row| row.get(0))?;
    Ok(count)
}

pub(crate) fn get_library_stats(shared: &Arc<Shared>) -> Result<LibraryStats, DbError> {
    let checkout = shared.checkout()?;
    checkout
        .query_row(
            "SELECT
          (SELECT COUNT(*) FROM books) as totalBooks,
          (SELECT COUNT(*) FROM authors) as totalAuthors,
          (SELECT COUNT(*) FROM series) as totalSeries,
          (SELECT COUNT(*) FROM tags) as totalTags",
            [],
            |row| {
                Ok(LibraryStats {
                    total_books: row.get::<_, i64>(0)?,
                    total_authors: row.get::<_, i64>(1)?,
                    total_series: row.get::<_, i64>(2)?,
                    total_tags: row.get::<_, i64>(3)?,
                })
            },
        )
        .map_err(DbError::from)
}

/// One id-ordered batch for `/api/books/stream` and the CLI stream (the TS
/// stream query omits uuid/last_modified; rows stay identical to TS).
const STREAM_BATCH_SQL: &str = "
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
      ORDER BY b.id ASC";

pub(crate) fn stream_books_batch(
    shared: &Arc<Shared>,
    last_id: i64,
    batch_size: u32,
) -> Result<Vec<BookListItem>, DbError> {
    let batch = batch_size.clamp(1, 5000);
    let checkout = shared.checkout()?;
    let conn: &Connection = &checkout;
    let mut stmt = conn.prepare(STREAM_BATCH_SQL)?;
    let mut rows = stmt.query(rusqlite::params![last_id, batch as i64])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(parse_search_row(row));
    }
    Ok(out)
}

pub(crate) fn book_title(shared: &Arc<Shared>, id: i64) -> Option<String> {
    let checkout = shared.checkout().ok()?;
    checkout
        .query_row("SELECT title FROM books WHERE id = ?", [id], |row| {
            Ok(value_string(&row.get::<_, V>(0)?))
        })
        .ok()
}

/// `getBookFormatPath`: join(library, b.path, "{d.name}.{format}") +
/// containment check.
pub(crate) fn book_format_path(
    shared: &Arc<Shared>,
    library: &std::path::Path,
    book_id: i64,
    format: &str,
) -> Option<PathBuf> {
    let checkout = shared.checkout().ok()?;
    let (path, name): (String, String) = checkout
        .query_row(
            "SELECT b.path, d.name
      FROM books b
      JOIN data d ON b.id = d.book
      WHERE b.id = ? AND d.format = ?",
            rusqlite::params![book_id, format.to_uppercase()],
            |row| {
                Ok((
                    value_string(&row.get::<_, V>(0)?),
                    value_string(&row.get::<_, V>(1)?),
                ))
            },
        )
        .ok()?;
    let ext = format.to_lowercase();
    let file_path = js_join(library, &path, &format!("{name}.{ext}"));
    if is_safe_library_path(library, &file_path) {
        Some(file_path)
    } else {
        None
    }
}

/// `getBookCoverPath`: join(library, b.path, "cover.jpg") when has_cover +
/// containment check.
pub(crate) fn book_cover_path(
    shared: &Arc<Shared>,
    library: &std::path::Path,
    book_id: i64,
) -> Option<PathBuf> {
    let checkout = shared.checkout().ok()?;
    let (path, has_cover): (String, bool) = checkout
        .query_row(
            "SELECT path, has_cover FROM books WHERE id = ?",
            [book_id],
            |row| {
                Ok((
                    value_string(&row.get::<_, V>(0)?),
                    value_bool(&row.get::<_, V>(1)?),
                ))
            },
        )
        .ok()?;
    if !has_cover {
        return None;
    }
    let file_path = js_join(library, &path, "cover.jpg");
    if is_safe_library_path(library, &file_path) {
        Some(file_path)
    } else {
        None
    }
}
