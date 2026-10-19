//! OPDS route handlers — port of the `/opds*` routes in src/index.ts using
//! the renderers in `crate::opds`.

use crate::backend::DbError;
use crate::cache::{cached_text, error_json, Produce};
use crate::helpers::{form_url_encode, parse_bounded_int, parse_query_pairs};
use crate::opds::*;
use crate::routes_books::{parse_book_id, parse_sort_field, parse_sort_order};
use crate::state::SharedState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::Response;
use caliber_common::{
    BookListItem, CatalogEntry, CatalogId, CatalogKind, CursorPaginatedResult, ListOptions,
    SortField, SortOrder,
};

const MAX_QUERY_LIMIT: i64 = 100;

/// TS `getPublicBaseUrl`.
pub fn get_public_base_url(state: &SharedState, headers: &HeaderMap, uri: &Uri) -> String {
    let resolved = state.config.resolved();
    if let Some(base) = resolved.base_url {
        return base;
    }
    let forwarded = |name: &str| -> Option<String> {
        if !resolved.trust_proxy {
            return None;
        }
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let host = forwarded("x-forwarded-host")
        .or_else(|| {
            headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .or_else(|| uri.host().map(|h| h.to_string()))
        .unwrap_or_default();
    let protocol = forwarded("x-forwarded-proto")
        .or_else(|| uri.scheme_str().map(str::to_string))
        .unwrap_or_else(|| "http".to_string());
    format!("{protocol}://{host}")
}

/// TS `getRequestPath`.
fn request_path(uri: &Uri) -> String {
    match uri.query() {
        Some(q) => format!("{}?{}", uri.path(), q),
        None => uri.path().to_string(),
    }
}

/// TS `buildPath`.
fn build_path(path: &str, params: &[(&str, Option<String>)]) -> String {
    let query: Vec<String> = params
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_ref()
                .filter(|v| !v.is_empty())
                .map(|v| format!("{}={}", key, form_url_encode(v)))
        })
        .collect();
    if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", query.join("&"))
    }
}

struct PageParams {
    cursor: Option<String>,
    limit: i64,
    sort_by: SortField,
    sort_order: SortOrder,
}

fn parse_page_params(uri: &Uri) -> PageParams {
    let pairs = parse_query_pairs(uri.query());
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    PageParams {
        cursor: get("cursor").filter(|c| !c.is_empty()).map(str::to_string),
        limit: parse_bounded_int(get("limit"), 50, 1, MAX_QUERY_LIMIT),
        sort_by: parse_sort_field(get("sortBy")),
        sort_order: parse_sort_order(get("sortOrder")),
    }
}

fn options_from(params: &PageParams, require_formats: bool) -> ListOptions {
    ListOptions {
        cursor: params.cursor.clone(),
        limit: Some(params.limit as u32),
        sort_by: Some(params.sort_by),
        sort_order: Some(params.sort_order),
        require_formats,
        include_total: false,
        ..Default::default()
    }
}

/// What the acquisition producer queries.
#[derive(Clone)]
enum AcqQuery {
    All,
    Author(i64),
    Series(i64),
    Tag(i64),
    Format(String),
}

fn run_acq_sync(
    db: &std::sync::Arc<dyn crate::backend::CaliberBackend + Send + Sync>,
    query: &AcqQuery,
    opts: &ListOptions,
) -> Result<CursorPaginatedResult<BookListItem>, (u16, String)> {
    let result = match query {
        AcqQuery::All => db.list_books(opts),
        AcqQuery::Author(id) => db.list_books_by_author(*id, opts),
        AcqQuery::Series(id) => db.list_books_by_series(*id, opts),
        AcqQuery::Tag(id) => db.list_books_by_tag(*id, opts),
        AcqQuery::Format(format) => db.list_books_by_format(format, opts),
    };
    result.map_err(|_| (500u16, "Failed to render OPDS books".to_string()))
}

