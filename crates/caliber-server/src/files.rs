//! Local file serving: `serveLocalFile` + `serveBookFile` + covers/thumbnails
//! ported from src/index.ts and src/lib/book-files.ts.

use crate::cache::{cover_cache_control_for, error_json};
use crate::helpers::{http_date_from_unix_secs, js_encode_uri_component, parse_http_date_secs};
use crate::state::SharedState;
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

// ---------------------------------------------------------------------------
// Content types (book-files.ts)
// ---------------------------------------------------------------------------

fn format_content_type(format: &str) -> &'static str {
    match format.to_ascii_uppercase().as_str() {
        "EPUB" => "application/epub+zip",
        "MOBI" => "application/x-mobipocket-ebook",
        "AZW" | "AZW3" | "KFX" => "application/vnd.amazon.ebook",
        "PDF" => "application/pdf",
        "TXT" => "text/plain; charset=utf-8",
        "HTML" | "HTM" => "text/html; charset=utf-8",
        "RTF" => "application/rtf",
        "DOC" => "application/msword",
        "DOCX" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "FB2" => "application/x-fictionbook+xml",
        "DJVU" => "image/vnd.djvu",
        "CBZ" => "application/vnd.comicbook+zip",
        "CBR" => "application/vnd.comicbook-rar",
        "CB7" => "application/x-cb7",
        _ => "application/octet-stream",
    }
}

fn path_content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "htm" | "html" => "text/html; charset=utf-8",
        "jpeg" | "jpg" => "image/jpeg",
        "js" => "application/javascript; charset=utf-8",
        "ncx" => "application/x-dtbncx+xml",
        "opf" => "application/oebps-package+xml",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "webp" => "image/webp",
        "xhtml" => "application/xhtml+xml; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn can_read_in_browser(format: &str) -> bool {
    matches!(
        format.to_ascii_uppercase().as_str(),
        "EPUB" | "PDF" | "CBZ" | "CBR"
    )
}

/// Public wrapper for the OPDS renderer (read-link generation).
pub fn can_read_in_browser_pub(format: &str) -> bool {
    can_read_in_browser(format)
}

