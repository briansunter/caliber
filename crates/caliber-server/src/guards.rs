//! Host validation (421) + optional auth guard (401), applied in that order
//! to every registered (non-SPA) route, porting `withHostValidation`,
//! `withAuthGuard`, `authenticateRequest`, and `currentUser` from src/index.ts
//! and src/lib/auth.ts.

use crate::backend::User;
use crate::cache::error_json;
use crate::helpers::cookie_value;
use crate::state::SharedState;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

pub const LOCAL_SETUP_HOSTS: [&str; 3] = ["127.0.0.1", "::1", "localhost"];

pub const PUBLIC_AUTH_PATHS: [&str; 5] = [
    "/api/health",
    "/api/user/me",
    "/api/user/login",
    "/api/user/logout",
    "/api/auth/setup",
];

/// Request-user extension inserted by the auth guard (TS `setRequestUser`).
#[derive(Debug, Clone)]
pub struct RequestUser(pub User, pub &'static str);

/// TS `normalizedHostName`: lowercase, IPv6 bracket strip, single port strip,
/// trailing dot strip.
pub fn normalized_host_name(value: &str) -> String {
    let trimmed = value.trim().to_lowercase();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('[') {
        return match trimmed.find(']') {
            Some(end) => trimmed[1..end].to_string(),
            None => String::new(),
        };
    }
    let first_colon = trimmed.find(':');
    let last_colon = trimmed.rfind(':');
    let host = match (first_colon, last_colon) {
        (Some(f), Some(l)) if f == l => &trimmed[..f],
        _ => trimmed.as_str(),
    };
    host.strip_suffix('.').unwrap_or(host).to_string()
}

fn host_is_loopback(host: &str) -> bool {
    LOCAL_SETUP_HOSTS.contains(&normalized_host_name(host).as_str())
}

/// TS `isRequestHostAllowed`.
fn request_host_allowed(state: &SharedState, headers: &HeaderMap) -> bool {
    let resolved = state.config.resolved();
    if resolved.trust_proxy && headers.get("x-forwarded-host").is_some() {
        return true;
    }
    let host_is_loopback = host_is_loopback(&resolved.host);
    let permissive = resolved.base_url.is_none() && !host_is_loopback;
    if permissive {
        return true;
    }
    let host = match headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        Some(h) => h,
        None => return host_is_loopback,
    };
    let normalized = normalized_host_name(host);
    if LOCAL_SETUP_HOSTS.contains(&normalized.as_str()) {
        return true;
    }
    if normalized == normalized_host_name(&resolved.host) && !normalized.is_empty() {
        return true;
    }
    if let Some(base_url) = &resolved.base_url {
        if let Ok(url) = url::Url::parse(base_url) {
            if normalized_host_name(url.host_str().unwrap_or("")) == normalized
                && !normalized.is_empty()
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Registered-route classification
// ---------------------------------------------------------------------------

/// Every non-SPA route pattern registered on the router. Host validation
/// applies to these; unmatched paths fall through to the SPA fallback
/// unguarded (TS: `/*` is excluded from both wrappers).
const REGISTERED_ROUTE_PATTERNS: &[&str] = &[
    "/api/health",
    "/api/config/library",
    "/api/config/auth",
    "/api/auth/users",
    "/api/auth/users/{username}",
    "/api/auth/users/{username}/password",
    "/api/auth/setup",
    "/api/stats",
    "/api/tags",
    "/api/formats",
    "/api/books",
    "/api/books/count",
    "/api/books/stream",
    "/api/books/search",
    "/api/books/{id}",
    "/api/books/{id}/download/{format}",
    "/api/books/{id}/file/{format}",
    "/api/books/{id}/epub",
    "/api/books/{id}/epub/",
    "/api/books/{id}/epub/{*rest}",
    "/api/books/{id}/pages/{format}/manifest",
    "/api/books/{id}/pages/{format}/{page}",
    "/api/books/{id}/cover",
    "/api/books/{id}/thumb",
    "/api/user/me",
    "/api/user/login",
    "/api/user/logout",
    "/api/user/reading",
    "/api/user/progress/{bookId}",
    "/opds",
    "/opds/search.xml",
    "/opds/books",
    "/opds/recent",
    "/opds/authors",
    "/opds/authors/{id}/books",
    "/opds/series",
    "/opds/series/{id}/books",
    "/opds/tags",
    "/opds/tags/{id}/books",
    "/opds/formats",
    "/opds/formats/{format}/books",
    "/opds/search",
    "/opds/book/{id}",
    "/opds/book/{id}/feed",
    "/opds/book/{id}/complete",
    "/opds/book/{id}/download/{format}",
    "/opds/book/{id}/file/{format}",
    "/opds/book/{id}/cover",
    "/opds/book/{id}/thumb",
    "/mcp",
    "/pdfjs/pdf.worker.min.mjs",
];

fn path_matches_pattern(pattern: &str, path: &str) -> bool {
    let mut pat_segs = pattern.split('/');
    let mut path_segs = path.split('/');
    loop {
        match (pat_segs.next(), path_segs.next()) {
            (None, None) => return true,
            (None, Some(_)) => return false,
            (Some(_), None) => return false,
            (Some(p), Some(s)) => {
                if let Some(name) = p.strip_prefix("{*") {
                    // wildcard must be the last segment; it may be empty
                    debug_assert!(p.ends_with('}'));
                    let _ = name;
                    return pat_segs.next().is_none();
                }
                if p.starts_with('{') && p.ends_with('}') {
                    if s.is_empty() {
                        return false;
                    }
                } else if p != s {
                    return false;
                }
            }
        }
    }
}

/// True when the path is handled by a registered (non-SPA) route.
pub fn matches_registered_route(path: &str) -> bool {
    REGISTERED_ROUTE_PATTERNS
        .iter()
        .any(|pattern| path_matches_pattern(pattern, path))
}

/// TS `isAuthProtectedPattern`.
fn is_auth_protected(path: &str) -> bool {
    path == "/api"
        || path == "/mcp"
        || path.starts_with("/api/")
        || path.starts_with("/opds")
        || path.starts_with("/pdfjs")
}

/// TS `unauthorizedResponse`: 401, no-store, WWW-Authenticate only on OPDS.
fn unauthorized_response(pathname: &str) -> Response {
    let mut response = error_json(401, "Authentication required");
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    if pathname.starts_with("/opds") {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            axum::http::HeaderValue::from_static("Basic realm=\"Caliber\", charset=\"UTF-8\""),
        );
    }
    response
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/// Auth client key: first X-Forwarded-For value when trust_proxy, else "local".
pub fn auth_client_key(state: &SharedState, headers: &HeaderMap) -> String {
    if state.config.resolved().trust_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = forwarded.split(',').next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    "local".to_string()
}

/// TS `authenticateRequest`: Basic credentials first, then the session
/// cookie. Returns the user and the mechanism.
pub async fn authenticate_request(
    state: &SharedState,
    headers: &HeaderMap,
) -> Option<(User, &'static str)> {
    let client_key = auth_client_key(state, headers);
    if let Some(authorization) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let users = state.users.clone();
        let header_value = authorization.to_string();
        let user = tokio::task::spawn_blocking(move || {
            users.authenticate_basic(&client_key, &header_value)
        })
        .await
        .ok()
        .flatten();
        if let Some(user) = user {
            return Some((user, "basic"));
        }
    }
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let token = cookie_value(cookie.as_deref(), crate::backend::SESSION_COOKIE);
    if token.is_none() {
        return None;
    }
    let users = state.users.clone();
    let user = tokio::task::spawn_blocking(move || users.resolve_session_token(token.as_deref()))
        .await
        .ok()
        .flatten();
    user.map(|u| (u, "session"))
}

/// TS `currentUser`: real identity when auth is on; otherwise the remembered
/// `caliber-user` profile cookie.
pub async fn current_user(state: &SharedState, headers: &HeaderMap) -> Option<User> {
    if state.config.auth_enabled() {
        return authenticate_request(state, headers).await.map(|(u, _)| u);
    }
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let username = cookie_value(cookie.as_deref(), "caliber-user")?;
    let users = state.users.clone();
    tokio::task::spawn_blocking(move || users.get_user_by_username(&username))
        .await
        .ok()
        .flatten()
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

pub async fn guard_middleware(
    State(state): State<SharedState>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    if !matches_registered_route(&path) {
        // SPA fallback path: the TS "/*" route is wrapped by neither guard.
        return next.run(request).await;
    }

    // 1. Host validation.
    if !request_host_allowed(&state, request.headers()) {
        let mut response = error_json(421, "Request host is not allowed");
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        return response;
    }

    // 2. Auth guard (live auth_enabled read).
    if state.config.auth_enabled()
        && is_auth_protected(&path)
        && !PUBLIC_AUTH_PATHS.contains(&path.as_str())
    {
        match authenticate_request(&state, request.headers()).await {
            Some((user, via)) => {
                let via: &'static str = if via == "basic" { "basic" } else { "session" };
                request.extensions_mut().insert(RequestUser(user, via));
            }
            None => return unauthorized_response(&path),
        }
    }

    next.run(request).await
}

/// Response helpers used across route modules.
pub fn no_store_json(value: serde_json::Value) -> Response {
    (
        axum::http::StatusCode::OK,
        [(header::CACHE_CONTROL, "private, no-store")],
        axum::Json(value),
    )
        .into_response()
}
