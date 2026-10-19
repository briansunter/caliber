//! API response cache helpers (port of `getCachedResponse` /
//! `getCachedTextResponse`) plus shared response constructors.

use crate::helpers::now_millis;
use crate::state::SharedState;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use caliber_common::wyhash::{bun_hash, to_base36};
use serde_json::Value;

/// Producer outcome: a value to cache/serve, or a pre-built response that
/// bypasses the cache (404s etc).
pub enum Produce<T> {
    Value(T),
    Bypass(Response),
}

impl<T> Produce<T> {
    pub fn bypass(response: Response) -> Self {
        Produce::Bypass(response)
    }
}

/// ETag = quoted base36 of `bun_hash(body)` (TS `generateETag`).
pub fn etag_for(data: &[u8]) -> String {
    format!("\"{}\"", to_base36(bun_hash(data)))
}

/// Any request carrying an Authorization header or a caliber session/user
/// cookie is treated as authenticated for cache-scoping purposes.
pub fn request_looks_authenticated(headers: &HeaderMap) -> bool {
    if headers.get(header::AUTHORIZATION).is_some() {
        return true;
    }
    match headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        Some(cookie) => {
            for part in cookie.split(';') {
                let trimmed = part.trim_start();
                if trimmed.starts_with("caliber-session=") || trimmed.starts_with("caliber-user=") {
                    return true;
                }
            }
            false
        }
        None => false,
    }
}

/// TS `cacheControlFor`.
pub fn cache_control_for(headers: &HeaderMap, sensitive: bool) -> &'static str {
    if sensitive || request_looks_authenticated(headers) {
        if sensitive {
            "private, no-store"
        } else {
            "private, max-age=60"
        }
    } else {
        "public, max-age=60"
    }
}

/// TS `coverCacheControlFor`.
pub fn cover_cache_control_for(headers: &HeaderMap) -> &'static str {
    if request_looks_authenticated(headers) {
        "private, max-age=60, must-revalidate"
    } else {
        "public, max-age=300, must-revalidate"
    }
}

/// TS `sharedCacheKey`: `shared:rev{r}:{base}` or `auth-private:rev{r}:{base}`.
pub fn shared_cache_key(revision: u64, headers: &HeaderMap, base: &str) -> String {
    if request_looks_authenticated(headers) {
        format!("auth-private:rev{revision}:{base}")
    } else {
        format!("shared:rev{revision}:{base}")
    }
}

/// Plain JSON response with status + optional extra headers.
pub fn json_response(status: u16, value: &Value, extra: &[(&'static str, String)]) -> Response {
    let mut builder = axum::http::Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, value.as_str());
    }
    builder
        .body(axum::body::Body::from(value.to_string()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `{"error": msg}` with status.
pub fn error_json(status: u16, msg: &str) -> Response {
    json_response(status, &serde_json::json!({ "error": msg }), &[])
}

/// `{"error": msg, "code": code}` with status (EPUB cache errors).
pub fn error_json_with_code(status: u16, msg: &str, code: &str) -> Response {
    json_response(
        status,
        &serde_json::json!({ "error": msg, "code": code }),
        &[],
    )
}

/// Port of `getCachedResponse`: JSON bodies keyed by the shared/auth-private
/// cache key; `If-None-Match` on a fresh entry yields 304; producers can
/// bypass the cache by returning a Response (404 short-circuit).
pub async fn cached_json<F>(
    state: SharedState,
    headers: &HeaderMap,
    base: String,
    producer: F,
) -> Response
where
    F: FnOnce() -> Produce<serde_json::Value> + Send + 'static,
{
    let revision = state.db.snapshot_revision();
    let key = shared_cache_key(revision, headers, &base);
    let cache_control = cache_control_for(headers, false);
    let now = now_millis();

    if let Some((data, etag)) = state.cache.get_fresh(&key, now) {
        let if_none_match = headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok());
        if if_none_match == Some(etag.as_str()) {
            return (
                StatusCode::NOT_MODIFIED,
                [
                    (header::ETAG, etag.as_str()),
                    (header::CACHE_CONTROL, cache_control),
                ],
            )
                .into_response();
        }
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, cache_control),
                (header::ETAG, etag.as_str()),
            ],
            data.to_string(),
        )
            .into_response();
    }

    let produced = tokio::task::spawn_blocking(producer)
        .await
        .unwrap_or_else(|err| {
            eprintln!("[server] cache producer panicked: {err}");
            Produce::Bypass(error_json(500, "Internal server error"))
        });

    match produced {
        Produce::Bypass(response) => response,
        Produce::Value(value) => {
            let data = value.to_string();
            let etag = etag_for(data.as_bytes());
            state.cache.set(key, data.clone(), etag.clone(), now);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/json"),
                    (header::CACHE_CONTROL, cache_control),
                    (header::ETAG, etag.as_str()),
                ],
                data,
            )
                .into_response()
        }
    }
}

/// Port of `getCachedTextResponse` (OPDS XML bodies). `cache_control_default`
/// is used verbatim when it contains `no-store` (sensitive callers); it
/// otherwise only seeds the default and the auth-derived value wins.
pub async fn cached_text<F>(
    state: SharedState,
    headers: &HeaderMap,
    base: String,
    content_type: String,
    cache_control_default: &str,
    producer: F,
) -> Response
where
    F: FnOnce() -> Produce<String> + Send + 'static,
{
    let revision = state.db.snapshot_revision();
    let key = shared_cache_key(revision, headers, &base);
    let effective_control = if cache_control_default.contains("no-store") {
        cache_control_default.to_string()
    } else {
        cache_control_for(headers, false).to_string()
    };
    let now = now_millis();

    if let Some((data, etag)) = state.cache.get_fresh(&key, now) {
        let if_none_match = headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok());
        if if_none_match == Some(etag.as_str()) {
            return (
                StatusCode::NOT_MODIFIED,
                [
                    (header::ETAG, etag.as_str()),
                    (header::CACHE_CONTROL, effective_control.as_str()),
                ],
            )
                .into_response();
        }
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type.as_str()),
                (header::CACHE_CONTROL, effective_control.as_str()),
                (header::ETAG, etag.as_str()),
            ],
            data.to_string(),
        )
            .into_response();
    }

    let produced = tokio::task::spawn_blocking(producer)
        .await
        .unwrap_or_else(|err| {
            eprintln!("[server] cache producer panicked: {err}");
            Produce::Bypass(error_json(500, "Internal server error"))
        });

    match produced {
        Produce::Bypass(response) => response,
        Produce::Value(data) => {
            let etag = etag_for(data.as_bytes());
            state.cache.set(key, data.clone(), etag.clone(), now);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, content_type.as_str()),
                    (header::CACHE_CONTROL, effective_control.as_str()),
                    (header::ETAG, etag.as_str()),
                ],
                data,
            )
                .into_response()
        }
    }
}
