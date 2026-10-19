//! Catalog listings (authors/series/tags/formats), tag/format summaries, and
//! the title/author search helpers — ports of `listCatalogEntries`,
//! `getCatalogEntry`, `listAllTags`, `listAllFormats`, `searchBooksByTitle`,
//! `searchBooksByAuthor`, and `getAuthorByName`.

use crate::error::DbError;
use crate::listing::{clamp_limit, fts_match_query, fts_words};
use crate::snapshot::Shared;
use crate::util::{value_opt_i64, value_string};
use caliber_common::types::{
    AuthorInfo, CatalogEntry, CatalogId, CatalogKind, CatalogOptions, FormatSummary, SortOrder,
    TagSummary,
};
use caliber_common::{decode_catalog_cursor, encode_catalog_cursor, CursorPaginatedResult};
use rusqlite::types::Value as V;
use rusqlite::{params_from_iter, Connection};
use std::sync::Arc;

fn catalog_cte(kind: CatalogKind) -> &'static str {
    match kind {
        CatalogKind::Authors => {
            "SELECT
            a.id,
            a.name AS title,
            LOWER(COALESCE(a.sort, a.name)) AS sort,
            COUNT(DISTINCT bal.book) AS bookCount
          FROM authors a
          JOIN books_authors_link bal ON a.id = bal.author
          GROUP BY a.id"
        }
        CatalogKind::Series => {
            "SELECT
            s.id,
            s.name AS title,
            LOWER(COALESCE(s.sort, s.name)) AS sort,
            COUNT(DISTINCT bsl.book) AS bookCount
          FROM series s
          JOIN books_series_link bsl ON s.id = bsl.series
          GROUP BY s.id"
        }
        CatalogKind::Tags => {
            "SELECT
            t.id,
            t.name AS title,
            LOWER(t.name) AS sort,
            COUNT(DISTINCT btl.book) AS bookCount
          FROM tags t
          JOIN books_tags_link btl ON t.id = btl.tag
          GROUP BY t.id"
        }
        CatalogKind::Formats => {
            "SELECT
            UPPER(d.format) AS id,
            UPPER(d.format) AS title,
            LOWER(d.format) AS sort,
            COUNT(DISTINCT d.book) AS bookCount
          FROM data d
          GROUP BY UPPER(d.format)"
        }
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<CatalogEntry> {
    let id: V = row.get(0)?;
    let id = match id {
        V::Text(s) => CatalogId::Text(s),
        V::Integer(i) => CatalogId::Num(i),
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                0,
                "id".to_string(),
                rusqlite::types::Type::Null,
            ))
        }
    };
    Ok(CatalogEntry {
        id,
        title: value_string(&row.get::<_, V>(1)?),
        sort: value_string(&row.get::<_, V>(2)?),
        book_count: value_opt_i64(&row.get::<_, V>(3)?).unwrap_or(0),
    })
}

pub(crate) fn list_catalog_entries(
    shared: &Arc<Shared>,
    kind: CatalogKind,
    options: &CatalogOptions,
) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
    let checkout = shared.checkout()?;
    let conn: &Connection = &checkout;

    let limit = clamp_limit(options.limit, 100, 200);
    let sort_order = options.sort_order.unwrap_or(SortOrder::Asc);
    let dir = if sort_order.is_asc() { "ASC" } else { "DESC" };
    let sort_op = if sort_order.is_asc() { ">" } else { "<" };

    let cursor_data = match &options.cursor {
        Some(cursor) => Some(decode_catalog_cursor(cursor).ok_or(DbError::InvalidCursor)?),
        None => None,
    };
    let (cursor_where, cursor_params): (String, Vec<V>) = match cursor_data {
        Some((id, sort)) => (
            format!("WHERE (sort {sort_op} ? OR (sort = ? AND id {sort_op} ?))"),
            vec![
                V::Text(sort.clone()),
                V::Text(sort),
                match id {
                    CatalogId::Num(n) => V::Integer(n),
                    CatalogId::Text(s) => V::Text(s),
                },
            ],
        ),
        None => (String::new(), Vec::new()),
    };

    let query = format!(
        "WITH catalog AS ({})
      SELECT id, title, sort, bookCount
      FROM catalog
      {}
      ORDER BY sort {dir}, id {dir}
      LIMIT {}",
        catalog_cte(kind),
        cursor_where,
        limit as i64 + 1
    );

    let mut rows_out: Vec<CatalogEntry> = Vec::new();
    {
        let mut stmt = conn.prepare(&query)?;
        let mut rows = stmt.query(params_from_iter(cursor_params.iter()))?;
        while let Some(row) = rows.next()? {
            rows_out.push(row_to_entry(row)?);
        }
    }
    let has_more = rows_out.len() > limit as usize;
    let take = (limit as usize).min(rows_out.len());
    let items: Vec<CatalogEntry> = rows_out.drain(..take).collect();
    let next_cursor = match (has_more, items.last()) {
        (true, Some(last)) => Some(encode_catalog_cursor(&last.id, &last.sort)),
        _ => None,
    };
    Ok(CursorPaginatedResult {
        items,
        next_cursor,
        has_more,
        total: None,
    })
}