/// TS `opdsAcquisitionResponse`.
#[allow(clippy::too_many_arguments)]
async fn opds_acquisition_response(
    state: &SharedState,
    uri: &Uri,
    headers: &HeaderMap,
    title: String,
    base_path: String,
    query: AcqQuery,
    opts: ListOptions,
    next_sort: SortField,
    next_order: SortOrder,
    no_store: bool,
) -> Response {
    let params = parse_page_params(uri);
    let next_limit = params.limit;
    let base_url = get_public_base_url(state, headers, uri);
    let self_path = request_path(uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, headers);
    let updated = state.db.snapshot_updated_iso();
    let cache_base = format!("opds:acquisition:{base_url}:{path_prefix}:{self_path}");

    let render = {
        let base_url = base_url.clone();
        let path_prefix = path_prefix.clone();
        let self_path = self_path.clone();
        move |result: &CursorPaginatedResult<BookListItem>| -> String {
            let next_path = result.next_cursor.as_ref().map(|cursor| {
                build_path(
                    &base_path,
                    &[
                        ("cursor", Some(cursor.clone())),
                        ("limit", Some(next_limit.to_string())),
                        ("sortBy", Some(next_sort.as_str().to_string())),
                        ("sortOrder", Some(next_order.as_str().to_string())),
                    ],
                )
            });
            render_acquisition_feed(&AcquisitionFeedOptions {
                base_url: &base_url,
                path_prefix: &path_prefix,
                self_path: &self_path,
                title: &title,
                id: &absolute_url(&base_url, &self_path, &path_prefix),
                updated: &updated,
                result,
                next_path,
            })
        }
    };

    if no_store {
        let db = state.db.clone();
        let result = tokio::task::spawn_blocking(move || run_acq_sync(&db, &query, &opts))
            .await
            .unwrap_or(Err((500, "Failed to render OPDS search".to_string())));
        return match result {
            Ok(result) => axum::http::Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    format!("{OPDS_ACQUISITION_TYPE}; charset=utf-8"),
                )
                .header(header::CACHE_CONTROL, "no-store")
                .body(axum::body::Body::from(render(&result)))
                .unwrap(),
            Err((status, msg)) => error_json(status, &msg),
        };
    }

    let db = state.db.clone();
    cached_text(
        state.clone(),
        headers,
        cache_base,
        format!("{OPDS_ACQUISITION_TYPE}; charset=utf-8"),
        "public, max-age=60",
        move || match run_acq_sync(&db, &query, &opts) {
            Ok(result) => Produce::Value(render(&result)),
            Err((status, msg)) => Produce::Bypass(error_json(status, &msg)),
        },
    )
    .await
}

