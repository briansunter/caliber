//! SPA static hosting: files from CALIBER_STATIC_DIR (default ./dist) with an
//! index.html fallback for unmatched routes, plus /pdfjs/pdf.worker.min.mjs.

use crate::cache::error_json;
use crate::state::SharedState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use std::path::{Component, Path, PathBuf};

fn static_content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Lexically sanitize a request path under the static dir (no `..`, no
/// absolute components).
fn safe_static_path(static_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let rel = request_path.trim_start_matches('/');
    let mut path = static_dir.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path)
}

async fn serve_static_file(path: &Path, cache_control: &'static str) -> Option<Response> {
    let md = tokio::fs::metadata(path).await.ok()?;
    if !md.is_file() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let builder = axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, static_content_type(path))
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::CONTENT_LENGTH, md.len().to_string());
    let body = crate::files::stream_file_body(file, 0, md.len());
    Some(builder.body(body).unwrap())
}

/// `/pdfjs/pdf.worker.min.mjs` — served from the static dir (the build step
/// copies it there; see PARITY.md).
pub async fn pdfjs_worker(State(state): State<SharedState>) -> Response {
    let dir = &state.static_dir;
    for candidate in [
        dir.join("pdf.worker.min.mjs"),
        dir.join("pdfjs").join("pdf.worker.min.mjs"),
    ] {
        if let Some(response) = serve_static_file(&candidate, "no-cache").await {
            return response;
        }
    }
    eprintln!(
        "[spa] pdf.worker.min.mjs not found under {} (copy pdfjs-dist's worker at build time)",
        dir.display()
    );
    error_json(404, "File not found")
}

/// SPA fallback for every unmatched route: a real file when one exists under
/// the static dir, otherwise index.html with `Cache-Control: no-cache`.
pub async fn spa_fallback(State(state): State<SharedState>, request: Request<Body>) -> Response {
    let path = request.uri().path().to_string();
    let static_dir = state.static_dir.clone();
    if !static_dir.is_dir() {
        // Missing static dir: keep the API working; the SPA shell is absent.
        eprintln!(
            "[spa] static dir {} missing; serving 404 for {}",
            static_dir.display(),
            path
        );
        return error_json(404, "Not found");
    }
    if !path.contains("..") {
        if let Some(candidate) = safe_static_path(&static_dir, &path) {
            if let Some(response) = serve_static_file(&candidate, "no-cache").await {
                return response;
            }
        }
    }
    let index = static_dir.join("index.html");
    match serve_static_file(&index, "no-cache").await {
        Some(response) => response,
        None => error_json(404, "Not found"),
    }
}
