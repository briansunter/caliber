//! caliber-server: HTTP server for Caliber — JSON API, OPDS feeds,
//! file/media streaming, SPA hosting.
//!
//! Everything is implemented against the backend traits in [`backend.rs`] so
//! the crate builds and tests while `caliber-db` / `caliber-user` are under
//! parallel development; the integration point is [`AppState::new`] +
//! [`run`].

pub mod adapters;
pub mod backend;
pub mod cache;
pub mod epub;
pub mod files;
pub mod guards;
pub mod helpers;
pub mod mcp;
pub mod opds;
pub mod pages;
pub mod routes_books;
pub mod routes_opds;
pub mod routes_user;
pub mod spa;
pub mod state;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use axum::routing::{any, delete, get, post};
use axum::Router;
use state::{AppState, SharedState};

/// 1MB request body limit (TS `maxRequestBodySize`).
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

/// Build the full application router. Registered before `/api/books/{id}`:
/// the literal `search`/`count`/`stream` paths must win over the `{id}`
/// parameter; the SPA fallback is registered last.
pub fn build_router(state: SharedState) -> Router {
    Router::new()
        // Health + config
        .route("/api/health", get(routes_books::health))
        .route(
            "/api/config/library",
            get(routes_user::config_library_get).put(routes_user::config_library_put),
        )
        .route(
            "/api/config/auth",
            get(routes_user::config_auth_get).put(routes_user::config_auth_put),
        )
        // Auth + accounts
        .route("/api/auth/setup", post(routes_user::auth_setup))
        .route("/api/auth/users", post(routes_user::auth_users_post))
        .route(
            "/api/auth/users/{username}",
            delete(routes_user::auth_user_delete),
        )
        .route(
            "/api/auth/users/{username}/password",
            post(routes_user::auth_user_password),
        )
        // Library surfaces
        .route("/api/stats", get(routes_books::stats))
        .route("/api/tags", get(routes_books::tags))
        .route("/api/formats", get(routes_books::formats))
        // Books (literal segments before the {id} routes)
        .route("/api/books/count", get(routes_books::book_count))
        .route("/api/books/stream", get(routes_books::books_stream))
        .route("/api/books/search", get(routes_books::books_search))
        .route("/api/books", get(routes_books::books_list))
        .route("/api/books/{id}", get(routes_books::book_detail))
        .route(
            "/api/books/{id}/download/{format}",
            get(routes_books::book_download).head(routes_books::book_download),
        )
        .route(
            "/api/books/{id}/file/{format}",
            get(routes_books::book_file_inline).head(routes_books::book_file_inline),
        )
        .route(
            "/api/books/{id}/epub",
            get(routes_books::epub_redirect).head(routes_books::epub_redirect),
        )
        .route(
            "/api/books/{id}/epub/",
            get(routes_books::epub_entry_default).head(routes_books::epub_entry_default),
        )
        .route(
            "/api/books/{id}/epub/{*rest}",
            get(routes_books::epub_entry).head(routes_books::epub_entry),
        )
        .route(
            "/api/books/{id}/pages/{format}/manifest",
            get(routes_books::page_manifest).head(routes_books::page_manifest),
        )
        .route(
            "/api/books/{id}/pages/{format}/{page}",
            get(routes_books::page_file).head(routes_books::page_file),
        )
        .route("/api/books/{id}/cover", get(routes_books::book_cover))
        .route("/api/books/{id}/thumb", get(routes_books::book_thumb))
        // Users + reading progress
        .route("/api/user/me", get(routes_user::user_me))
        .route("/api/user/login", post(routes_user::user_login))
        .route("/api/user/logout", post(routes_user::user_logout))
        .route(
            "/api/user/reading",
            get(routes_user::reading_get).delete(routes_user::reading_delete),
        )
        .route(
            "/api/user/progress/{bookId}",
            get(routes_user::progress_get)
                .put(routes_user::progress_put)
                .post(routes_user::progress_post)
                .delete(routes_user::progress_delete),
        )
        // OPDS
        .route("/opds", get(routes_opds::opds_root))
        .route(
            "/opds/search.xml",
            get(routes_opds::opds_search_description),
        )
        .route("/opds/books", get(routes_opds::opds_books))
        .route("/opds/recent", get(routes_opds::opds_recent))
        .route("/opds/authors", get(routes_opds::opds_authors))
        .route(
            "/opds/authors/{id}/books",
            get(routes_opds::opds_author_books),
        )
        .route("/opds/series", get(routes_opds::opds_series))
        .route(
            "/opds/series/{id}/books",
            get(routes_opds::opds_series_books),
        )
        .route("/opds/tags", get(routes_opds::opds_tags))
        .route("/opds/tags/{id}/books", get(routes_opds::opds_tag_books))
        .route("/opds/formats", get(routes_opds::opds_formats))
        .route(
            "/opds/formats/{format}/books",
            get(routes_opds::opds_format_books),
        )
        .route("/opds/search", get(routes_opds::opds_search))
        .route("/opds/book/{id}", get(routes_opds::opds_book))
        .route("/opds/book/{id}/feed", get(routes_opds::opds_book_feed))
        .route(
            "/opds/book/{id}/complete",
            get(routes_opds::opds_book_complete),
        )
        .route(
            "/opds/book/{id}/download/{format}",
            get(routes_opds::opds_book_download).head(routes_opds::opds_book_download),
        )
        .route(
            "/opds/book/{id}/file/{format}",
            get(routes_opds::opds_book_file).head(routes_opds::opds_book_file),
        )
        .route("/opds/book/{id}/cover", get(routes_opds::opds_book_cover))
        .route("/opds/book/{id}/thumb", get(routes_opds::opds_book_thumb))
        // MCP + PDF.js worker + SPA fallback
        .route("/mcp", post(mcp::mcp_route))
        .route("/pdfjs/pdf.worker.min.mjs", get(spa::pdfjs_worker))
        .fallback(any(spa::spa_fallback))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            guards::guard_middleware,
        ))
        .with_state(state)
}

/// Serve until Ctrl-C (graceful) or the listener fails. Startup logging
/// mirrors the TS lines.
pub async fn run(state: SharedState) -> std::io::Result<()> {
    state.wire_refresh_callback();
    let resolved = state.config.resolved();
    let addr = format!("{}:{}", resolved.host, resolved.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("🚀 Server running at http://{}", listener.local_addr()?);
    println!("📚 Library: {}", state.config.library_path().display());
    println!("⚙️ Runtime: Rust (caliber-server)");
    let needs_setup = {
        let users = state.users.clone();
        let auth_enabled = state.config.auth_enabled();
        tokio::task::spawn_blocking(move || users.needs_initial_setup(auth_enabled))
            .await
            .unwrap_or(false)
    };
    if state.config.auth_enabled() {
        if needs_setup {
            println!("🔒 Auth enabled: no accounts yet — create one in the browser or use `caliber-cli user add <name>`");
        } else {
            println!("🔒 Auth enabled");
        }
    }
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown)
        .await
}

/// Convenience constructor mirroring `src/main.rs` wiring.
pub fn app_state(
    config: caliber_common::Config,
    db: std::sync::Arc<dyn backend::CaliberBackend + Send + Sync>,
    users: std::sync::Arc<dyn backend::UserBackend + Send + Sync>,
    static_dir: std::path::PathBuf,
) -> SharedState {
    AppState::new(config, db, users, static_dir)
}

/// `CALIBER_STATIC_DIR` (default `./dist`).
pub fn resolve_static_dir() -> std::path::PathBuf {
    std::env::var("CALIBER_STATIC_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("./dist"))
}