/// TS `opdsCatalogResponse` for the four facet navigation feeds.
async fn opds_catalog_response(
    state: &SharedState,
    uri: &Uri,
    headers: &HeaderMap,
    title: &str,
    base_path: &str,
    kind: CatalogKind,
    missing: &str,
) -> Response {
    let pairs = parse_query_pairs(uri.query());
    let cursor = pairs
        .iter()
        .find(|(k, _)| k == "cursor")
        .map(|(_, v)| v.clone())
        .filter(|c| !c.is_empty());
    let limit = parse_bounded_int(
        pairs
            .iter()
            .find(|(k, _)| k == "limit")
            .map(|(_, v)| v.as_str()),
        50,
        1,
        MAX_QUERY_LIMIT,
    );

    let base_url = get_public_base_url(state, headers, uri);
    let self_path = request_path(uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, headers);
    let updated = state.db.snapshot_updated_iso();
    let cache_base = format!("opds:catalog:{base_url}:{path_prefix}:{self_path}");

    let db = state.db.clone();
    let opts = caliber_common::CatalogOptions {
        cursor,
        limit: Some(limit as u32),
        sort_order: None,
    };
    let fail_msg = format!("Failed to render OPDS {title}");
    let missing = missing.to_string();
    let title = title.to_string();
    let base_path = base_path.to_string();
    cached_text(
        state.clone(),
        headers,
        cache_base,
        format!("{OPDS_NAVIGATION_TYPE}; charset=utf-8"),
        "public, max-age=60",
        move || {
            let result = match kind {
                CatalogKind::Authors => db.list_authors(&opts),
                CatalogKind::Series => db.list_series(&opts),
                CatalogKind::Tags => db.list_tags(&opts),
                CatalogKind::Formats => db.list_formats(&opts),
            };
            let result = match result {
                Ok(result) => result,
                Err(_) => return Produce::Bypass(error_json(500, &fail_msg)),
            };
            let next_path = result.next_cursor.as_ref().map(|cursor| {
                build_path(
                    &base_path,
                    &[
                        ("cursor", Some(cursor.clone())),
                        ("limit", Some(limit.to_string())),
                    ],
                )
            });
            let entry_hrefs: Vec<String> = result
                .items
                .iter()
                .map(|entry| {
                    let id = match &entry.id {
                        CatalogId::Num(n) => n.to_string(),
                        CatalogId::Text(t) => crate::helpers::js_encode_uri_component(t),
                    };
                    format!("{base_path}/{id}/books")
                })
                .collect();
            let _ = &missing;
            Produce::Value(render_catalog_feed(&CatalogFeedOptions {
                base_url: &base_url,
                path_prefix: &path_prefix,
                self_path: &self_path,
                title: &title,
                id: &absolute_url(&base_url, &self_path, &path_prefix),
                updated: &updated,
                result: &result,
                next_path,
                entry_hrefs,
            }))
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn opds_root(State(state): State<SharedState>, uri: Uri, headers: HeaderMap) -> Response {
    let base_url = get_public_base_url(&state, &headers, &uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, &headers);
    let updated = state.db.snapshot_updated_iso();
    let self_path = request_path(&uri);
    let cache_base = format!("opds:root:{base_url}:{path_prefix}:{self_path}");

    let db = state.db.clone();
    cached_text(
        state,
        &headers,
        cache_base,
        format!("{OPDS_NAVIGATION_TYPE}; charset=utf-8"),
        "public, max-age=60",
        move || match db.get_book_count() {
            Ok(total_books) => Produce::Value(render_navigation_feed(&NavigationFeedOptions {
                base_url: &base_url,
                path_prefix: &path_prefix,
                updated: &updated,
                total_books,
            })),
            Err(_) => Produce::Bypass(error_json(500, "Failed to render OPDS root")),
        },
    )
    .await
}

pub async fn opds_search_description(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let base_url = get_public_base_url(&state, &headers, &uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, &headers);
    let self_path = request_path(&uri);
    let cache_base = format!("opds:search-description:{base_url}:{path_prefix}:{self_path}");

    cached_text(
        state,
        &headers,
        cache_base,
        format!("{OPENSEARCH_TYPE}; charset=utf-8"),
        "public, max-age=3600",
        move || Produce::Value(render_open_search_description(&base_url, &path_prefix)),
    )
    .await
}

pub async fn opds_books(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let params = parse_page_params(&uri);
    let title = if params.sort_by == SortField::Added {
        "Recently added"
    } else {
        "All books"
    }
    .to_string();
    let sort = params.sort_by;
    let order = params.sort_order;
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        title,
        "/opds/books".to_string(),
        AcqQuery::All,
        options_from(&params, true),
        sort,
        order,
        false,
    )
    .await
}

pub async fn opds_recent(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let mut params = parse_page_params(&uri);
    params.sort_by = SortField::Added;
    params.sort_order = SortOrder::Desc;
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        "Recently added".to_string(),
        "/opds/recent".to_string(),
        AcqQuery::All,
        options_from(&params, true),
        SortField::Added,
        SortOrder::Desc,
        false,
    )
    .await
}

pub async fn opds_authors(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_catalog_response(
        &state,
        &uri,
        &headers,
        "Authors",
        "/opds/authors",
        CatalogKind::Authors,
        "Author not found",
    )
    .await
}

pub async fn opds_series(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_catalog_response(
        &state,
        &uri,
        &headers,
        "Series",
        "/opds/series",
        CatalogKind::Series,
        "Series not found",
    )
    .await
}

pub async fn opds_tags(State(state): State<SharedState>, uri: Uri, headers: HeaderMap) -> Response {
    opds_catalog_response(
        &state,
        &uri,
        &headers,
        "Tags",
        "/opds/tags",
        CatalogKind::Tags,
        "Tag not found",
    )
    .await
}

pub async fn opds_formats(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_catalog_response(
        &state,
        &uri,
        &headers,
        "Formats",
        "/opds/formats",
        CatalogKind::Formats,
        "Format not found",
    )
    .await
}

async fn require_catalog_entry(
    state: &SharedState,
    kind: CatalogKind,
    id: CatalogId,
    missing: &str,
) -> Result<CatalogEntry, Response> {
    let db = state.db.clone();
    let entry = tokio::task::spawn_blocking(move || db.get_catalog_entry(kind, &id))
        .await
        .ok()
        .flatten();
    entry.ok_or_else(|| error_json(404, missing))
}

pub async fn opds_author_books(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid author ID");
    };
    let entry = match require_catalog_entry(
        &state,
        CatalogKind::Authors,
        CatalogId::Num(id_num),
        "Author not found",
    )
    .await
    {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    let params = parse_page_params(&uri);
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        format!("Author: {}", entry.title),
        format!("/opds/authors/{id_num}/books"),
        AcqQuery::Author(id_num),
        options_from(&params, true),
        params.sort_by,
        params.sort_order,
        false,
    )
    .await
}

