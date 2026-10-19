//! JSON API routes for books, stats, tags, formats, files, EPUB entries,
//! pages, covers, thumbnails, and the full-library stream.

use crate::backend::DbError;
use crate::cache::{cached_json, error_json, json_response, Produce};
use crate::epub::{get_epub_entry_path, EpubCacheError};
use crate::files::{
    is_valid_format_param, serve_book_file, serve_cover_by_id, serve_local_file, serve_thumb_by_id,
    ServeFileOptions,
};
use crate::helpers::{parse_bounded_int, parse_query_pairs};
use crate::pages::{get_page_file, get_page_manifest, PageStreamingError};
use crate::state::SharedState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use caliber_common::{BookListItem, ListOptions, SortField, SortOrder};
use futures::StreamExt;
use serde_json::{json, Value};

const MAX_QUERY_LIMIT: i64 = 100;
const MAX_STREAM_BATCH_SIZE: i64 = 5000;

pub fn parse_sort_field(value: Option<&str>) -> SortField {
    match value {
        Some("author") => SortField::Author,
        Some("added") => SortField::Added,
        Some("rating") => SortField::Rating,
        Some("series_index") => SortField::SeriesIndex,
        _ => SortField::Title,
    }
}

pub fn parse_sort_order(value: Option<&str>) -> SortOrder {
    match value {
        Some("desc") => SortOrder::Desc,
        _ => SortOrder::Asc,
    }
}

/// TS `parseBookId`: `^\d+$`, safe integer, > 0.
pub fn parse_book_id(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match value.parse::<i64>() {
        Ok(id) if id > 0 && id <= (1i64 << 53) => Some(id),
        _ => None,
    }
}

fn query_all<'a>(pairs: &'a [(String, String)], key: &str) -> Vec<&'a str> {
    pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .collect()
}

fn query_get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// Repeated `tag` params → deduped valid ids (OR logic, max 50).
fn parse_tag_ids(pairs: &[(String, String)]) -> Vec<i64> {
    let raw = query_all(pairs, "tag");
    if raw.is_empty() {
        return Vec::new();
    }
    let mut ids: Vec<i64> = Vec::new();
    for value in raw {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(id) = value.parse::<i64>() {
            if id > 0 && id <= (1i64 << 53) && !ids.contains(&id) {
                ids.push(id);
                if ids.len() >= 50 {
                    break;
                }
            }
        }
    }
    ids
}

/// Repeated `format` params → deduped uppercase names (OR logic, max 20).
fn parse_formats(pairs: &[(String, String)]) -> Vec<String> {
    let raw = query_all(pairs, "format");
    if raw.is_empty() {
        return Vec::new();
    }
    let mut formats: Vec<String> = Vec::new();
    for value in raw {
        let normalized = value.trim().to_ascii_uppercase();
        if !normalized.is_empty()
            && normalized.len() <= 10
            && normalized.bytes().all(|b| b.is_ascii_alphanumeric())
            && !formats.contains(&normalized)
        {
            formats.push(normalized);
            if formats.len() >= 20 {
                break;
            }
        }
    }
    formats
}

fn db_error_response(error: DbError, fallback: &str) -> Response {
    match error {
        DbError::InvalidCursor => error_json(400, "Invalid cursor"),
        DbError::NotReady(msg) | DbError::Io(msg) | DbError::Internal(msg) => {
            eprintln!("[server] db error: {msg}");
            error_json(500, fallback)
        }
    }
}

