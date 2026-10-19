//! Backend surface needed by the `caliber-cli` and `caliber-mcp` binaries.
//!
//! These traits mirror the frozen public API of `caliber_db::CaliberDb` and
//! `caliber_user::{UserDb, Auth}` (see `docs/rust/CONTRACT.md`). The real
//! adapters live in `adapters.rs`; the in-memory fixtures in `fixtures.rs`
//! power the module unit tests until the crates land.

use caliber_common::types::{
    AuthorInfo, BookListItem, BookWithDetails, CursorPaginatedResult, ListOptions,
};
use std::path::PathBuf;

/// Read side of the catalog (subset of `CaliberDb` used by CLI/MCP).
pub trait CatalogSource: Send + Sync {
    /// initFTS(): ensure snapshot + FTS; false = library not ready.
    fn init(&self) -> bool;
    fn is_ready(&self) -> bool;
    fn get_library_stats(&self) -> Result<caliber_common::types::LibraryStats, String>;
    fn get_book_count(&self) -> Result<i64, String>;
    fn list_books(&self, opts: &ListOptions)
        -> Result<CursorPaginatedResult<BookListItem>, String>;
    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, String>;
    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, String>;
    /// One id-ordered batch (`stream_books_batch`).
    fn stream_batch(&self, last_id: i64, batch_size: u32) -> Result<Vec<BookListItem>, String>;
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem>;
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem>;
    fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo>;
    fn library_path(&self) -> PathBuf;
    /// Configured database filename within the library (TS `DB_NAME`).
    fn db_name(&self) -> String;
    fn source_db_exists(&self) -> bool;
    fn book_format_path(&self, id: i64, format: &str) -> Option<PathBuf>;
    fn book_cover_path(&self, id: i64) -> Option<PathBuf>;
}

/// User administration surface (subset of `caliber_user` used by the CLI).
pub trait UserAdmin: Send + Sync {
    fn min_password_length(&self) -> usize {
        8
    }
    /// `{username, has_password}` — the credential lookup used by add/passwd.
    fn get_credential(&self, username: &str) -> Option<(String, bool)>;
    fn list_auth_users(&self) -> Vec<AuthUserInfo>;
    fn delete_user(&self, username: &str) -> Option<String>;
    /// Validates + hashes + persists; returns (id, username) or an error
    /// message (mirrors `Auth::set_password_for_user` / `PasswordError`).
    fn set_password_for_user(
        &self,
        username: &str,
        password: &str,
    ) -> Result<(i64, String), String>;
}

#[derive(Debug, Clone)]
pub struct AuthUserInfo {
    pub id: i64,
    pub username: String,
    pub has_password: bool,
    pub last_seen_at: i64,
}