pub async fn opds_series_books(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid series ID");
    };
    let entry = match require_catalog_entry(
        &state,
        CatalogKind::Series,
        CatalogId::Num(id_num),
        "Series not found",
    )
    .await
    {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    // F25: series books default to series_index order unless the caller
    // passes an explicit sortBy.
    let pairs = parse_query_pairs(uri.query());
    let explicit = pairs
        .iter()
        .find(|(k, _)| k == "sortBy")
        .map(|(_, v)| v.clone())
        .is_some_and(|v| !v.is_empty());
    let mut params = parse_page_params(&uri);
    if !explicit {
        params.sort_by = SortField::SeriesIndex;
    }
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        format!("Series: {}", entry.title),
        format!("/opds/series/{id_num}/books"),
        AcqQuery::Series(id_num),
        options_from(&params, true),
        params.sort_by,
        params.sort_order,
        false,
    )
    .await
}

pub async fn opds_tag_books(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid tag ID");
    };
    let entry = match require_catalog_entry(
        &state,
        CatalogKind::Tags,
        CatalogId::Num(id_num),
        "Tag not found",
    )
    .await
    {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    let params = parse_page_params(&uri);
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        format!("Tag: {}", entry.title),
        format!("/opds/tags/{id_num}/books"),
        AcqQuery::Tag(id_num),
        options_from(&params, true),
        params.sort_by,
        params.sort_order,
        false,
    )
    .await
}

pub async fn opds_format_books(
    State(state): State<SharedState>,
    Path(format): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let format = format.to_ascii_uppercase();
    let entry = match require_catalog_entry(
        &state,
        CatalogKind::Formats,
        CatalogId::Text(format.clone()),
        "Format not found",
    )
    .await
    {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    let encoded = crate::helpers::js_encode_uri_component(&format);
    let params = parse_page_params(&uri);
    opds_acquisition_response(
        &state,
        &uri,
        &headers,
        format!("Format: {}", entry.title),
        format!("/opds/formats/{encoded}/books"),
        AcqQuery::Format(format),
        options_from(&params, true),
        params.sort_by,
        params.sort_order,
        false,
    )
    .await
}

/// `/opds/search` — never cached (TS renders directly with no-store).
pub async fn opds_search(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let pairs = parse_query_pairs(uri.query());
    let query = pairs
        .iter()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let params = parse_page_params(&uri);
    let base_url = get_public_base_url(&state, &headers, &uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, &headers);
    let updated = state.db.snapshot_updated_iso();
    let self_path = request_path(&uri);
    let title = if query.trim().is_empty() {
        "Search".to_string()
    } else {
        format!("Search: {}", query.trim())
    };

    let opts = options_from(&params, true);
    let db = state.db.clone();
    let q = query.clone();
    let result = tokio::task::spawn_blocking(move || db.search_books(&opts, &q))
        .await
        .unwrap_or_else(|_| Err(DbError::Internal("join error".into())));
    let result = match result {
        Ok(result) => result,
        Err(_) => return error_json(500, "Failed to render OPDS search"),
    };
    let next_path = result.next_cursor.as_ref().map(|cursor| {
        build_path(
            "/opds/search",
            &[
                ("q", Some(query.clone())),
                ("cursor", Some(cursor.clone())),
                ("limit", Some(params.limit.to_string())),
                ("sortBy", Some(params.sort_by.as_str().to_string())),
                ("sortOrder", Some(params.sort_order.as_str().to_string())),
            ],
        )
    });
    let feed = render_acquisition_feed(&AcquisitionFeedOptions {
        base_url: &base_url,
        path_prefix: &path_prefix,
        self_path: &self_path,
        title: &title,
        id: &absolute_url(&base_url, &self_path, &path_prefix),
        updated: &updated,
        result: &result,
        next_path,
    });
    axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            format!("{OPDS_ACQUISITION_TYPE}; charset=utf-8"),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(feed))
        .unwrap()
}