fn serialize_books_result(result: &caliber_common::CursorPaginatedResult<BookListItem>) -> Value {
    serde_json::to_value(result).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn health() -> Response {
    json_response(
        200,
        &json!({ "status": "ok", "timestamp": crate::helpers::now_millis() }),
        &[],
    )
}

pub async fn stats(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let db = state.db.clone();
    cached_json(state, &headers, "stats".into(), move || {
        match db.get_library_stats() {
            Ok(s) => Produce::Value(json!({
                "totalBooks": s.total_books,
                "totalAuthors": s.total_authors,
                "totalSeries": s.total_series,
                "totalTags": s.total_tags,
            })),
            Err(e) => Produce::Bypass(db_error_response(e, "Failed to get library stats")),
        }
    })
    .await
}

pub async fn tags(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let db = state.db.clone();
    cached_json(state, &headers, "tags".into(), move || {
        Produce::Value(serde_json::to_value(db.list_all_tags(2000)).unwrap_or(Value::Null))
    })
    .await
}

pub async fn formats(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let db = state.db.clone();
    cached_json(state, &headers, "formats".into(), move || {
        Produce::Value(serde_json::to_value(db.list_all_formats()).unwrap_or(Value::Null))
    })
    .await
}

pub async fn book_count(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let db = state.db.clone();
    cached_json(state, &headers, "count".into(), move || {
        match db.get_book_count() {
            Ok(count) => Produce::Value(json!({ "count": count })),
            Err(e) => Produce::Bypass(db_error_response(e, "Failed to count books")),
        }
    })
    .await
}

pub struct BookListParams {
    pub cursor: Option<String>,
    pub limit: u32,
    pub sort_by: SortField,
    pub sort_order: SortOrder,
    pub tag_ids: Vec<i64>,
    pub formats: Vec<String>,
    pub include_total: bool,
    pub cache_base: String,
}

pub fn parse_book_list_params(uri: &Uri, default_limit: i64) -> BookListParams {
    let pairs = parse_query_pairs(uri.query());
    let cursor = query_get(&pairs, "cursor")
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let limit = parse_bounded_int(
        query_get(&pairs, "limit"),
        default_limit,
        1,
        MAX_QUERY_LIMIT,
    ) as u32;
    let sort_by = parse_sort_field(query_get(&pairs, "sortBy"));
    let sort_order = parse_sort_order(query_get(&pairs, "sortOrder"));
    let tag_ids = parse_tag_ids(&pairs);
    let formats = parse_formats(&pairs);
    let include_param = query_get(&pairs, "includeTotal");
    let want_total = match include_param {
        None => cursor.is_none(),
        Some(v) => v == "1" || v.eq_ignore_ascii_case("true"),
    };
    let cache_base = format!(
        "books:{}:{}:{}:{}:tags:{}:formats:{}:total:{}",
        cursor.as_deref().unwrap_or("first"),
        limit,
        sort_by.as_str(),
        sort_order.as_str(),
        tag_ids
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(","),
        formats.join(","),
        if want_total { 1 } else { 0 }
    );
    BookListParams {
        cursor,
        limit,
        sort_by,
        sort_order,
        tag_ids,
        formats,
        include_total: want_total,
        cache_base,
    }
}

fn list_options(params: &BookListParams, require_formats: bool) -> ListOptions {
    ListOptions {
        cursor: params.cursor.clone(),
        limit: Some(params.limit),
        sort_by: Some(params.sort_by),
        sort_order: Some(params.sort_order),
        tag_ids: params.tag_ids.clone(),
        formats: params.formats.clone(),
        require_formats,
        include_total: params.include_total,
    }
}

pub async fn books_list(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let params = parse_book_list_params(&uri, 50);
    let db = state.db.clone();
    cached_json(state, &headers, params.cache_base.clone(), move || {
        let opts = list_options(&params, false);
        match db.list_books(&opts) {
            Ok(result) => Produce::Value(serialize_books_result(&result)),
            Err(e) => Produce::Bypass(db_error_response(e, "Failed to list books")),
        }
    })
    .await
}

pub async fn books_search(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let pairs = parse_query_pairs(uri.query());
    let query = query_get(&pairs, "q").unwrap_or("").to_string();
    let params = parse_book_list_params(&uri, 50);

    if query.trim().is_empty() {
        let db = state.db.clone();
        return cached_json(state, &headers, params.cache_base.clone(), move || {
            let opts = list_options(&params, false);
            match db.list_books(&opts) {
                Ok(result) => Produce::Value(serialize_books_result(&result)),
                Err(e) => Produce::Bypass(db_error_response(e, "Failed to search books")),
            }
        })
        .await;
    }

    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(move || {
        let opts = list_options(&params, false);
        db.search_books(&opts, &query)
    })
    .await;
    match result {
        Ok(Ok(result)) => json_response(
            200,
            &serialize_books_result(&result),
            &[("cache-control", "no-store".to_string())],
        ),
        Ok(Err(e)) => db_error_response(e, "Failed to search books"),
        Err(_) => error_json(500, "Failed to search books"),
    }
}

pub async fn book_detail(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    let db = state.db.clone();
    cached_json(state, &headers, format!("book:{id}"), move || {
        match db.get_book(id) {
            Ok(Some(book)) => Produce::Value(serde_json::to_value(&book).unwrap_or(Value::Null)),
            Ok(None) => Produce::Bypass(error_json(404, "Book not found")),
            Err(e) => Produce::Bypass(db_error_response(e, "Failed to get book")),
        }
    })
    .await
}

fn epub_error_response(error: EpubCacheError) -> Response {
    crate::cache::error_json_with_code(error.status, &error.message, &error.code)
}

fn page_error_response(error: PageStreamingError) -> Response {
    error_json(error.status, &error.message)
}

pub async fn book_download(
    State(state): State<SharedState>,
    Path((id, format)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    serve_book_file(&state, &method, &headers, id, &format, "attachment").await
}

pub async fn book_file_inline(
    State(state): State<SharedState>,
    Path((id, format)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    serve_book_file(&state, &method, &headers, id, &format, "inline").await
}

/// `/api/books/:id/epub` → 308 to `epub/` (query preserved).
pub async fn epub_redirect(State(_state): State<SharedState>, uri: Uri) -> Response {
    let path = uri.path().to_string();
    let id = path
        .strip_prefix("/api/books/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    let location = match uri.query() {
        Some(q) => format!("/api/books/{id}/epub/?{q}"),
        None => format!("/api/books/{id}/epub/"),
    };
    axum::http::Response::builder()
        .status(StatusCode::PERMANENT_REDIRECT)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .unwrap()
}

const OPTIONAL_EPUB_DISPLAY_OPTIONS_PATH: &str = "META-INF/com.apple.ibooks.display-options.xml";
const DEFAULT_EPUB_DISPLAY_OPTIONS: &str =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<display_options/>";
const EPUB_ENTRY_CSP: &str =
    "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;";

/// `/api/books/:id/epub/**` — the raw (percent-encoded) remainder selects the
/// archive entry; default `META-INF/container.xml`. The rest comes from the
/// raw URI (percent-encoded, TS-equivalent decode downstream).
pub async fn epub_entry(
    State(state): State<SharedState>,
    Path((id, _rest)): Path<(String, String)>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    epub_entry_shared(state, id, uri, method, headers).await
}

/// Explicit `/api/books/:id/epub/` route (empty remainder; matchit does not
/// match an empty `{*rest}`).
pub async fn epub_entry_default(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    epub_entry_shared(state, id, uri, method, headers).await
}

async fn epub_entry_shared(
    state: SharedState,
    id: String,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    let raw_path = uri.path();
    let prefix = format!("/api/books/{id}/epub/");
    let entry_path = match raw_path.strip_prefix(&prefix) {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => "META-INF/container.xml".to_string(),
    };

    match get_epub_entry_path(&state, id, &entry_path).await {
        Ok(Some(file_path)) => {
            let decoded = crate::helpers::js_decode_uri_component(&entry_path)
                .unwrap_or_else(|_| entry_path.clone());
            serve_local_file(
                &method,
                &headers,
                &file_path,
                ServeFileOptions {
                    content_type: crate::files::entry_content_type(&decoded),
                    content_disposition: None,
                    cache_control: Some("no-cache"),
                    content_security_policy: Some(EPUB_ENTRY_CSP),
                },
            )
            .await
        }
        Ok(None) => {
            if decoded_optional(&entry_path) == OPTIONAL_EPUB_DISPLAY_OPTIONS_PATH {
                axum::http::Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .body(Body::from(if method == Method::HEAD {
                        Vec::new()
                    } else {
                        DEFAULT_EPUB_DISPLAY_OPTIONS.as_bytes().to_vec()
                    }))
                    .unwrap()
            } else {
                error_json(404, "EPUB entry not found")
            }
        }
        Err(error) => epub_error_response(error),
    }
}

fn decoded_optional(entry_path: &str) -> String {
    crate::helpers::js_decode_uri_component(entry_path).unwrap_or_else(|_| entry_path.to_string())
}

pub async fn page_manifest(
    State(state): State<SharedState>,
    Path((id, format)): Path<(String, String)>,
    method: Method,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    if !is_valid_format_param(&format) {
        return error_json(400, "Invalid format");
    }
    match get_page_manifest(&state, id, &format).await {
        Ok(manifest) => {
            let body = if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(manifest.to_string())
            };
            axum::http::Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(body)
                .unwrap()
        }
        Err(error) => page_error_response(error),
    }
}

pub async fn page_file(
    State(state): State<SharedState>,
    Path((id, format, page)): Path<(String, String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid page request");
    };
    let Some(page) = parse_book_id(&page) else {
        return error_json(400, "Invalid page request");
    };
    if !is_valid_format_param(&format) {
        return error_json(400, "Invalid format");
    }
    match get_page_file(&state, id, &format, page).await {
        Ok((path, content_type)) => {
            serve_local_file(
                &method,
                &headers,
                &path,
                ServeFileOptions {
                    content_type,
                    content_disposition: None,
                    cache_control: Some("no-cache"),
                    content_security_policy: Some(
                        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
                    ),
                },
            )
            .await
        }
        Err(error) => page_error_response(error),
    }
}

pub async fn book_cover(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    serve_cover_by_id(&state, &headers, id).await
}

pub async fn book_thumb(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(id) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    let pairs = parse_query_pairs(uri.query());
    let size = query_get(&pairs, "size");
    serve_thumb_by_id(&state, &headers, id, size).await
}

// ---------------------------------------------------------------------------
// /api/books/stream — chunked JSON array with a snapshot lease held for the
// duration; dropping the stream (client abort) releases it.
// ---------------------------------------------------------------------------

struct StreamState {
    state: SharedState,
    lease: Option<crate::backend::SnapshotLease>,
    last_id: i64,
    batch_size: u32,
    first_chunk: bool,
    finished: bool,
}

pub async fn books_stream(State(state): State<SharedState>, uri: Uri) -> Response {
    let pairs = parse_query_pairs(uri.query());
    let batch_size = parse_bounded_int(
        query_get(&pairs, "batchSize"),
        1000,
        1,
        MAX_STREAM_BATCH_SIZE,
    ) as u32;
    let lease = {
        let db = state.db.clone();
        match tokio::task::spawn_blocking(move || db.acquire_snapshot_lease()).await {
            Ok(lease) => lease,
            Err(_) => return error_json(500, "Failed to stream books"),
        }
    };

    let stream = futures::stream::unfold(
        StreamState {
            state: state.clone(),
            lease: Some(lease),
            last_id: 0,
            batch_size,
            first_chunk: true,
            finished: false,
        },
        |mut st| async move {
            if st.finished {
                return None;
            }
            let db = st.state.db.clone();
            let last_id = st.last_id;
            let batch_size = st.batch_size;
            let batch =
                tokio::task::spawn_blocking(move || db.stream_books_batch(last_id, batch_size))
                    .await;
            let rows = match batch {
                Ok(Ok(rows)) => rows,
                Ok(Err(e)) => {
                    st.finished = true;
                    let err = std::io::Error::other(format!(
                        "stream failed: {}",
                        match e {
                            DbError::InvalidCursor => "Invalid cursor".to_string(),
                            DbError::NotReady(m) | DbError::Io(m) | DbError::Internal(m) => m,
                        }
                    ));
                    return Some((Err(err), st));
                }
                Err(join) => {
                    st.finished = true;
                    return Some((
                        Err(std::io::Error::other(format!("join error: {join}"))),
                        st,
                    ));
                }
            };

            let mut chunk = String::new();
            if st.first_chunk {
                chunk.push('[');
                st.first_chunk = false;
            }
            let mut first_book = chunk == "[";
            for row in &rows {
                if !first_book {
                    chunk.push(',');
                }
                first_book = false;
                chunk.push_str(&serde_json::to_string(row).unwrap_or_default());
            }
            if !rows.is_empty() {
                st.last_id = rows.last().map(|r| r.id).unwrap_or(st.last_id);
            }
            let complete = rows.len() < st.batch_size as usize;
            if complete {
                chunk.push(']');
                st.finished = true;
                st.lease.take(); // release via drop
            }
            Some((Ok(bytes::Bytes::from(chunk)), st))
        },
    )
    .map(|res| {
        res.map_err(|e| -> std::boxed::Box<dyn std::error::Error + Send + Sync> { Box::new(e) })
    });

    axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}