/// `^[A-Za-z0-9]{1,10}$` — the route-level format parameter pattern.
pub fn is_valid_format_param(format: &str) -> bool {
    !format.is_empty() && format.len() <= 10 && format.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ---------------------------------------------------------------------------
// Filename sanitization (getSafeBookFilename)
// ---------------------------------------------------------------------------

/// Port of `getSafeBookFilename`. NFKC normalization is approximated by the
/// code-point filter below (see PARITY.md: no unicode-normalization crate in
/// the locked dependency set; ASCII behavior is identical).
pub fn get_safe_book_filename(title: Option<&str>, format: &str) -> String {
    let filtered: String = title
        .unwrap_or_default()
        .chars()
        .filter(|&c| {
            let cp = c as u32;
            c != '/' && c != '\\' && cp >= 32 && cp != 127
        })
        .collect();

    let replaced: String = filtered
        .chars()
        .map(|c| match c {
            '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '-',
            _ => c,
        })
        .collect();
    let trimmed = replaced.trim();
    let collapsed = collapse_whitespace(trimmed);
    // `.replace(/^\.+$/, "")` — a string made only of dots becomes empty.
    let dedotted: String = if !collapsed.is_empty() && collapsed.chars().all(|c| c == '.') {
        String::new()
    } else {
        collapsed
    };
    let mut safe: String = dedotted.chars().take(160).collect();
    if safe.is_empty() {
        safe = "book".to_string();
    }
    format!("{}.{}", safe, format.to_ascii_lowercase())
}

fn collapse_whitespace(input: &str) -> String {
    // `/\s+/g` → "_" : JS \s covers unicode spaces; approximate with
    // char::is_whitespace (covers the common set).
    let mut out = String::with_capacity(input.len());
    let mut in_ws = false;
    for c in input.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push('_');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// serveLocalFile
// ---------------------------------------------------------------------------

pub struct ServeFileOptions<'a> {
    pub content_type: &'a str,
    pub content_disposition: Option<String>,
    pub cache_control: Option<&'a str>,
    pub content_security_policy: Option<&'a str>,
}

impl<'a> Default for ServeFileOptions<'a> {
    fn default() -> Self {
        ServeFileOptions {
            content_type: "application/octet-stream",
            content_disposition: None,
            cache_control: None,
            content_security_policy: None,
        }
    }
}

fn mtime_parts(md: &std::fs::Metadata) -> (f64, Option<i64>) {
    match md.modified().ok() {
        Some(t) => {
            let millis = t
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            let secs = t
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (millis, Some(secs))
        }
        None => (0.0, None),
    }
}

fn js_millis_string(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// TS `parseByteRange`: single `bytes=` range only, suffix ranges supported.
struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_byte_range(range_header: &str, size: u64) -> Option<ByteRange> {
    if size == 0 || !range_header.starts_with("bytes=") || range_header.contains(',') {
        return None;
    }
    let range = &range_header["bytes=".len()..];
    let (start_part, end_part) = range.split_once('-')?;

    if start_part.is_empty() {
        let suffix_length: u64 = end_part.parse().ok()?;
        if suffix_length == 0 {
            return None;
        }
        return Some(ByteRange {
            start: size.saturating_sub(suffix_length),
            end: size - 1,
        });
    }

    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !is_digits(start_part) || (!end_part.is_empty() && !is_digits(end_part)) {
        return None;
    }
    let start: u64 = start_part.parse().ok()?;
    let end: u64 = if end_part.is_empty() {
        size - 1
    } else {
        end_part.parse().ok()?
    };
    if start >= size || end < start {
        return None;
    }
    Some(ByteRange {
        start,
        end: end.min(size - 1),
    })
}

/// TS `ifRangeAllowsRange`.
fn if_range_allows(if_range: Option<&str>, etag: &str, mtime_ms: f64) -> bool {
    let Some(if_range) = if_range else {
        return true;
    };
    if if_range.starts_with('"') || if_range.starts_with("W/") {
        return if_range == etag;
    }
    // Date form: JS Date.parse — accept HTTP dates and our ISO shape.
    let parsed = parse_http_date_secs(if_range)
        .or_else(|| crate::helpers::parse_js_date_millis(if_range).map(|ms| ms.div_euclid(1000)));
    match parsed {
        Some(secs) => (mtime_ms / 1000.0).floor() <= (secs as f64).floor(),
        None => false,
    }
}

/// Chunked async body over a std File handle: each 64KB chunk is read via
/// `spawn_blocking` (the workspace tokio build has no `io-util`, so
/// AsyncReadExt is unavailable; positional reads under a shared mutex keep
/// concurrent range requests on one file safe).
fn file_body(std_file: std::fs::File, offset: u64, length: u64) -> Body {
    let handle = Arc::new(Mutex::new(std_file));
    let stream = futures::stream::unfold(
        (handle, offset, length),
        |(handle, offset, mut remaining)| async move {
            if remaining == 0 {
                return None;
            }
            let want = (remaining.min(64 * 1024)) as usize;
            let chunk_handle = Arc::clone(&handle);
            let read = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
                use std::io::{Read, Seek, SeekFrom};
                let mut file = chunk_handle.lock().unwrap();
                if offset > 0 {
                    file.seek(SeekFrom::Start(offset))?;
                }
                let mut buf = vec![0u8; want];
                let n = file.read(&mut buf)?;
                buf.truncate(n);
                Ok(buf)
            })
            .await;
            match read {
                Ok(Ok(buf)) if buf.is_empty() => None,
                Ok(Ok(buf)) => {
                    remaining -= buf.len() as u64;
                    Some((
                        Ok::<Bytes, std::io::Error>(Bytes::from(buf)),
                        (handle, offset + want as u64, remaining),
                    ))
                }
                Ok(Err(e)) => Some((Err(e), (handle, offset, 0))),
                Err(join) => Some((
                    Err(std::io::Error::other(format!("read task failed: {join}"))),
                    (handle, offset, 0),
                )),
            }
        },
    );
    Body::from_stream(stream)
}

/// Shared file streaming body (also used by the SPA static handler).
pub fn stream_file_body(file: std::fs::File, offset: u64, length: u64) -> Body {
    file_body(file, offset, length)
}