async fn opds_book_document(
    state: &SharedState,
    uri: &Uri,
    headers: &HeaderMap,
    id: &str,
    variant: &'static str,
) -> Response {
    let Some(id_num) = parse_book_id(id) else {
        return error_json(400, "Invalid book ID");
    };
    let base_url = get_public_base_url(state, headers, uri);
    let path_prefix = get_request_prefix(state.config.resolved().trust_proxy, headers);
    let self_path = request_path(uri);
    let updated = state.db.snapshot_updated_iso();
    let cache_base = match variant {
        "complete" => format!("opds:book-complete:{base_url}:{path_prefix}:{self_path}"),
        "feed" => format!("opds:book-feed:{base_url}:{path_prefix}:{self_path}"),
        _ => format!("opds:book:{base_url}:{path_prefix}:{self_path}"),
    };
    let content_type = if variant == "complete" {
        format!("{OPDS_ENTRY_TYPE}; charset=utf-8")
    } else {
        format!("{OPDS_ACQUISITION_TYPE}; charset=utf-8")
    };

    let db = state.db.clone();
    cached_text(
        state.clone(),
        headers,
        cache_base,
        content_type,
        "public, max-age=60",
        move || {
            let book = match db.get_book(id_num) {
                Ok(Some(book)) => book,
                Ok(None) => return Produce::Bypass(error_json(404, "Book not found")),
                Err(_) => return Produce::Bypass(error_json(500, "Failed to render OPDS book")),
            };
            let xml = if variant == "complete" {
                render_book_complete_entry(&base_url, &path_prefix, &book)
            } else {
                render_single_book_feed(&SingleBookFeedOptions {
                    base_url: &base_url,
                    path_prefix: &path_prefix,
                    self_path: &self_path,
                    updated: &updated,
                    book: &book,
                })
            };
            Produce::Value(xml)
        },
    )
    .await
}

pub async fn opds_book(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_book_document(&state, &uri, &headers, &id, "book").await
}

pub async fn opds_book_feed(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_book_document(&state, &uri, &headers, &id, "feed").await
}

pub async fn opds_book_complete(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    opds_book_document(&state, &uri, &headers, &id, "complete").await
}

pub async fn opds_book_download(
    State(state): State<SharedState>,
    Path((id, format)): Path<(String, String)>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    crate::files::serve_book_file(&state, &method, &headers, id_num, &format, "attachment").await
}

pub async fn opds_book_file(
    State(state): State<SharedState>,
    Path((id, format)): Path<(String, String)>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    crate::files::serve_book_file(&state, &method, &headers, id_num, &format, "inline").await
}

pub async fn opds_book_cover(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    crate::files::serve_cover_by_id(&state, &headers, id_num).await
}

pub async fn opds_book_thumb(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(id_num) = parse_book_id(&id) else {
        return error_json(400, "Invalid book ID");
    };
    let pairs = parse_query_pairs(uri.query());
    let size = pairs
        .iter()
        .find(|(k, _)| k == "size")
        .map(|(_, v)| v.as_str());
    crate::files::serve_thumb_by_id(&state, &headers, id_num, size).await
}
