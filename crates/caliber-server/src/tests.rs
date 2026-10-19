//! Route-level tests running the full router against the mock backends via
//! `tower::ServiceExt::oneshot`.

use crate::mock::{MockDb, MockUsers};
use crate::state::{AppState, SharedState};
use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Environment-variable lock (tests that read/write process env serialize).
// ---------------------------------------------------------------------------

/// RAII guard that actually serializes env-mutating tests: a plain
/// `MutexGuard` parked for the guard's lifetime (tests run each on their own
/// thread, so this is effectively a global env lock).
pub struct EnvLock {
    _guard: Option<std::sync::MutexGuard<'static, ()>>,
}

fn env_lock() -> EnvLock {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    EnvLock {
        _guard: Some(LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()),
    }
}

/// Temporarily set/remove env vars; restore on drop.
struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    fn set(vars: &[(&str, Option<&str>)]) -> EnvGuard {
        let mut saved = Vec::new();
        for (key, value) in vars {
            saved.push((key.to_string(), std::env::var(key).ok()));
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
        EnvGuard { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..) {
            match value {
                Some(v) => std::env::set_var(&key, v),
                None => std::env::remove_var(&key),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

struct TestEnv {
    state: SharedState,
    _tmp: tempfile::TempDir,
    files: Arc<Mutex<std::collections::HashMap<(i64, String), PathBuf>>>,
    covers: Arc<Mutex<std::collections::HashMap<i64, PathBuf>>>,
}

static INIT: AtomicBool = AtomicBool::new(false);

fn make_state(
    tmp: &tempfile::TempDir,
    customize: impl FnOnce(&mut TestConfig),
) -> (SharedState, MockHandles) {
    // Caller owns the env lock (see TestEnv::with / env-sensitive tests); the
    // EnvGuard here still clears leaked ambient toggles under that lock.
    let _env = EnvGuard::set(&[
        ("CALIBER_AUTH_ENABLED", None),
        ("CALIBRE_TRUST_PROXY", None),
        ("CALIBER_ADMIN_RESTRICTED", None),
        ("CALIBER_ALLOW_NOAUTH_ADMIN", None),
        ("CALIBER_THUMB_DISABLE_RESIZE", None),
        ("CALIBER_LIBRARY_PATH", None),
        ("CALIBRE_BASE_URL", None),
        ("BASE_PATH", None),
        ("CALIBER_BASE_PATH", None),
        ("CALIBER_STATIC_DIR", None),
    ]);
    let config_dir = tmp.path().join("config");
    let mut config = caliber_common::Config::load_from(config_dir);
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(library.join("metadata.db"), b"fixture").unwrap();
    config.apply_library_selection(&library, "metadata.db");

    let static_dir = tmp.path().join("dist");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(static_dir.join("index.html"), b"<html>caliber</html>").unwrap();

    let mut db = MockDb::new(config.clone(), library.clone());
    let users = MockUsers::new(config.clone());
    customize(&mut TestConfig {
        config: &mut config,
        db: &mut db,
        static_dir: &mut static_dir.clone(),
    });
    let handles = MockHandles {
        files: db.files.clone(),
        covers: db.covers.clone(),
    };
    (
        AppState::new(config, Arc::new(db), Arc::new(users), static_dir),
        handles,
    )
}

/// Live references into the mock db's file registries (files/cover fixtures
/// are registered after the state exists, mirroring the live library).
pub struct MockHandles {
    pub files: Arc<Mutex<std::collections::HashMap<(i64, String), PathBuf>>>,
    pub covers: Arc<Mutex<std::collections::HashMap<i64, PathBuf>>>,
}

/// Mutable knobs for `make_state`.
pub struct TestConfig<'a> {
    pub config: &'a mut caliber_common::Config,
    #[allow(dead_code)] // reserved for tests that need to tweak the fixture set
    pub db: &'a mut MockDb,
    pub static_dir: &'a mut PathBuf,
}

impl TestEnv {
    fn new() -> TestEnv {
        TestEnv::with(|_| {})
    }

    fn with(customize: impl FnOnce(&mut TestConfig)) -> TestEnv {
        let _ = INIT.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        let tmp = tempfile::tempdir().unwrap();
        let (state, handles) = {
            eprintln!("[with] acquiring inner lock");
            let _guard = env_lock();
            eprintln!("[with] inner lock acquired");
            make_state(&tmp, customize)
        };
        TestEnv {
            state,
            _tmp: tmp,
            files: handles.files,
            covers: handles.covers,
        }
    }

    fn library(&self) -> PathBuf {
        self.state.config.library_path()
    }

    fn write_book_file(&self, book_id: i64, format: &str, bytes: &[u8]) {
        let path = self.library().join(format!("book-{book_id}.{format}"));
        std::fs::write(&path, bytes).unwrap();
        self.files
            .lock()
            .unwrap()
            .insert((book_id, format.to_ascii_uppercase()), path);
    }

    fn write_cover(&self, book_id: i64, bytes: &[u8]) {
        let path = self.library().join(format!("cover-{book_id}.jpg"));
        std::fs::write(&path, bytes).unwrap();
        self.covers.lock().unwrap().insert(book_id, path);
    }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async fn send(state: &SharedState, request: Request<Body>) -> Response {
    crate::build_router(state.clone())
        .oneshot(request)
        .await
        .expect("router is infallible")
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

fn get_with(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder().method(Method::GET).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

fn post_json(uri: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn put_json(uri: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(Method::PUT)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn post_json_with_auth(uri: &str, body: &str, auth: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, auth)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn delete_with_auth(uri: &str, auth: &str) -> Request<Body> {
    Request::builder()
        .method(Method::DELETE)
        .uri(uri)
        .header(header::AUTHORIZATION, auth)
        .body(Body::empty())
        .unwrap()
}

fn delete(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::DELETE)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

async fn json_body(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

async fn text_body(response: Response) -> String {
    String::from_utf8_lossy(&response.into_body().collect().await.unwrap().to_bytes()).into_owned()
}

fn basic_auth(username: &str, password: &str) -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
    )
}

fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(width, height, image::Rgb([120, 40, 200]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn fixture_epub() -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(
                b"<?xml version=\"1.0\"?><container><rootfile full-path=\"OEBPS/content.opf\"/></container>",
            )
            .unwrap();
        writer.start_file("OEBPS/content.opf", options).unwrap();
        writer.write_all(b"<package/>").unwrap();
        writer.finish().unwrap();
    }
    cursor.into_inner()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_returns_ok() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/health")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["status"], "ok");
    assert!(body["timestamp"].is_number());
}

#[tokio::test]
async fn host_validation_rejects_unknown_host() {
    let env = TestEnv::new();
    let response = send(
        &env.state,
        get_with("/api/health", &[("host", "evil.example.com")]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST);
    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let body = json_body(response).await;
    assert_eq!(body["error"], "Request host is not allowed");
    assert_eq!(cache_control, "no-store");
}

#[tokio::test]
async fn host_validation_allows_configured_names() {
    let env = TestEnv::new();
    for host in ["localhost", "127.0.0.1:3003", "[::1]:9999"] {
        let response = send(&env.state, get_with("/api/health", &[("host", host)])).await;
        assert_eq!(response.status(), StatusCode::OK, "host {host}");
    }
}

#[tokio::test]
async fn host_validation_trust_proxy_accepts_forwarded_host() {
    let _guard = env_lock();
    let _env = EnvGuard::set(&[("CALIBER_TRUST_PROXY", Some("1"))]);
    let tmp = tempfile::tempdir().unwrap();
    let (state, _handles) = make_state(&tmp, |_| {});
    let response = send(
        &state,
        get_with(
            "/api/health",
            &[
                ("host", "evil.example.com"),
                ("x-forwarded-host", "proxy.example.com"),
            ],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn spa_fallback_serves_index_html() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/book/1")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let body = text_body(response).await;
    assert!(body.contains("caliber"));
    assert_eq!(cache_control, "no-cache");
}

#[tokio::test]
async fn auth_guard_blocks_and_allows() {
    let env = TestEnv::with(|tc| {
        tc.config.set_auth_enabled(true).unwrap();
    });
    // Unauthenticated protected path.
    let response = send(&env.state, get("/api/stats")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(response).await;
    assert_eq!(body["error"], "Authentication required");

    // OPDS carries the Basic challenge; /api does not.
    let response = send(&env.state, get("/opds")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap(),
        "Basic realm=\"Caliber\", charset=\"UTF-8\""
    );
    let response = send(&env.state, get("/api/stats")).await;
    assert!(response.headers().get(header::WWW_AUTHENTICATE).is_none());

    // Public paths stay reachable (login without a valid account is a 401
    // from the handler itself, not the guard — logout proves POST access).
    for path in ["/api/health", "/api/user/me"] {
        let response = send(&env.state, get(path)).await;
        assert_eq!(response.status(), StatusCode::OK, "public path {path}");
    }
    let response = send(&env.state, post_json("/api/user/logout", "{}")).await;
    assert_eq!(response.status(), StatusCode::OK);

    // Bootstrap the first account via setup, then use its Basic credentials.
    let response = send(
        &env.state,
        post_json(
            "/api/auth/setup",
            "{\"username\":\"alice\",\"password\":\"password123\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::SET_COOKIE).is_some());

    let response = send(
        &env.state,
        get_with(
            "/api/stats",
            &[("authorization", &basic_auth("alice", "password123"))],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn login_sets_session_and_logout_clears() {
    let env = TestEnv::with(|tc| {
        tc.config.set_auth_enabled(true).unwrap();
    });
    let response = send(
        &env.state,
        post_json(
            "/api/auth/setup",
            "{\"username\":\"bob\",\"password\":\"password123\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let login = send(
        &env.state,
        post_json(
            "/api/user/login",
            "{\"username\":\"bob\",\"password\":\"password123\"}",
        ),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(cookie.starts_with("caliber-session="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));

    let token = cookie.split(';').next().unwrap().trim().to_string();
    let response = send(&env.state, get_with("/api/user/me", &[("cookie", &token)])).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["user"]["username"], "bob");
    assert_eq!(body["authRequired"], true);

    // Wrong password.
    let response = send(
        &env.state,
        post_json(
            "/api/user/login",
            "{\"username\":\"bob\",\"password\":\"wrongpass1\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // Logout revokes + clears cookies.
    let logout = send(
        &env.state,
        post_json_with_cookie("/api/user/logout", "{}", &[("cookie", &token)]),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::OK);
    let cookies: Vec<&str> = logout
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert!(cookies.iter().any(|c| c.starts_with("caliber-session=;")));
    assert!(cookies.iter().any(|c| c.starts_with("caliber-user=;")));

    let response = send(&env.state, get_with("/api/stats", &[("cookie", &token)])).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

fn post_json_with_cookie(uri: &str, body: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn login_without_auth_remembers_profile_cookie() {
    let env = TestEnv::new();
    let response = send(
        &env.state,
        post_json("/api/user/login", "{\"username\":\"Carol\"}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let body = json_body(response).await;
    assert_eq!(body["user"]["username"], "Carol");
    assert!(cookie.starts_with("caliber-user=Carol"));

    let me = send(
        &env.state,
        get_with("/api/user/me", &[("cookie", "caliber-user=Carol")]),
    )
    .await;
    let body = json_body(me).await;
    assert_eq!(body["user"]["username"], "Carol");
    assert_eq!(body["authRequired"], false);
    assert_eq!(body["needsSetup"], false);
}

#[tokio::test]
async fn books_list_pagination_total_and_cursor() {
    let env = TestEnv::new();
    let first = send(&env.state, get("/api/books?limit=2")).await;
    assert_eq!(first.status(), StatusCode::OK);
    let body = json_body(first).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
    assert_eq!(body["total"], 3);
    assert_eq!(body["hasMore"], true);
    let cursor = body["nextCursor"].as_str().unwrap().to_string();

    let second = send(
        &env.state,
        get(&format!("/api/books?limit=2&cursor={cursor}")),
    )
    .await;
    let body = json_body(second).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    // Later pages omit the total.
    assert!(body.get("total").is_none());
    assert_eq!(body["hasMore"], false);

    // Explicit includeTotal=0 on the first page opts out.
    let response = send(&env.state, get("/api/books?includeTotal=0")).await;
    let body = json_body(response).await;
    assert!(body.get("total").is_none());

    // Tag filter.
    let response = send(&env.state, get("/api/books?tag=1")).await;
    let body = json_body(response).await;
    assert_eq!(body["total"], 2);

    // Format filter (case-insensitive).
    let response = send(&env.state, get("/api/books?format=pdf")).await;
    let body = json_body(response).await;
    assert_eq!(body["total"], 2);
}

#[tokio::test]
async fn books_list_invalid_cursor_400() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/books?cursor=not-a-cursor")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"], "Invalid cursor");
}

#[tokio::test]
async fn books_list_cache_etag_and_304() {
    let env = TestEnv::new();
    let first = send(&env.state, get("/api/books")).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(
        first.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=60"
    );
    let etag = first
        .headers()
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(etag.starts_with('"') && etag.ends_with('"'));

    let cached = send(&env.state, get("/api/books")).await;
    assert_eq!(
        cached
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap(),
        etag
    );

    let not_modified = send(
        &env.state,
        get_with("/api/books", &[("if-none-match", &etag)]),
    )
    .await;
    assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        not_modified
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap(),
        etag
    );
}

#[tokio::test]
async fn authenticated_requests_get_private_cache_control() {
    let env = TestEnv::new();
    let response = send(
        &env.state,
        get_with("/api/books", &[("cookie", "caliber-user=alice")]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, max-age=60"
    );
}

#[tokio::test]
async fn search_is_never_cached() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/books/search?q=alpha")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    assert!(response.headers().get(header::ETAG).is_none());
    let body = json_body(response).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    // Empty query reuses the cached books listing.
    let response = send(&env.state, get("/api/books/search")).await;
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=60"
    );
    assert!(response.headers().get(header::ETAG).is_some());
}

#[tokio::test]
async fn book_detail_and_404() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/books/1")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["title"], "Alpha & Beta");
    assert_eq!(body["formats"], serde_json::json!(["EPUB", "PDF"]));

    let response = send(&env.state, get("/api/books/999")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = send(&env.state, get("/api/books/abc")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn stats_tags_formats_count() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/stats")).await;
    let body = json_body(response).await;
    assert_eq!(body["totalBooks"], 3);
    assert_eq!(body["totalAuthors"], 2);

    let response = send(&env.state, get("/api/tags")).await;
    let body = json_body(response).await;
    assert_eq!(body.as_array().unwrap().len(), 2);

    let response = send(&env.state, get("/api/formats")).await;
    let body = json_body(response).await;
    assert_eq!(body.as_array().unwrap().len(), 2);

    let response = send(&env.state, get("/api/books/count")).await;
    assert_eq!(json_body(response).await["count"], 3);
}

async fn login_profile(env: &TestEnv, username: &str) -> String {
    let response = send(
        &env.state,
        post_json(
            "/api/user/login",
            &format!("{{\"username\":\"{username}\"}}"),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .trim()
        .to_string()
}

#[tokio::test]
async fn progress_write_protocol_surface() {
    let env = TestEnv::new();
    let cookie = login_profile(&env, "alice").await;

    // Anonymous GET → null progress, no-store.
    let response = send(&env.state, get("/api/user/progress/1")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert!(body["progress"].is_null());

    // Happy path write.
    let library_id = env.state.config.canonical_library_id();
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            &format!(r#"{{"format":"EPUB","percentage":42.5,"location":"epubcfi(/6/4)","mutationId":"m1","expectedLibraryId":"{library_id}"}}"#),
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        text_body(response).await
    );
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
    let body = json_body(response).await;
    assert_eq!(body["applied"], true);
    assert!(body.get("reason").is_none());
    assert_eq!(body["serverSeq"], 1);
    assert_eq!(body["progress"]["percentage"], 42.5);
    assert_eq!(body["deletionSeq"], Value::Null);

    // Identity mismatches.
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            r#"{"format":"EPUB","expectedUserId":999}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(response).await["error"], "Principal mismatch");

    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            r#"{"format":"EPUB","expectedLibraryId":"lib-other"}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(json_body(response).await["error"], "Library mismatch");

    // Invalid format (not in the book's formats).
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            r#"{"format":"MOBI"}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"], "Invalid book format");

    // Malformed format string.
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            r#"{"format":"waytoolongformat"}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Body must be an object.
    let response = send(
        &env.state,
        put_json_with_cookie("/api/user/progress/1", "[1,2]", &[("cookie", &cookie)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"],
        "Request body must be an object"
    );

    // Book must exist.
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/999",
            r#"{"format":"EPUB"}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // GET reflects the row + formats list.
    let response = send(
        &env.state,
        get_with("/api/user/progress/1", &[("cookie", &cookie)]),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["progress"]["format"], "EPUB");
    assert_eq!(body["formats"].as_array().unwrap().len(), 1);
    assert_eq!(body["serverSeq"], 1);

    // Invalid ?format= on GET.
    let response = send(
        &env.state,
        get_with("/api/user/progress/1?format=%2A%2A", &[("cookie", &cookie)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"], "Invalid format");

    // DELETE → removed + deletionSeq; stale write resurrect-guarded.
    let response = send(
        &env.state,
        delete_with_cookie("/api/user/progress/1?format=EPUB", &[("cookie", &cookie)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["removed"], true);
    let deletion_seq = body["deletionSeq"].as_i64().unwrap();
    assert!(deletion_seq >= 1);

    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            r#"{"format":"EPUB","mutationId":"m2"}"#,
            &[("cookie", &cookie)],
        ),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["applied"], false);
    assert_eq!(body["reason"], "deleted");

    // A fresh baseDeletionSeq resurrects.
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            &format!(r#"{{"format":"EPUB","mutationId":"m3","baseDeletionSeq":{deletion_seq}}}"#),
            &[("cookie", &cookie)],
        ),
    )
    .await;
    let body = json_body(response).await;
    assert_eq!(body["applied"], true);
    assert!(body["progress"].is_object());
}

fn put_json_with_cookie(uri: &str, body: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::PUT)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

fn delete_with_cookie(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder().method(Method::DELETE).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn reading_shelf_endpoints() {
    let env = TestEnv::new();
    // Anonymous GET → empty items (not 401).
    let response = send(&env.state, get("/api/user/reading")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["items"], serde_json::json!([]));

    // Anonymous DELETE → 401 Not signed in.
    let response = send(&env.state, delete("/api/user/reading")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let cookie = login_profile(&env, "alice").await;
    let library_id = env.state.config.canonical_library_id();
    let response = send(
        &env.state,
        put_json_with_cookie(
            "/api/user/progress/1",
            &format!(r#"{{"format":"EPUB","percentage":10.0,"expectedLibraryId":"{library_id}"}}"#),
            &[("cookie", &cookie)],
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = send(
        &env.state,
        get_with("/api/user/reading", &[("cookie", &cookie)]),
    )
    .await;
    let body = json_body(response).await;
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["book"]["id"], 1);
    assert_eq!(items[0]["book"]["title"], "Alpha & Beta");
    assert_eq!(items[0]["progress"]["format"], "EPUB");
    assert_eq!(items[0]["progress"]["percentage"], 10.0);

    let response = send(
        &env.state,
        delete_with_cookie("/api/user/reading", &[("cookie", &cookie)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["removed"], 1);
    assert!(body["deletionSeq"].is_number());
}

#[tokio::test]
async fn config_auth_matrix_and_management() {
    let env = TestEnv::new();
    // Auth off + loopback + no opt-in → cannot manage.
    let response = send(&env.state, get("/api/config/auth")).await;
    let body = json_body(response).await;
    assert_eq!(body["authEnabled"], false);
    assert_eq!(body["canManage"], false);
    assert_eq!(body["envControlled"], false);
    assert!(body.get("users").is_none());

    // PUT gated 403.
    let response = send(
        &env.state,
        put_json("/api/config/auth", "{\"enabled\":true}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // With the env opt-in, management opens on loopback.
    {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("CALIBER_ALLOW_NOAUTH_ADMIN", Some("1"))]);
        let response = send(&env.state, get("/api/config/auth")).await;
        let body = json_body(response).await;
        assert_eq!(body["canManage"], true);
        assert!(body["users"].is_array());

        // No-change PUT.
        let response = send(
            &env.state,
            put_json("/api/config/auth", "{\"enabled\":false}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["changed"], false);

        // Enabling with zero accounts requires username+password; weak
        // passwords are rejected BEFORE the toggle persists.
        let response = send(
            &env.state,
            put_json(
                "/api/config/auth",
                "{\"enabled\":true,\"username\":\"op\",\"password\":\"short\"}",
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(response).await["error"],
            "Password must be at least 8 characters"
        );
        assert_eq!(env.state.config.auth_enabled(), false);

        // Valid enable creates the account, flips the toggle, and sets the
        // session cookie in one shot.
        let response = send(
            &env.state,
            put_json(
                "/api/config/auth",
                "{\"enabled\":true,\"username\":\"op\",\"password\":\"password123\"}",
            ),
        )
        .await;
        let has_cookie = response.headers().get(header::SET_COOKIE).is_some();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{}",
            text_body(response).await
        );
        let body = json_body(response).await;
        assert_eq!(body["authEnabled"], true);
        assert_eq!(body["changed"], true);
        assert_eq!(body["user"]["username"], "op");
        assert!(has_cookie);
    }

    // While auth is enabled the route itself is guard-protected: anonymous
    // GET is a 401; an authenticated operator gets the management view.
    let response = send(&env.state, get("/api/config/auth")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let auth = basic_auth("op", "password123");
    let response = send(
        &env.state,
        get_with("/api/config/auth", &[("authorization", &auth)]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["canManage"], true);
    assert_eq!(body["hasAccounts"], true);

    // Create + last-account guard.
    let response = send(
        &env.state,
        post_json_with_auth(
            "/api/auth/users",
            "{\"username\":\"second\",\"password\":\"password123\"}",
            &auth,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    // Duplicate password → 409.
    let response = send(
        &env.state,
        post_json_with_auth(
            "/api/auth/users",
            "{\"username\":\"second\",\"password\":\"password123\"}",
            &auth,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(response).await["error"],
        "second already has a password"
    );

    // Unknown user delete → 404.
    let response = send(&env.state, delete_with_auth("/api/auth/users/ghost", &auth)).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // Delete non-last → ok.
    let response = send(
        &env.state,
        delete_with_auth("/api/auth/users/second", &auth),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["removed"], "second");

    // Delete the last password user → 409.
    let response = send(&env.state, delete_with_auth("/api/auth/users/op", &auth)).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(response).await["error"],
        "Cannot delete the last user with a password"
    );

    // Password change.
    let response = send(
        &env.state,
        post_json_with_auth(
            "/api/auth/users/op/password",
            "{\"password\":\"newpassword1\"}",
            &auth,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    // The old Basic credentials no longer verify after the change.
    let refreshed_auth = basic_auth("op", "newpassword1");
    let response = send(
        &env.state,
        post_json_with_auth(
            "/api/auth/users/ghost/password",
            "{\"password\":\"newpassword1\"}",
            &refreshed_auth,
        ),
    )
    .await;
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "headers={headers:?} body={}",
        text_body(response).await
    );
}

#[tokio::test]
async fn config_library_get_and_loopback_guard() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/config/library")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let library_id = env.state.config.canonical_library_id();
    let body = json_body(response).await;
    assert_eq!(body["ready"], true);
    assert_eq!(body["revision"], 7);
    assert_eq!(body["stale"], false);
    assert_eq!(body["generation"], 1);
    assert_eq!(body["libraryId"], library_id);

    // PUT on loopback with a valid selection.
    let library = env.library();
    let selection = format!(
        "{{\"databasePath\":\"{}\"}}",
        library.join("metadata.db").display()
    );
    let response = send(&env.state, put_json("/api/config/library", &selection)).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        text_body(response).await
    );
    let body = json_body(response).await;
    assert_eq!(body["applied"], true);
    assert_eq!(body["ready"], true);

    // Invalid selection → 400.
    let response = send(
        &env.state,
        put_json(
            "/api/config/library",
            "{\"databasePath\":\"/nonexistent/metadata.db\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Non-loopback bind rejects PUT with 403.
    let tmp = tempfile::tempdir().unwrap();
    let (state, _handles) = {
        let _guard = env_lock();
        make_state(&tmp, |_| {})
    };
    // Re-bind config.host to a public address via a fresh config file.
    let config_path = state.config.resolved().config_path;
    let raw = std::fs::read_to_string(&config_path).unwrap_or_default();
    let mut map: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap_or_default();
    map.insert("host".into(), Value::String("0.0.0.0".into()));
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&Value::Object(map)).unwrap(),
    )
    .unwrap();
    let fresh = caliber_common::Config::load_from(config_path.parent().unwrap().to_path_buf());
    // Host validation also becomes permissive on 0.0.0.0, but the PUT guard
    // checks the config host itself.
    // Host validation also becomes permissive on 0.0.0.0, but the PUT guard
    // checks the config host itself: rebuild a state over the same backends.
    let state2 = AppState::new(
        fresh,
        state.db.clone(),
        state.users.clone(),
        state.static_dir.clone(),
    );
    let response = send(&state2, put_json("/api/config/library", &selection)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn opds_feeds_shape() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/opds")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8"
    );
    let body = text_body(response).await;
    assert!(body.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
    assert!(body.contains("<feed"));
    assert!(body.contains("Authors"));
    assert!(body.contains("3 books sorted by title."));
    // Ampersand escaping.
    assert!(body.contains("Alpha &amp; Beta") || !body.contains("Alpha & Beta"));

    // Acquisition feed with pagination.
    let response = send(&env.state, get("/opds/books?limit=2")).await;
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"
    );
    let body = text_body(response).await;
    assert!(body.matches("<entry>").count() >= 2);
    assert!(body.contains("rel=\"next\""));
    assert!(body.contains("urn:uuid:"));

    // Catalog feed.
    let response = send(&env.state, get("/opds/authors")).await;
    let body = text_body(response).await;
    assert!(body.matches("<entry>").count() == 2);

    // Author books feed.
    let response = send(&env.state, get("/opds/authors/1/books")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(text_body(response).await.contains("<feed"));

    // OpenSearch descriptor. NOTE: the TS getCachedTextResponse overrides
    // any non-no-store Cache-Control with cacheControlFor(req), so the 3600
    // default is effectively replaced by max-age=60 — mirrored here.
    let response = send(&env.state, get("/opds/search.xml")).await;
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/opensearchdescription+xml; charset=utf-8"
    );
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=60"
    );
    let body = text_body(response).await;
    assert!(body.contains("OpenSearchDescription"));
    assert!(body.contains("searchTerms"));

    // Search feed is no-store.
    let response = send(&env.state, get("/opds/search?q=alpha")).await;
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let body = text_body(response).await;
    assert!(body.contains("Search: alpha"));

    // Single-book + complete-entry variants.
    let response = send(&env.state, get("/opds/book/1")).await;
    let body = text_body(response).await;
    assert!(body.contains("<feed"));
    let response = send(&env.state, get("/opds/book/1/complete")).await;
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/atom+xml;type=entry;profile=opds-catalog; charset=utf-8"
    );
    let body = text_body(response).await;
    assert!(body.contains("<entry"));
    assert!(!body.contains("<feed"));
}

#[tokio::test]
async fn file_serving_ranges_and_validation() {
    let env = TestEnv::new();
    let pdf: Vec<u8> = b"%PDF-1.4 fixture-bytes-for-range-tests-0123456789".to_vec();
    env.write_book_file(1, "PDF", &pdf);

    let head = send(
        &env.state,
        request_with(Method::HEAD, "/api/books/1/file/PDF", &[]),
    )
    .await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
    assert_eq!(
        head.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );
    assert_eq!(
        head.headers().get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
        "nosniff"
    );
    let etag = head
        .headers()
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let content_length: usize = head
        .headers()
        .get(header::CONTENT_LENGTH)
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(content_length, pdf.len());
    assert!(head
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .is_empty());

    // 304.
    let not_modified = send(
        &env.state,
        get_with("/api/books/1/file/PDF", &[("if-none-match", &etag)]),
    )
    .await;
    assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);

    // Single range 206.
    let range = send(
        &env.state,
        get_with("/api/books/1/file/PDF", &[("range", "bytes=0-9")]),
    )
    .await;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range.headers().get(header::CONTENT_RANGE).unwrap(),
        format!("bytes 0-9/{}", pdf.len()).as_str()
    );
    let bytes = range.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], &pdf[0..10]);

    // Suffix range.
    let range = send(
        &env.state,
        get_with("/api/books/1/file/PDF", &[("range", "bytes=5-")]),
    )
    .await;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    let bytes = range.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], &pdf[5..]);

    // Out-of-bounds → 416 with Content-Range.
    let invalid = send(
        &env.state,
        get_with(
            "/api/books/1/file/PDF",
            &[("range", "bytes=999999-1000000")],
        ),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        invalid.headers().get(header::CONTENT_RANGE).unwrap(),
        format!("bytes */{}", pdf.len()).as_str()
    );

    // If-Range: matching etag → 206; stale etag → 200 full body.
    let matching = send(
        &env.state,
        get_with(
            "/api/books/1/file/PDF",
            &[("range", "bytes=0-9"), ("if-range", etag.as_str())],
        ),
    )
    .await;
    assert_eq!(matching.status(), StatusCode::PARTIAL_CONTENT);
    let stale = send(
        &env.state,
        get_with(
            "/api/books/1/file/PDF",
            &[("range", "bytes=0-9"), ("if-range", "\"stale\"")],
        ),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::OK);
    assert!(stale.headers().get(header::CONTENT_RANGE).is_none());

    // Unknown format / book.
    let response = send(&env.state, get("/api/books/1/file/NOPE")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = send(&env.state, get("/api/books/1/file/bad!format")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Download uses attachment; inline for a non-readable format downgrades.
    let response = send(&env.state, get("/api/books/1/download/PDF")).await;
    let disposition = response
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        disposition.starts_with("attachment; filename=\""),
        "{disposition}"
    );
    assert!(disposition.contains("filename*=UTF-8''"));
}

fn request_with(method: Method, uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn safe_filename_sanitization() {
    use crate::files::get_safe_book_filename;
    assert_eq!(
        get_safe_book_filename(Some("Alpha & Beta"), "EPUB"),
        "Alpha_&_Beta.epub"
    );
    assert_eq!(
        get_safe_book_filename(Some("What? Is: This%*Book|\"Title\"<>"), "PDF"),
        // Verified against the TS implementation with Bun 1.4.2.
        "What-_Is-_This--Book--Title---.pdf"
    );
    assert_eq!(
        get_safe_book_filename(Some("  spaced   out  "), "TXT"),
        "spaced_out.txt"
    );
    assert_eq!(get_safe_book_filename(Some("..."), "MOBI"), "book.mobi");
    assert_eq!(get_safe_book_filename(None, "EPUB"), "book.epub");
    assert_eq!(get_safe_book_filename(Some("a/b\\c"), "EPUB"), "abc.epub");
    let long: String = "x".repeat(300);
    assert_eq!(
        get_safe_book_filename(Some(&long), "EPUB"),
        format!("{}.epub", "x".repeat(160))
    );
}

#[tokio::test]
async fn epub_entry_serving() {
    let env = TestEnv::new();
    env.write_book_file(1, "EPUB", &fixture_epub());

    // Redirect from the bare path.
    let response = send(&env.state, get("/api/books/1/epub")).await;
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/api/books/1/epub/"
    );

    // Default entry (container.xml).
    let response = send(&env.state, get("/api/books/1/epub/")).await;
    let default_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let status = response.status();
    let text_of_default = text_body(response).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "headers={default_headers:?} body={text_of_default}"
    );
    assert!(text_of_default.contains("OEBPS/content.opf"));

    let response = send(&env.state, get("/api/books/1/epub/META-INF/container.xml")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("application/xml"));
    assert_eq!(
        response.headers().get(header::CONTENT_SECURITY_POLICY).unwrap(),
        "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;"
    );

    // Optional display options default body.
    let response = send(
        &env.state,
        get("/api/books/1/epub/META-INF/com.apple.ibooks.display-options.xml"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(text_body(response).await.contains("<display_options"));

    // Missing entry.
    let response = send(&env.state, get("/api/books/1/epub/OEBPS/nothing.xhtml")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(response).await["error"], "EPUB entry not found");

    // Zip-slip attempt decodes to an unsafe path → 404 (never written).
    let response = send(&env.state, get("/api/books/1/epub/%2e%2e%2fsecret")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn pages_manifest_unsupported_format_415() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/books/1/pages/MOBI/manifest")).await;
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        json_body(response).await["error"],
        "Page streaming is not supported for MOBI"
    );

    // Missing source → 404 Format PDF not found.
    let response = send(&env.state, get("/api/books/1/pages/PDF/manifest")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(response).await["error"], "Format PDF not found");

    // Invalid format param.
    let response = send(&env.state, get("/api/books/1/pages/bad!fmt/manifest")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cbz_manifest_and_page() {
    let env = TestEnv::new();
    let mut cursor = std::io::Cursor::new(Vec::new());
    let png = sample_png(2, 2);
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer.start_file("001.png", options).unwrap();
        writer.write_all(&png).unwrap();
        writer.start_file("002.png", options).unwrap();
        writer.write_all(&png).unwrap();
        writer.start_file("notes.svg", options).unwrap();
        writer.write_all(b"<svg/>").unwrap();
        writer.finish().unwrap();
    }
    env.write_book_file(1, "CBZ", &cursor.into_inner());

    let response = send(&env.state, get("/api/books/1/pages/CBZ/manifest")).await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        text_body(response).await
    );
    let body = json_body(response).await;
    assert_eq!(body["pageCount"], 2); // svg skipped
    assert_eq!(body["format"], "CBZ");
    assert_eq!(body["pages"][0]["href"], "/api/books/1/pages/CBZ/1");
    assert_eq!(body["pages"][0]["type"], "image/png");

    let response = send(&env.state, get("/api/books/1/pages/CBZ/1")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("image/png"));
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap(),
        "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    );

    // Out-of-range page.
    let response = send(&env.state, get("/api/books/1/pages/CBZ/99")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn covers_and_degraded_thumbnail() {
    let env = TestEnv::new();
    let png = sample_png(600, 400);
    env.write_cover(1, &png);

    let response = send(&env.state, get("/api/books/1/cover")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/jpeg"
    );
    let etag = response
        .headers()
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let not_modified = send(
        &env.state,
        get_with("/api/books/1/cover", &[("if-none-match", &etag)]),
    )
    .await;
    assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);

    // Missing-cover book.
    let response = send(&env.state, get("/api/books/2/cover")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // Degraded thumbnail path: resize disabled via env.
    {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("CALIBER_THUMB_DISABLE_RESIZE", Some("1"))]);
        let response = send(&env.state, get("/api/books/1/thumb?size=small")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-thumbnail-degraded")
                .unwrap()
                .to_str()
                .unwrap(),
            "resize-unavailable"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/jpeg"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], &png[..]);
    }

    // Real resize path (env cleared): a 256px JPEG smaller than the source.
    let response = send(&env.state, get("/api/books/1/thumb?size=small")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("x-thumbnail-degraded").is_none());
    let thumb = response.into_body().collect().await.unwrap().to_bytes();
    assert!(!thumb.is_empty());
    assert!(
        thumb.len() < png.len(),
        "resize must shrink the fixture cover"
    );
    let decoded = image::load_from_memory(&thumb).unwrap();
    assert!(decoded.width() <= 256);
    assert_eq!(
        image::guess_format(&thumb).unwrap(),
        image::ImageFormat::Jpeg
    );
}

#[tokio::test]
async fn stream_endpoint_full_array() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/api/books/stream?batchSize=2")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let body = text_body(response).await;
    let parsed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 3);
    assert_eq!(parsed[0]["id"], 1);
    assert_eq!(parsed[2]["id"], 3);
    // Stream rows keep the list-item shape (has formats/title).
    assert_eq!(parsed[0]["title"], "Alpha & Beta");
}

#[tokio::test]
async fn mcp_disabled_and_enabled() {
    let env = TestEnv::new();
    let response = send(
        &env.state,
        post_json(
            "/mcp",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(response).await["error"], "MCP is disabled");

    let tmp = tempfile::tempdir().unwrap();
    let _guard = env_lock();
    let _env = EnvGuard::set(&[("CALIBER_MCP_ENABLED", Some("1"))]);
    let (state, _handles) = make_state(&tmp, |_| {});
    let response = send(
        &state,
        post_json(
            "/mcp",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(
        body["result"]["serverInfo"]["name"],
        "caliber-library-search"
    );

    let response = send(
        &state,
        post_json(
            "/mcp",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}",
        ),
    )
    .await;
    let body = json_body(response).await;
    let tools = body["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);

    let response = send(
        &state,
        post_json(
            "/mcp",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_book_title\",\"arguments\":{\"title\":\"Alpha\"}}}",
        ),
    )
    .await;
    let body = json_body(response).await;
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Library search for title: \"Alpha\""));
    assert!(text.contains("\"Alpha & Beta\" by Alice Author"));

    // Unknown method / tool.
    let response = send(
        &state,
        post_json("/mcp", "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"nope\"}"),
    )
    .await;
    assert_eq!(json_body(response).await["error"]["code"], -32601);
    let response = send(
        &state,
        post_json(
            "/mcp",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"missing\",\"arguments\":{}}}",
        ),
    )
    .await;
    assert_eq!(json_body(response).await["error"]["code"], -32603);

    // Notification → 202; parse error → 400 -32700; batch.
    let response = send(
        &state,
        post_json("/mcp", "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\"}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let response = send(&state, post_json("/mcp", "{invalid json")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"]["code"], -32700);
    let response = send(
        &state,
        post_json(
            "/mcp",
            "[{\"jsonrpc\":\"2.0\",\"method\":\"x\"},{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"initialize\"}]",
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["id"], 9);
}

#[tokio::test]
async fn pdfjs_worker_served_from_static_dir() {
    let env = TestEnv::with(|tc| {
        std::fs::write(tc.static_dir.join("pdf.worker.min.mjs"), b"// worker shim").unwrap();
    });
    let response = send(&env.state, get("/pdfjs/pdf.worker.min.mjs")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("javascript"));
}

#[tokio::test]
async fn pdfjs_worker_missing_404() {
    let env = TestEnv::new();
    let response = send(&env.state, get("/pdfjs/pdf.worker.min.mjs")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
