//! The cursor-paginated listing engine — a port of `listBooksWithWhere` and
//! its helpers (`appendBookCursorWhere`, `buildBookOrderBy`, tag/format
//! filters, FTS query building). Sort expressions come from
//! `caliber_common::book_sort_expression` so ORDER BY, cursor predicates, and
//! the snapshot expression indexes agree byte-for-byte.

use crate::error::DbError;
use crate::snapshot::Shared;
use crate::util::{value_bool, value_f64, value_opt_i64, value_opt_string, value_string};
use caliber_common::types::{
    book_sort_expression, BookListItem, ListOptions, SortField, SortOrder,
};
use caliber_common::{decode_book_cursor, encode_book_cursor, CursorPaginatedResult, CursorSort};
use rusqlite::types::Value as V;
use rusqlite::{params_from_iter, Connection};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) const DEFAULT_LIST_LIMIT: u32 = 100;
pub(crate) const MAX_LIST_LIMIT: u32 = 200;

pub(crate) fn clamp_limit(limit: Option<u32>, fallback: u32, max: u32) -> u32 {
    limit.unwrap_or(fallback).clamp(1, max)
}

/// Bind a cursor sort number the way SQLite stores it (integers as INTEGER so
/// expression-index seeks stay native).
fn number_param(n: f64) -> V {
    if n.is_finite() && n == n.trunc() && n.abs() <= 9_007_199_254_740_992.0 {
        V::Integer(n as i64)
    } else {
        V::Real(n)
    }
}