/// Port of `serveLocalFile`: ETag `"{size}-{mtimeMs}"`, Last-Modified,
/// 304/206/416 handling, HEAD without body, nosniff, dual Content-Disposition.
pub async fn serve_local_file(
    method: &Method,
    headers: &HeaderMap,
    file_path: &Path,
    options: ServeFileOptions<'_>,
) -> Response {
    let md = match tokio::fs::metadata(file_path).await {
        Ok(md) if md.is_file() => md,
        _ => return error_json(404, "File not found"),
    };
    let size = md.len();
    let (mtime_ms, mtime_secs) = mtime_parts(&md);
    let etag = format!("\"{}-{}\"", size, js_millis_string(mtime_ms));
    let include_body = method != Method::HEAD;
    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let if_range_header = headers
        .get(header::IF_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let if_range_ok = if_range_allows(if_range_header.as_deref(), &etag, mtime_ms);
    let cache_control = options.cache_control.unwrap_or("no-cache");

    let mut base_headers: Vec<(header::HeaderName, String)> = vec![
        (header::CONTENT_TYPE, options.content_type.to_string()),
        (header::CACHE_CONTROL, cache_control.to_string()),
        (header::ACCEPT_RANGES, "bytes".to_string()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        (header::ETAG, etag.clone()),
    ];
    if let Some(secs) = mtime_secs {
        base_headers.push((header::LAST_MODIFIED, http_date_from_unix_secs(secs)));
    }
    if let Some(disposition) = &options.content_disposition {
        base_headers.push((header::CONTENT_DISPOSITION, disposition.clone()));
    }
    if let Some(csp) = options.content_security_policy {
        base_headers.push((header::CONTENT_SECURITY_POLICY, csp.to_string()));
    }

    let apply_headers = |builder: axum::http::response::Builder,
                         headers: &[(header::HeaderName, String)]| {
        let mut builder = builder;
        for (name, value) in headers {
            builder = builder.header(name, value.as_str());
        }
        builder
    };

    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if range_header.is_none() && if_none_match == Some(etag.as_str()) {
        let builder = apply_headers(
            axum::http::Response::builder().status(StatusCode::NOT_MODIFIED),
            &base_headers,
        );
        return builder.body(Body::empty()).unwrap();
    }

    if let Some(range_header) = range_header.filter(|_| if_range_ok) {
        match parse_byte_range(&range_header, size) {
            None => {
                return axum::http::Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CACHE_CONTROL, cache_control)
                    .header(header::ETAG, etag.as_str())
                    .body(Body::empty())
                    .unwrap();
            }
            Some(range) => {
                let length = range.end - range.start + 1;
                let mut headers206 = base_headers.clone();
                headers206.push((
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", range.start, range.end, size),
                ));
                headers206.push((header::CONTENT_LENGTH, length.to_string()));
                let builder = apply_headers(
                    axum::http::Response::builder().status(StatusCode::PARTIAL_CONTENT),
                    &headers206,
                );
                if !include_body {
                    return builder.body(Body::empty()).unwrap();
                }
                let file = match std::fs::File::open(file_path) {
                    Ok(f) => f,
                    Err(_) => return error_json(404, "File not found"),
                };
                return builder.body(file_body(file, range.start, length)).unwrap();
            }
        }
    }

    let mut headers200 = base_headers.clone();
    headers200.push((header::CONTENT_LENGTH, size.to_string()));
    let builder = apply_headers(axum::http::Response::builder(), &headers200);
    if !include_body {
        return builder.body(Body::empty()).unwrap();
    }
    let file = match std::fs::File::open(file_path) {
        Ok(f) => f,
        Err(_) => return error_json(404, "File not found"),
    };
    builder.body(file_body(file, 0, size)).unwrap()
}

/// TS `contentDisposition` — dual form.
pub fn content_disposition(disposition: &str, filename: &str) -> String {
    format!(
        "{disposition}; filename=\"{filename}\"; filename*=UTF-8''{}",
        js_encode_uri_component(filename)
    )
}

// ---------------------------------------------------------------------------
// serveBookFile
// ---------------------------------------------------------------------------

/// Port of `serveBookFile`: format validation, path lookup, sanitized
/// filename, inline→attachment downgrade.
pub async fn serve_book_file(
    state: &SharedState,
    method: &Method,
    headers: &HeaderMap,
    book_id: i64,
    format_param: &str,
    disposition: &str,
) -> Response {
    if !is_valid_format_param(format_param) {
        return error_json(400, "Invalid format");
    }
    let format = format_param.to_ascii_uppercase();
    let file_path = {
        let db = state.db.clone();
        let owned_format = format.clone();
        match tokio::task::spawn_blocking(move || db.book_format_path(book_id, &owned_format))
            .await
            .ok()
            .flatten()
        {
            Some(p) => p,
            None => return error_json(404, &format!("Format {format} not found")),
        }
    };
    if !file_path.is_file() {
        return error_json(404, "File not found");
    }

    let title = {
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || db.book_title(book_id))
            .await
            .ok()
            .flatten()
    };
    let filename = get_safe_book_filename(title.as_deref(), &format);
    let effective_disposition = if disposition == "inline" && !can_read_in_browser(&format) {
        "attachment"
    } else {
        disposition
    };

    serve_local_file(
        method,
        headers,
        &file_path,
        ServeFileOptions {
            content_type: format_content_type(&format),
            content_disposition: Some(content_disposition(effective_disposition, &filename)),
            cache_control: Some("no-cache"),
            content_security_policy: None,
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Covers + thumbnails
// ---------------------------------------------------------------------------

pub fn path_content_type_for(path: &str) -> &'static str {
    path_content_type(path)
}

pub fn format_content_type_for(format: &str) -> &'static str {
    format_content_type(format)
}

/// Port of `serveCoverById`: full-size JPEG, ETag/304, cover Cache-Control.
pub async fn serve_cover_by_id(state: &SharedState, headers: &HeaderMap, book_id: i64) -> Response {
    let cover_path = {
        let db = state.db.clone();
        match tokio::task::spawn_blocking(move || db.book_cover_path(book_id))
            .await
            .ok()
            .flatten()
        {
            Some(p) => p,
            None => return error_json(404, "Cover not found"),
        }
    };
    let md = match tokio::fs::metadata(&cover_path).await {
        Ok(md) if md.is_file() => md,
        _ => return error_json(404, "Cover file not found"),
    };
    let (mtime_ms, _) = mtime_parts(&md);
    let etag = format!("\"{}-{}\"", md.len(), js_millis_string(mtime_ms));
    let cache_control = cover_cache_control_for(headers);

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

    let file = match std::fs::File::open(&cover_path) {
        Ok(f) => f,
        Err(_) => return error_json(404, "Cover file not found"),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, cache_control),
            (header::ETAG, etag.as_str()),
        ],
        file_body(file, 0, md.len()),
    )
        .into_response()
}

