//! Adapters wiring the real `caliber-db` / `caliber-user` crates into the
//! CLI/MCP trait surface (`traits.rs`). Compiled only with the
//! `real-backends` feature (enabled at integration once both crates land).
//!
//! Signatures follow `docs/rust/CONTRACT.md` sections A and B. If the
//! delivered crates deviate, fix the mapping here — the CLI/MCP cores must
//! not change.

use std::path::PathBuf;
use std::sync::Arc;

use caliber_common::types::{
    AuthorInfo, BookListItem, BookWithDetails, CursorPaginatedResult, LibraryStats, ListOptions,
};

use super::mcp_core::AuthorSummary;
use super::traits::{AuthUserInfo, CatalogSource, UserAdmin};

pub struct RealCatalog {
    pub db: Arc<caliber_db::CaliberDb>,
    pub config: caliber_common::Config,
}

impl CatalogSource for RealCatalog {
    fn init(&self) -> bool {
        self.db.init()
    }
    fn is_ready(&self) -> bool {
        self.db.is_ready()
    }
    fn get_library_stats(&self) -> Result<LibraryStats, String> {
        self.db.get_library_stats().map_err(|e| e.to_string())
    }
    fn get_book_count(&self) -> Result<i64, String> {
        self.db.get_book_count().map_err(|e| e.to_string())
    }
    fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, String> {
        self.db.list_books(opts).map_err(|e| e.to_string())
    }
    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, String> {
        self.db.search_books(opts, query).map_err(|e| e.to_string())
    }
    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, String> {
        self.db.get_book(id).map_err(|e| e.to_string())
    }
    fn stream_batch(&self, last_id: i64, batch_size: u32) -> Result<Vec<BookListItem>, String> {
        self.db
            .stream_books_batch(last_id, batch_size)
            .map_err(|e| e.to_string())
    }
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        self.db.search_books_by_title(title, limit)
    }
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        self.db.search_books_by_author(author, limit)
    }
    fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo> {
        self.db.get_author_by_name(name)
    }
    fn library_path(&self) -> PathBuf {
        self.db.library_path()
    }
    fn db_name(&self) -> String {
        self.config.resolved().db_name
    }
    fn source_db_exists(&self) -> bool {
        self.library_path().join(self.db_name()).exists()
    }
    fn book_format_path(&self, id: i64, format: &str) -> Option<PathBuf> {
        self.db.book_format_path(id, format)
    }
    fn book_cover_path(&self, id: i64) -> Option<PathBuf> {
        self.db.book_cover_path(id)
    }
}

pub struct RealUsers {
    pub auth: Arc<caliber_user::Auth>,
}

impl UserAdmin for RealUsers {
    fn min_password_length(&self) -> usize {
        caliber_user::MIN_PASSWORD_LENGTH
    }
    fn get_credential(&self, username: &str) -> Option<(String, bool)> {
        self.auth
            .user_db()
            .get_credential_by_username(username)
            .map(|c| (c.username, c.password_hash.is_some()))
    }
    fn list_auth_users(&self) -> Vec<AuthUserInfo> {
        self.auth
            .user_db()
            .list_auth_users()
            .into_iter()
            .map(|u| AuthUserInfo {
                id: u.id,
                username: u.username,
                has_password: u.has_password,
                last_seen_at: u.last_seen_at,
            })
            .collect()
    }
    fn delete_user(&self, username: &str) -> Option<String> {
        self.auth
            .user_db()
            .delete_user(username)
            .map(|u| u.username)
    }
    fn set_password_for_user(
        &self,
        username: &str,
        password: &str,
    ) -> Result<(i64, String), String> {
        self.auth
            .set_password_for_user(username, password)
            .map(|u| (u.id, u.username))
            .map_err(|e| e.0)
    }
}

pub struct RealMcpSource {
    pub db: Arc<caliber_db::CaliberDb>,
}

impl super::mcp_core::McpSource for RealMcpSource {
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        self.db.search_books_by_title(title, limit)
    }
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        self.db.search_books_by_author(author, limit)
    }
    fn get_author_by_name(&self, name: &str) -> Option<AuthorSummary> {
        self.db.get_author_by_name(name).map(|a| AuthorSummary {
            name: a.name,
            book_count: a.book_count,
        })
    }
    fn search_books_paged(&self, query: &str, limit: u32) -> Vec<BookListItem> {
        let opts = ListOptions {
            limit: Some(limit),
            ..Default::default()
        };
        self.db
            .search_books(&opts, query)
            .map(|r| r.items)
            .unwrap_or_default()
    }
}