fn is_valid_format(value: &str) -> bool {
    (1..=10).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// `buildTagFilterClause`: `b.id IN (...)` with OR semantics over deduped,
/// positive ids. Returns the clause fragment and the ids to bind.
fn build_tag_filter(tag_ids: &[i64]) -> (String, Vec<i64>) {
    if tag_ids.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut ids: Vec<i64> = Vec::new();
    for id in tag_ids {
        if *id > 0 && !ids.contains(id) {
            ids.push(*id);
        }
    }
    if ids.is_empty() {
        return (String::new(), Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    (
        format!("b.id IN (SELECT book FROM books_tags_link WHERE tag IN ({placeholders}))"),
        ids,
    )
}

/// `buildFormatFilterClause`: OR semantics over normalized (uppercased)
/// formats; matching is case-insensitive against `UPPER(data.format)`.
fn build_format_filter(formats: &[String]) -> (String, Vec<String>) {
    if formats.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut values: Vec<String> = Vec::new();
    for format in formats {
        let normalized = format.trim().to_uppercase();
        if is_valid_format(&normalized) && !values.contains(&normalized) {
            values.push(normalized);
        }
    }
    if values.is_empty() {
        return (String::new(), Vec::new());
    }
    let placeholders = vec!["?"; values.len()].join(",");
    (
        format!("b.id IN (SELECT book FROM data WHERE UPPER(format) IN ({placeholders}))"),
        values,
    )
}

/// `buildBookOrderBy`: the ORDER BY clause matching the cursor predicates.
fn build_book_order_by(sort_by: SortField, sort_order: SortOrder) -> String {
    let dir = if sort_order.is_asc() { "ASC" } else { "DESC" };
    if sort_by == SortField::Rating {
        // Rating tie-break is p.book (not b.id): only p.book matches
        // idx_book_list_projection_rating(rating, book)'s second column.
        return format!("ORDER BY p.rating {dir}, p.book {dir}");
    }
    let expr = book_sort_expression(sort_by);
    format!("ORDER BY {expr} {dir}, b.id {dir}")
}

/// `appendBookCursorWhere`: decode + validate the cursor and append the
/// sargable seek predicate
/// `expr {>=|<=} ? AND (expr {>|<} ? OR (expr = ? AND id {>|<} ?))`.
fn append_book_cursor_where(
    base: &str,
    params: &mut Vec<V>,
    cursor: &Option<String>,
    sort_by: SortField,
    sort_order: SortOrder,
) -> Result<String, DbError> {
    let Some(cursor) = cursor.as_deref() else {
        return Ok(base.to_string());
    };
    let decoded = decode_book_cursor(cursor).ok_or(DbError::InvalidCursor)?;
    let asc = sort_order.is_asc();
    let sort_op = if asc { ">" } else { "<" };
    let seek_op = if asc { ">=" } else { "<=" };
    let expr = book_sort_expression(sort_by);

    let (sort_params, id_column) = match (sort_by, &decoded.sort) {
        (SortField::Rating, CursorSort::Number(n)) => (vec![number_param(*n); 3], "p.book"),
        (SortField::SeriesIndex, CursorSort::Number(n)) => (vec![number_param(*n); 3], "b.id"),
        (SortField::Rating | SortField::SeriesIndex, _) => {
            // Cursor sort value does not match {rating,series_index} sort.
            return Err(DbError::InvalidCursor);
        }
        (_, CursorSort::Text(s)) => (vec![V::Text(s.clone()); 3], "b.id"),
        (_, CursorSort::Number(_)) => {
            // Cursor sort value does not match {title,author,added} sort.
            return Err(DbError::InvalidCursor);
        }
    };
    params.extend(sort_params);
    params.push(V::Integer(decoded.id));
    Ok(format!(
        "{base} AND {expr} {seek_op} ? AND ({expr} {sort_op} ? OR ({expr} = ? AND {id_column} {sort_op} ?))"
    ))
}

struct PageRow {
    id: i64,
    cursor_sort: V,
    rating_val: Option<i64>,
}

fn value_to_cursor_sort(value: &V) -> Option<CursorSort> {
    match value {
        V::Text(s) => Some(CursorSort::Text(s.clone())),
        V::Integer(i) => Some(CursorSort::Number(*i as f64)),
        V::Real(f) if f.is_finite() => Some(CursorSort::Number(*f)),
        _ => None,
    }
}

struct BaseRow {
    id: i64,
    title: String,
    sort: Option<String>,
    author_sort: Option<String>,
    series_index: f64,
    has_cover: bool,
    pubdate: String,
    timestamp: String,
    last_modified: Option<String>,
    uuid: Option<String>,
    series: Option<String>,
    rating: Option<i64>,
}

fn load_facet(
    conn: &Connection,
    sql: &str,
    ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, DbError> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params_from_iter(ids.iter()))?;
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let book: i64 = row.get(0)?;
        let name: V = row.get(1)?;
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
    Ok(by_id)
}

/// The shared listing engine (`listBooksWithWhere`). Two-phase page query
/// (ids + SQL-computed `cursor_sort`), then base-row and per-facet
/// `IN (...)` queries for exactly the page's ids.
pub(crate) fn list_books_with_where(
    shared: &Arc<Shared>,
    options: &ListOptions,
    initial_where: &str,
    initial_params: Vec<V>,
) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
    let checkout = shared.checkout()?;
    let conn: &Connection = &checkout;

    let limit = clamp_limit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let sort_by = options.sort_by();
    let sort_order = options.sort_order();
    let dir = if sort_order.is_asc() { "ASC" } else { "DESC" };

    let mut params = initial_params;
    let (tag_clause, tag_ids) = build_tag_filter(&options.tag_ids);
    let (format_clause, format_values) = build_format_filter(&options.formats);
    let mut base_where = initial_where.to_string();
    if !tag_clause.is_empty() {
        base_where.push_str(" AND ");
        base_where.push_str(&tag_clause);
    }
    if !format_clause.is_empty() {
        base_where.push_str(" AND ");
        base_where.push_str(&format_clause);
    }
    for id in &tag_ids {
        params.push(V::Integer(*id));
    }
    for format in &format_values {
        params.push(V::Text(format.clone()));
    }
    let formats_where = if options.require_formats {
        format!("{base_where} AND EXISTS (SELECT 1 FROM data d WHERE d.book = b.id)")
    } else {
        base_where
    };

    // Cheap first-page total — COUNT(*) with the same base filters but
    // WITHOUT the cursor predicate, only when include_total is set and this
    // is the first page.
    let mut total: Option<i64> = None;
    if options.include_total && options.cursor.is_none() {
        let count_sql = format!("SELECT COUNT(*) as count FROM books b {formats_where}");
        total = Some(
            conn.query_row(&count_sql, params_from_iter(params.iter()), |row| {
                row.get::<_, i64>(0)
            })?,
        );
    }

    let book_where = append_book_cursor_where(
        &formats_where,
        &mut params,
        &options.cursor,
        sort_by,
        sort_order,
    )?;

    // Phase 1: fetch just the page of IDs (+ cursor sort keys). No fan-out
    // joins here, so the keyset seek stays O(log n).
    let page_query = if sort_by == SortField::Rating {
        format!(
            "SELECT b.id, p.rating AS rating_val,
               p.rating AS cursor_sort
            FROM books b
            JOIN book_list_projection p ON p.book = b.id
            {book_where}
            ORDER BY p.rating {dir}, p.book {dir}
            LIMIT {}",
            limit as i64 + 1
        )
    } else {
        let expr = book_sort_expression(sort_by);
        let order_by = build_book_order_by(sort_by, sort_order);
        format!(
            "SELECT b.id, {expr} AS cursor_sort
            FROM books b
            {book_where}
            {order_by}
            LIMIT {}",
            limit as i64 + 1
        )
    };
    let mut page_rows: Vec<PageRow> = Vec::new();
    {
        let mut stmt = conn.prepare(&page_query)?;
        let mut rows = stmt.query(params_from_iter(params.iter()))?;
        while let Some(row) = rows.next()? {
            let rating_val = if sort_by == SortField::Rating {
                value_opt_i64(&row.get::<_, V>(1)?)
            } else {
                None
            };
            let cursor_index = if sort_by == SortField::Rating { 2 } else { 1 };
            page_rows.push(PageRow {
                id: row.get::<_, i64>(0)?,
                cursor_sort: row.get::<_, V>(cursor_index)?,
                rating_val,
            });
        }
    }

    let has_more = page_rows.len() > limit as usize;
    let take = (limit as usize).min(page_rows.len());
    let page: Vec<PageRow> = page_rows.drain(..take).collect();
    if page.is_empty() {
        return Ok(CursorPaginatedResult {
            items: Vec::new(),
            next_cursor: None,
            has_more,
            total,
        });
    }
    let ids: Vec<i64> = page.iter().map(|row| row.id).collect();
    let placeholders = vec!["?"; ids.len()].join(",");

    // Phase 2: base columns + series/rating for exactly this page.
    let base_sql = format!(
        "SELECT b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover,
                b.pubdate, b.timestamp, b.last_modified, b.uuid, s.name as series, r.rating
         FROM books b
         LEFT JOIN books_series_link bsl ON b.id = bsl.book
         LEFT JOIN series s ON bsl.series = s.id
         LEFT JOIN books_ratings_link brl ON b.id = brl.book
         LEFT JOIN ratings r ON brl.rating = r.id
         WHERE b.id IN ({placeholders})"
    );
    let mut base_by_id: HashMap<i64, BaseRow> = HashMap::new();
    {
        let mut stmt = conn.prepare(&base_sql)?;
        let mut rows = stmt.query(params_from_iter(ids.iter()))?;
        while let Some(row) = rows.next()? {
            let base = BaseRow {
                id: row.get::<_, i64>(0)?,
                title: value_string(&row.get::<_, V>(1)?),
                sort: value_opt_string(&row.get::<_, V>(2)?),
                author_sort: value_opt_string(&row.get::<_, V>(3)?),
                series_index: value_f64(&row.get::<_, V>(4)?),
                has_cover: value_bool(&row.get::<_, V>(5)?),
                pubdate: value_string(&row.get::<_, V>(6)?),
                timestamp: value_string(&row.get::<_, V>(7)?),
                last_modified: value_opt_string(&row.get::<_, V>(8)?),
                uuid: value_opt_string(&row.get::<_, V>(9)?),
                series: value_opt_string(&row.get::<_, V>(10)?),
                rating: value_opt_i64(&row.get::<_, V>(11)?),
            };
            base_by_id.insert(base.id, base);
        }
    }

    // Phase 3: one aggregate query per multi-valued facet (authors, tags,
    // formats) over the page's IDs.
    let authors_by_id = load_facet(
        conn,
        &format!(
            "SELECT bal.book as book, a.name as name FROM books_authors_link bal JOIN authors a ON bal.author = a.id WHERE bal.book IN ({placeholders})"
        ),
        &ids,
    )?;
    let tags_by_id = load_facet(
        conn,
        &format!(
            "SELECT btl.book as book, t.name as name FROM books_tags_link btl JOIN tags t ON btl.tag = t.id WHERE btl.book IN ({placeholders})"
        ),
        &ids,
    )?;
    let formats_by_id = load_facet(
        conn,
        &format!(
            "SELECT d.book as book, d.format as name FROM data d WHERE d.book IN ({placeholders})"
        ),
        &ids,
    )?;

    let mut items: Vec<BookListItem> = Vec::new();
    for row in &page {
        let Some(base) = base_by_id.get(&row.id) else {
            continue;
        };
        items.push(BookListItem {
            id: base.id,
            title: base.title.clone(),
            sort: base.sort.clone(),
            author_sort: base.author_sort.clone(),
            authors: authors_by_id.get(&base.id).cloned().unwrap_or_default(),
            series: base.series.clone(),
            series_index: base.series_index,
            tags: tags_by_id.get(&base.id).cloned().unwrap_or_default(),
            formats: formats_by_id.get(&base.id).cloned().unwrap_or_default(),
            has_cover: base.has_cover,
            pubdate: base.pubdate.clone(),
            timestamp: base.timestamp.clone(),
            // Rating sort pages carry the projection value (unrated = 0);
            // other sorts use the base LEFT JOIN value (unrated = null).
            rating: row.rating_val.or(base.rating),
            uuid: base.uuid.clone().filter(|s| !s.is_empty()),
            last_modified: base.last_modified.clone(),
        });
    }

    let next_cursor = if has_more && !items.is_empty() {
        let last = page.last().expect("has_more implies a non-empty page");
        let sort = value_to_cursor_sort(&last.cursor_sort).ok_or_else(|| {
            DbError::Internal(format!(
                "Book {} has no cursor_sort value for {} sort; the query must select cursor_sort",
                last.id,
                sort_by.as_str()
            ))
        })?;
        Some(encode_book_cursor(last.id, &sort))
    } else {
        None
    };

    Ok(CursorPaginatedResult {
        items,
        next_cursor,
        has_more,
        total,
    })
}

/// Split a search query into whitespace-separated words (FTS terms).
pub(crate) fn fts_words(query: &str) -> Vec<String> {
    query
        .trim()
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `ftsSearch` query build: escape `"` → `""`, wrap each word `"word"*`, join
/// with ` AND `.
pub(crate) fn fts_match_query(words: &[String]) -> String {
    words
        .iter()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `searchBooksCursor`: empty/whitespace query delegates to the plain list.
pub(crate) fn search_books(
    shared: &Arc<Shared>,
    options: &ListOptions,
    query: &str,
) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
    if query.trim().is_empty() {
        return list_books_with_where(shared, options, "WHERE 1=1", Vec::new());
    }
    let words = fts_words(query);
    if words.is_empty() {
        return list_books_with_where(shared, options, "WHERE 1=1", Vec::new());
    }
    let fts_query = fts_match_query(&words);
    list_books_with_where(
        shared,
        options,
        "WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)",
        vec![V::Text(fts_query)],
    )
}