pub fn thumb_size_for(value: Option<&str>) -> u32 {
    match value {
        Some("medium") => 512,
        _ => 256,
    }
}

pub fn thumb_size_name(value: Option<&str>) -> &'static str {
    match value {
        Some("medium") => "medium",
        _ => "small",
    }
}

/// Signature key over (library path, cover size, cover mtime) —
/// `Bun.hash(`${LIBRARY_PATH}:${size}:${mtimeMs}`).toString(36)`.
fn thumb_sig(library_path: &str, size: u64, mtime_ms: f64) -> String {
    let key = format!("{}:{}:{}", library_path, size, js_millis_string(mtime_ms));
    caliber_common::wyhash::to_base36(caliber_common::wyhash::bun_hash(key.as_bytes()))
}

/// Resize with the `image` crate (`withoutEnlargement`, width-capped).
/// `CALIBER_THUMB_DISABLE_RESIZE=1` forces the degraded path.
fn try_resize_image(bytes: &[u8], target_width: u32) -> Option<Vec<u8>> {
    if std::env::var("CALIBER_THUMB_DISABLE_RESIZE")
        .ok()
        .as_deref()
        == Some("1")
    {
        return None;
    }
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    let (tw, th) = if w <= target_width {
        (w, h)
    } else {
        let scaled = ((target_width as f64 / w as f64) * h as f64)
            .round()
            .max(1.0) as u32;
        (target_width, scaled)
    };
    let resized = img
        .resize_exact(tw, th, image::imageops::FilterType::Lanczos3)
        .to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(resized)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .ok()?;
    let bytes = out.into_inner();
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

/// Port of `serveThumbById`: 256/512 resizes, disk cache
/// `<config>/thumbs/{id}-{size}-{sig}.jpg`, FIFO max 2 jobs, degraded
/// fallback with `X-Thumbnail-Degraded: resize-unavailable`, 501 when no
/// cover bytes exist at all.
pub async fn serve_thumb_by_id(
    state: &SharedState,
    headers: &HeaderMap,
    book_id: i64,
    size_param: Option<&str>,
) -> Response {
    let size = thumb_size_for(size_param);
    let size_name = thumb_size_name(size_param);

    let cover_path = {
        let db = state.db.clone();
        match tokio::task::spawn_blocking(move || db.book_cover_path(book_id))
            .await
            .ok()
            .flatten()
        {
            Some(p) => p,
            None => return error_json(404, "Cover not found"),
        }
    };
    let md = match tokio::fs::metadata(&cover_path).await {
        Ok(md) if md.is_file() => md,
        _ => return error_json(404, "Cover file not found"),
    };
    let (mtime_ms, _) = mtime_parts(&md);
    let library_path = {
        let db = state.db.clone();
        match tokio::task::spawn_blocking(move || db.library_path()).await {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => return error_json(500, "Failed to get thumbnail"),
        }
    };
    let sig = thumb_sig(&library_path, md.len(), mtime_ms);
    let etag = format!("\"t{size_name}-{sig}\"");
    let cache_control = cover_cache_control_for(headers);

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

    let thumb_dir = state.config.resolved().config_dir.join("thumbs");
    let thumb_path = thumb_dir.join(format!("{book_id}-{size_name}-{sig}.jpg"));

    let needs_generate = !thumb_path.is_file();
    if needs_generate {
        let permit = state
            .thumb_limiter
            .acquire()
            .await
            .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
        let result = if thumb_path.is_file() {
            Ok(false)
        } else {
            let cover_for_job = cover_path.clone();
            tokio::task::spawn_blocking({
                let thumb_dir = thumb_dir.clone();
                let thumb_path = thumb_path.clone();
                move || -> std::io::Result<bool> {
                    if thumb_path.is_file() {
                        return Ok(false);
                    }
                    std::fs::create_dir_all(&thumb_dir)?;
                    let original = std::fs::read(&cover_for_job)?;
                    if original.is_empty() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "empty cover",
                        ));
                    }
                    match try_resize_image(&original, size) {
                        Some(resized) => {
                            let tmp = thumb_path
                                .with_extension(format!("tmp-{}.jpg", std::process::id()));
                            std::fs::write(&tmp, &resized)?;
                            std::fs::rename(&tmp, &thumb_path)?;
                            Ok(true)
                        }
                        None => Ok(false),
                    }
                }
            })
            .await
            .unwrap_or(Ok(false))
        };
        drop(permit);

        match result {
            Ok(true) => {}
            Ok(false) => {
                if !thumb_path.is_file() {
                    // Degraded: serve the original bytes with the marker.
                    let original = match tokio::fs::read(&cover_path).await {
                        Ok(bytes) if !bytes.is_empty() => bytes,
                        _ => return error_json(501, "thumbnail resize unavailable"),
                    };
                    if !state.thumb_degraded_logged.swap(true, Ordering::SeqCst) {
                        eprintln!(
                            "[thumb] serving original cover for book {book_id} (resize-unavailable)"
                        );
                    }
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, "image/jpeg"),
                            (header::CACHE_CONTROL, cache_control),
                            (header::ETAG, etag.as_str()),
                            (
                                header::HeaderName::from_static("x-thumbnail-degraded"),
                                "resize-unavailable",
                            ),
                        ],
                        original,
                    )
                        .into_response();
                }
            }
            Err(_) => return error_json(500, "Failed to get thumbnail"),
        }
    }

    let md = match tokio::fs::metadata(&thumb_path).await {
        Ok(md) => md,
        Err(_) => return error_json(500, "Failed to get thumbnail"),
    };
    let file = match std::fs::File::open(&thumb_path) {
        Ok(f) => f,
        Err(_) => return error_json(500, "Failed to get thumbnail"),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, cache_control),
            (header::ETAG, etag.as_str()),
        ],
        file_body(file, 0, md.len()),
    )
        .into_response()
}

/// Exposed for the epub/pages modules.
pub fn entry_content_type(entry_path: &str) -> &'static str {
    path_content_type(entry_path)
}
