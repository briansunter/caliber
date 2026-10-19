//! Backend trait boundary.
//!
//! The server is implemented entirely against these traits so it can be built
//! and tested while `caliber-db` / `caliber-user` are under parallel
//! development. The method signatures mirror the public APIs specified for
//! `CaliberDb` / `UserDb` / `Auth` in `docs/rust/CONTRACT.md` sections A and
//! B. At integration time the lead agent writes
//! `impl CaliberBackend for caliber_db::CaliberDb` and
//! `impl UserBackend for caliber_user::Auth` (see PARITY.md).
//!
//! The data types here are byte-compatible with the contract's caliber-user
//! types (same fields, same serde wire format).

use caliber_common::config::LibrarySelection;
use caliber_common::{
    AuthorInfo, BookListItem, BookWithDetails, CatalogEntry, CatalogId, CatalogKind,
    CatalogOptions, ConfigError, CursorPaginatedResult, FormatSummary, LibraryConfigStatus,
    LibraryStats, ListOptions, TagSummary,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// CaliberDb types (CONTRACT.md section A)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    pub generation: u64,
    pub revision: u64,
    pub stale: bool,
    pub refreshing: bool,
    pub failed: Option<String>,
}

#[derive(Debug)]
pub enum DbError {
    InvalidCursor,
    NotReady(String),
    Io(String),
    Internal(String),
}

/// RAII snapshot lease. The server only requires that dropping the guard
/// releases the lease; the real implementation returns its own guard which
/// the integration adapter wraps here.
pub struct SnapshotLease {
    release: Option<Box<dyn FnOnce() + Send>>,
}

impl SnapshotLease {
    pub fn from_release(release: impl FnOnce() + Send + 'static) -> Self {
        SnapshotLease {
            release: Some(Box::new(release)),
        }
    }

    /// A no-op lease for backends that have nothing to pin (tests).
    pub fn noop() -> Self {
        SnapshotLease { release: None }
    }
}

impl Drop for SnapshotLease {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

/// `pub trait CaliberBackend` — mirror of `impl CaliberDb` in CONTRACT.md A.
/// All methods are synchronous (rusqlite work); the server wraps every call
/// in `spawn_blocking`.
pub trait CaliberBackend: Send + Sync {
    /// initFTS(): build/verify snapshot + FTS, warm up, start refresh timer.
    fn init(&self) -> bool;
    fn is_ready(&self) -> bool;
    /// Cache-key component.
    fn snapshot_revision(&self) -> u64;
    /// Snapshot file mtime ISO-8601 (epoch on error).
    fn snapshot_updated_iso(&self) -> String;
    fn snapshot_status(&self) -> SnapshotStatus;
    /// Pins the current generation for the returned guard's lifetime.
    fn acquire_snapshot_lease(&self) -> SnapshotLease;
    /// Re-point at Config's (new) library and rebuild the snapshot.
    fn reconfigure_library(&self) -> Result<(), DbError>;
    fn register_refresh_callback(&self, cb: Box<dyn Fn() + Send + Sync>);

    fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    /// FTS5 search; empty/whitespace query delegates to list_books.
    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    fn list_books_by_author(
        &self,
        author_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    fn list_books_by_series(
        &self,
        series_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    fn list_books_by_tag(
        &self,
        tag_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    fn list_books_by_format(
        &self,
        format: &str,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, DbError>;
    /// Batched details lookup (dedup, cap 500).
    fn get_books_by_ids(&self, ids: &[i64]) -> HashMap<i64, BookWithDetails>;
    fn get_book_count(&self) -> Result<i64, DbError>;
    fn get_library_stats(&self) -> Result<LibraryStats, DbError>;

    fn list_authors(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    fn list_series(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    fn list_tags(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    fn list_formats(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    fn get_catalog_entry(&self, kind: CatalogKind, id: &CatalogId) -> Option<CatalogEntry>;
    /// Clamp 1..=5000, default 2000 — the backend applies its own clamping.
    fn list_all_tags(&self, limit: u32) -> Vec<TagSummary>;
    fn list_all_formats(&self) -> Vec<FormatSummary>;
    /// Clamp default 10 max 200 — applied by the backend.
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem>;
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem>;
    fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo>;
    /// One id-ordered batch for /api/books/stream (clamp 1..=5000, default
    /// 1000 — applied by the backend).
    fn stream_books_batch(
        &self,
        last_id: i64,
        batch_size: u32,
    ) -> Result<Vec<BookListItem>, DbError>;

    /// Live from Config.
    fn library_path(&self) -> PathBuf;
    fn book_title(&self, id: i64) -> Option<String>;
    fn book_format_path(&self, book_id: i64, format: &str) -> Option<PathBuf>;
    fn book_cover_path(&self, book_id: i64) -> Option<PathBuf>;

    /// PUT /api/config/library backend: prepare (Config path validation) →
    /// Calibre schema validation → apply. Mirrors TS `saveLibraryConfig`
    /// including its error strings. Integration adapter delegates to the
    /// crate-level `save_library_config_with_validation(config, selection)`.
    fn save_library_config_with_validation(
        &self,
        selection: LibrarySelection,
    ) -> Result<LibraryConfigStatus, ConfigError>;
}

// ---------------------------------------------------------------------------
// UserDb / Auth types (CONTRACT.md section B)
// ---------------------------------------------------------------------------

pub const SESSION_COOKIE: &str = "caliber-session";
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const MIN_PASSWORD_LENGTH: usize = 8;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct User {
    pub id: i64,
    pub username: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserRow {
    pub id: i64,
    pub username: String,
    pub has_password: bool,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone)]
pub struct UserWithCredential {
    pub id: i64,
    pub username: String,
    pub password_hash: Option<String>,
    pub auth_epoch: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRow {
    pub book_id: i64,
    pub library_id: String,
    pub format: String,
    pub location: Option<String>,
    pub percentage: f64,
    pub furthest_percentage: f64,
    pub finished: bool,
    pub started_at: i64,
    pub updated_at: i64,
    pub server_seq: i64,
    pub last_mutation_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProgressInput {
    pub format: String,
    pub location: Option<String>,
    pub percentage: Option<f64>,
    pub finished: bool,
    pub mutation_id: Option<String>,
    pub client_ts: Option<i64>,
    pub base_revision: Option<i64>,
    pub base_deletion_seq: Option<i64>,
    pub force: bool,
}

#[derive(Debug, Serialize)]
pub struct UpsertProgressResult {
    pub progress: Option<ProgressRow>,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct ProgressDeletionInfo {
    pub seq: Option<i64>,
    pub at: Option<i64>,
}

#[derive(Clone)]
pub struct SessionRow {
    pub token_hash: String,
    pub user_id: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub auth_epoch: i64,
}
pub struct SessionToken {
    pub token: String,
    pub expires_at: i64,
}

#[derive(Debug)]
pub struct PasswordError(pub String);

/// `pub trait UserBackend` — union of the `UserDb` and `Auth` impls in
/// CONTRACT.md section B. All methods synchronous; the server wraps hot
/// argon2 paths in `spawn_blocking`.
pub trait UserBackend: Send + Sync {
    // --- UserDb ---
    fn get_or_create_user(&self, raw: &str) -> Option<User>;
    fn get_user_by_username(&self, raw: &str) -> Option<User>;
    fn get_user_by_id(&self, id: i64) -> Option<User>;
    fn get_credential_by_username(&self, raw: &str) -> Option<UserWithCredential>;
    fn create_user_with_password(&self, raw: &str, password_hash: &str) -> Option<User>;
    /// Txn: update hash + bump auth_epoch + delete sessions.
    fn set_user_password(&self, user_id: i64, password_hash: Option<&str>);
    fn delete_sessions_for_user(&self, user_id: i64) -> usize;
    fn get_auth_epoch(&self, user_id: i64) -> Option<i64>;
    fn count_users_with_password(&self) -> i64;
    fn list_auth_users(&self) -> Vec<AuthUserRow>;
    fn delete_user(&self, raw: &str) -> Option<User>;
    fn create_session(&self, token_hash: &str, user_id: i64, expires_at: i64);
    fn get_session(&self, token_hash: &str) -> Option<SessionRow>;
    fn delete_session(&self, token_hash: &str) -> bool;
    fn delete_expired_sessions(&self) -> usize;

    // --- progress ---
    fn get_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> Option<ProgressRow>;
    fn list_progress_formats(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
    ) -> Vec<ProgressRow>;
    /// Clamp 1..=500 — applied by the backend.
    fn list_progress(&self, user_id: i64, library_id: &str, limit: u32) -> Vec<ProgressRow>;
    fn upsert_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        input: &ProgressInput,
    ) -> UpsertProgressResult;
    fn delete_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> bool;
    fn clear_progress(&self, user_id: i64, library_id: &str) -> usize;
    fn set_finished(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        finished: bool,
        format: Option<&str>,
    ) -> Option<ProgressRow>;
    fn progress_deletion(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> ProgressDeletionInfo;
    fn library_deletion(&self, user_id: i64, library_id: &str) -> ProgressDeletionInfo;

    // --- Auth ---
    /// argon2id PHC string (Bun-compatible). May be CPU-heavy.
    fn hash_password(&self, password: &str) -> String;
    /// Verifies Bun.password PHC hashes. May be CPU-heavy.
    fn verify_password(&self, password: &str, hash: &str) -> bool;
    /// 8..=512.
    fn is_valid_password(&self, password: &str) -> bool;
    fn needs_initial_setup(&self, auth_enabled: bool) -> bool;
    /// 32 random bytes -> base64url no-pad; DB stores sha256 hex.
    fn create_session_token(&self, user_id: i64) -> SessionToken;
    fn resolve_session_token(&self, token: Option<&str>) -> Option<User>;
    fn revoke_session_token(&self, token: Option<&str>);
    fn purge_expired_sessions(&self);
    fn session_cookie_header(&self, token: Option<&str>) -> String;
    /// 10 fails / 15 min.
    fn login_rate_limited(&self, client_key: &str) -> bool;
    /// May be CPU-heavy (argon2 verify).
    fn authenticate_with_password(
        &self,
        client_key: &str,
        username: &str,
        password: &str,
    ) -> Option<User>;
    /// RFC 7617 parser; returns (username, password).
    fn parse_basic_auth(&self, header: &str) -> Option<(String, String)>;
    /// 5min/10k cache + epoch recheck. May be CPU-heavy.
    fn authenticate_basic(&self, client_key: &str, header: &str) -> Option<User>;
    fn set_password_for_user(&self, username: &str, password: &str) -> Result<User, PasswordError>;

    // --- names / locations (user-db.ts helpers) ---
    fn normalize_username(&self, raw: &str) -> String;
    fn is_valid_username(&self, raw: &str) -> bool;
    fn normalize_library_id(&self, raw: &str) -> String;
    fn is_valid_location_for_format(&self, format: &str, location: Option<&str>) -> bool;
    fn sanitize_location_for_format(&self, format: &str, location: Option<&str>) -> Option<String>;
}