/// `Number.parseInt(String(id), 10)`-equivalent leniency for numeric catalog
/// lookups given a text id.
fn lenient_parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let mut digits = String::new();
    let mut chars = trimmed.chars();
    if let Some(first) = chars.clone().next() {
        if first == '-' || first == '+' {
            digits.push(first);
            chars.next();
        }
    }
    for ch in chars {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() || digits == "-" || digits == "+" {
        return None;
    }
    digits.parse::<i64>().ok()
}

pub(crate) fn get_catalog_entry(
    shared: &Arc<Shared>,
    kind: CatalogKind,
    id: &CatalogId,
) -> Option<CatalogEntry> {
    let checkout = shared.checkout().ok()?;
    let conn: &Connection = &checkout;

    if kind == CatalogKind::Formats {
        let format = match id {
            CatalogId::Text(s) => s.to_uppercase(),
            CatalogId::Num(n) => n.to_string().to_uppercase(),
        };
        let sql = "
          SELECT
            UPPER(d.format) AS id,
            UPPER(d.format) AS title,
            LOWER(d.format) AS sort,
            COUNT(DISTINCT d.book) AS bookCount
          FROM data d
          WHERE d.format = ?
          GROUP BY UPPER(d.format)";
        return conn.query_row(sql, [format], row_to_entry).ok();
    }

    let numeric_id = match id {
        CatalogId::Num(n) => Some(*n),
        CatalogId::Text(s) => lenient_parse_int(s),
    }?;
    let sql = match kind {
        CatalogKind::Authors => {
            "
        SELECT
          a.id,
          a.name AS title,
          LOWER(COALESCE(a.sort, a.name)) AS sort,
          COUNT(DISTINCT bal.book) AS bookCount
        FROM authors a
        JOIN books_authors_link bal ON a.id = bal.author
        WHERE a.id = ?
        GROUP BY a.id"
        }
        CatalogKind::Series => {
            "
        SELECT
          s.id,
          s.name AS title,
          LOWER(COALESCE(s.sort, s.name)) AS sort,
          COUNT(DISTINCT bsl.book) AS bookCount
        FROM series s
        JOIN books_series_link bsl ON s.id = bsl.series
        WHERE s.id = ?
        GROUP BY s.id"
        }
        CatalogKind::Tags => {
            "
        SELECT
          t.id,
          t.name AS title,
          LOWER(t.name) AS sort,
          COUNT(DISTINCT btl.book) AS bookCount
        FROM tags t
        JOIN books_tags_link btl ON t.id = btl.tag
        WHERE t.id = ?
        GROUP BY t.id"
        }
        CatalogKind::Formats => unreachable!("handled above"),
    };
    conn.query_row(sql, [numeric_id], row_to_entry).ok()
}

pub(crate) fn list_all_tags(shared: &Arc<Shared>, limit: u32) -> Vec<TagSummary> {
    let capped = limit.clamp(1, 5000);
    let Ok(checkout) = shared.checkout() else {
        return Vec::new();
    };
    let sql = "
        SELECT
          t.id AS id,
          t.name AS name,
          COUNT(DISTINCT btl.book) AS bookCount
        FROM tags t
        JOIN books_tags_link btl ON t.id = btl.tag
        GROUP BY t.id
        ORDER BY bookCount DESC, t.name COLLATE NOCASE ASC
        LIMIT ?";
    let Ok(mut stmt) = checkout.prepare(sql) else {
        return Vec::new();
    };
    let Ok(mut rows) = stmt.query([capped as i64]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        out.push(TagSummary {
            id: row.get::<_, i64>(0).unwrap_or_default(),
            name: value_string(&row.get::<_, V>(1).unwrap_or(V::Null)),
            book_count: value_opt_i64(&row.get::<_, V>(2).unwrap_or(V::Null)).unwrap_or(0),
        });
    }
    out
}

pub(crate) fn list_all_formats(shared: &Arc<Shared>) -> Vec<FormatSummary> {
    let Ok(checkout) = shared.checkout() else {
        return Vec::new();
    };
    let sql = "
        SELECT
          UPPER(d.format) AS name,
          COUNT(DISTINCT d.book) AS bookCount
        FROM data d
        WHERE d.format IS NOT NULL AND TRIM(d.format) != ''
        GROUP BY UPPER(d.format)
        ORDER BY bookCount DESC, name ASC";
    let Ok(mut stmt) = checkout.prepare(sql) else {
        return Vec::new();
    };
    let Ok(mut rows) = stmt.query([]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        out.push(FormatSummary {
            name: value_string(&row.get::<_, V>(0).unwrap_or(V::Null)),
            book_count: value_opt_i64(&row.get::<_, V>(1).unwrap_or(V::Null)).unwrap_or(0),
        });
    }
    out
}

/// Shared SELECT shape of `searchBooksByTitle` / `searchBooksByAuthor` (port
/// of the big fan-out query with `json_group_array(...) FILTER` aggregates).
const SEARCH_SELECT: &str = "
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
      {WHERE_CLAUSE}
      GROUP BY b.id
      ORDER BY b.sort ASC
      LIMIT ?";

/// `searchBooksByTitle` — FTS5 prefix MATCH.
pub(crate) fn search_books_by_title(
    shared: &Arc<Shared>,
    title: &str,
    limit: u32,
) -> Vec<caliber_common::BookListItem> {
    let capped = limit.clamp(1, 200);
    let words = fts_words(title);
    if words.is_empty() {
        return Vec::new();
    }
    let fts_query = fts_match_query(&words);
    let sql = SEARCH_SELECT.replace(
        "{WHERE_CLAUSE}",
        "WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)",
    );
    collect_search_rows(shared, &sql, rusqlite::params![fts_query, capped as i64])
}

/// `searchBooksByAuthor` — LIKE over author name/sort.
pub(crate) fn search_books_by_author(
    shared: &Arc<Shared>,
    author: &str,
    limit: u32,
) -> Vec<caliber_common::BookListItem> {
    let capped = limit.clamp(1, 200);
    let search_term = format!("%{}%", author.trim());
    let sql = SEARCH_SELECT.replace(
        "{WHERE_CLAUSE}",
        "WHERE b.id IN (
        SELECT bal2.book
        FROM books_authors_link bal2
        JOIN authors a2 ON bal2.author = a2.id
        WHERE a2.name LIKE ? OR a2.sort LIKE ?
      )",
    );
    collect_search_rows(
        shared,
        &sql,
        rusqlite::params![search_term, search_term, capped as i64],
    )
}

fn collect_search_rows<P: rusqlite::Params>(
    shared: &Arc<Shared>,
    sql: &str,
    params: P,
) -> Vec<caliber_common::BookListItem> {
    let Ok(checkout) = shared.checkout() else {
        return Vec::new();
    };
    let Ok(mut stmt) = checkout.prepare(sql) else {
        return Vec::new();
    };
    let Ok(mut rows) = stmt.query(params) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        out.push(crate::detail::parse_search_row(row));
    }
    out
}

pub(crate) fn get_author_by_name(shared: &Arc<Shared>, name: &str) -> Option<AuthorInfo> {
    let checkout = shared.checkout().ok()?;
    let search_term = format!("%{}%", name.trim());
    let sql = "
      SELECT a.name, COUNT(bal.book) as book_count
      FROM authors a
      LEFT JOIN books_authors_link bal ON a.id = bal.author
      WHERE a.name LIKE ? OR a.sort LIKE ?
      GROUP BY a.id
      ORDER BY book_count DESC
      LIMIT 1";
    let (author_name, book_count): (String, i64) = checkout
        .query_row(sql, rusqlite::params![search_term, search_term], |row| {
            Ok((
                value_string(&row.get::<_, V>(0)?),
                value_opt_i64(&row.get::<_, V>(1)?).unwrap_or(0),
            ))
        })
        .ok()?;
    Some(AuthorInfo {
        name: author_name,
        book_count,
    })
}
