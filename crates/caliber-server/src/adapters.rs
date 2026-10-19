//! Real-backend adapters: `impl CaliberBackend for CaliberDb` (wrapped) and
//! `impl UserBackend` over `caliber_user::Auth` — the integration point the
//! server crate was built against (see `backend.rs` and CONTRACT.md A/B).

use crate::backend::{
    self, AuthUserRow, CaliberBackend, DbError, PasswordError, ProgressDeletionInfo, ProgressInput,
    ProgressRow, SessionRow, SessionToken, SnapshotLease, SnapshotStatus, UpsertProgressResult,
    User, UserBackend, UserWithCredential,
};
use caliber_common::config::{ConfigError, LibraryConfigStatus, LibrarySelection};
use caliber_common::types::{
    AuthorInfo, BookListItem, BookWithDetails, CatalogEntry, CatalogId, CatalogKind,
    CatalogOptions, CursorPaginatedResult, FormatSummary, LibraryStats, ListOptions, TagSummary,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use caliber_db::CaliberDb;
use caliber_user::Auth;

/// CaliberDb wrapper carrying the Config handle the free-function library
/// selection API needs.
pub struct RealDb {
    pub db: Arc<CaliberDb>,
    pub config: caliber_common::Config,
}

fn map_db_error(error: caliber_db::DbError) -> DbError {
    match error {
        caliber_db::DbError::InvalidCursor => DbError::InvalidCursor,
        caliber_db::DbError::NotReady(m) => DbError::NotReady(m),
        caliber_db::DbError::Io(m) => DbError::Io(m),
        caliber_db::DbError::Internal(m) => DbError::Internal(m),
    }
}

impl CaliberBackend for RealDb {
    fn init(&self) -> bool {
        self.db.init()
    }

    fn is_ready(&self) -> bool {
        self.db.is_ready()
    }

    fn snapshot_revision(&self) -> u64 {
        self.db.snapshot_revision()
    }

    fn snapshot_updated_iso(&self) -> String {
        self.db.snapshot_updated_iso()
    }

    fn snapshot_status(&self) -> SnapshotStatus {
        let status = self.db.snapshot_status();
        SnapshotStatus {
            generation: status.generation,
            revision: status.revision,
            stale: status.stale,
            refreshing: status.refreshing,
            failed: status.failed,
        }
    }

    fn acquire_snapshot_lease(&self) -> SnapshotLease {
        let lease = self.db.acquire_snapshot_lease();
        SnapshotLease::from_release(move || drop(lease))
    }

    fn reconfigure_library(&self) -> Result<(), DbError> {
        self.db.reconfigure_library().map_err(map_db_error)
    }

    fn register_refresh_callback(&self, cb: Box<dyn Fn() + Send + Sync>) {
        self.db.register_refresh_callback(cb);
    }

    fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db.list_books(opts).map_err(map_db_error)
    }

    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db.search_books(opts, query).map_err(map_db_error)
    }

    fn list_books_by_author(
        &self,
        author_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db
            .list_books_by_author(author_id, opts)
            .map_err(map_db_error)
    }

    fn list_books_by_series(
        &self,
        series_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db
            .list_books_by_series(series_id, opts)
            .map_err(map_db_error)
    }

    fn list_books_by_tag(
        &self,
        tag_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db
            .list_books_by_tag(tag_id, opts)
            .map_err(map_db_error)
    }

    fn list_books_by_format(
        &self,
        format: &str,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        self.db
            .list_books_by_format(format, opts)
            .map_err(map_db_error)
    }

    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, DbError> {
        self.db.get_book(id).map_err(map_db_error)
    }

    fn get_books_by_ids(&self, ids: &[i64]) -> HashMap<i64, BookWithDetails> {
        self.db.get_books_by_ids(ids)
    }

    fn get_book_count(&self) -> Result<i64, DbError> {
        self.db.get_book_count().map_err(map_db_error)
    }

    fn get_library_stats(&self) -> Result<LibraryStats, DbError> {
        self.db.get_library_stats().map_err(map_db_error)
    }

    fn list_authors(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        self.db.list_authors(opts).map_err(map_db_error)
    }

    fn list_series(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        self.db.list_series(opts).map_err(map_db_error)
    }

    fn list_tags(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        self.db.list_tags(opts).map_err(map_db_error)
    }

    fn list_formats(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        self.db.list_formats(opts).map_err(map_db_error)
    }

    fn get_catalog_entry(&self, kind: CatalogKind, id: &CatalogId) -> Option<CatalogEntry> {
        self.db.get_catalog_entry(kind, id)
    }

    fn list_all_tags(&self, limit: u32) -> Vec<TagSummary> {
        self.db.list_all_tags(limit)
    }

    fn list_all_formats(&self) -> Vec<FormatSummary> {
        self.db.list_all_formats()
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

    fn stream_books_batch(
        &self,
        last_id: i64,
        batch_size: u32,
    ) -> Result<Vec<BookListItem>, DbError> {
        self.db
            .stream_books_batch(last_id, batch_size)
            .map_err(map_db_error)
    }

    fn library_path(&self) -> PathBuf {
        self.db.library_path()
    }

    fn book_title(&self, id: i64) -> Option<String> {
        self.db.book_title(id)
    }

    fn book_format_path(&self, book_id: i64, format: &str) -> Option<PathBuf> {
        self.db.book_format_path(book_id, format)
    }

    fn book_cover_path(&self, book_id: i64) -> Option<PathBuf> {
        self.db.book_cover_path(book_id)
    }

    fn save_library_config_with_validation(
        &self,
        selection: LibrarySelection,
    ) -> Result<LibraryConfigStatus, ConfigError> {
        caliber_db::save_library_config_with_validation(&self.config, selection)
    }
}

// ---------------------------------------------------------------------------
// UserBackend over caliber_user::Auth
// ---------------------------------------------------------------------------

fn map_user(user: caliber_user::User) -> User {
    User {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
        last_seen_at: user.last_seen_at,
    }
}

fn map_progress_row(row: caliber_user::ProgressRow) -> ProgressRow {
    ProgressRow {
        book_id: row.book_id,
        library_id: row.library_id,
        format: row.format,
        location: row.location,
        percentage: row.percentage,
        furthest_percentage: row.furthest_percentage,
        finished: row.finished,
        started_at: row.started_at,
        updated_at: row.updated_at,
        server_seq: row.server_seq,
        last_mutation_id: row.last_mutation_id,
    }
}

fn map_progress_input(input: &ProgressInput) -> caliber_user::ProgressInput {
    caliber_user::ProgressInput {
        format: input.format.clone(),
        location: input.location.clone(),
        percentage: input.percentage,
        finished: input.finished,
        mutation_id: input.mutation_id.clone(),
        client_ts: input.client_ts,
        base_revision: input.base_revision,
        base_deletion_seq: input.base_deletion_seq,
        force: input.force,
    }
}

/// Thin wrapper so `AppState` can hold one `Arc<dyn UserBackend>` covering
/// both the `UserDb` surface and the `Auth` surface.
pub struct RealUsers {
    pub auth: Arc<Auth>,
}

impl UserBackend for RealUsers {
    fn get_or_create_user(&self, raw: &str) -> Option<User> {
        self.auth.user_db().get_or_create_user(raw).map(map_user)
    }

    fn get_user_by_username(&self, raw: &str) -> Option<User> {
        self.auth.user_db().get_user_by_username(raw).map(map_user)
    }

    fn get_user_by_id(&self, id: i64) -> Option<User> {
        self.auth.user_db().get_user_by_id(id).map(map_user)
    }

    fn get_credential_by_username(&self, raw: &str) -> Option<UserWithCredential> {
        self.auth
            .user_db()
            .get_credential_by_username(raw)
            .map(|c| UserWithCredential {
                id: c.id,
                username: c.username,
                password_hash: c.password_hash,
                auth_epoch: c.auth_epoch,
            })
    }

    fn create_user_with_password(&self, raw: &str, password_hash: &str) -> Option<User> {
        self.auth
            .user_db()
            .create_user_with_password(raw, password_hash)
            .map(map_user)
    }

    fn set_user_password(&self, user_id: i64, password_hash: Option<&str>) {
        self.auth
            .user_db()
            .set_user_password(user_id, password_hash);
    }

    fn delete_sessions_for_user(&self, user_id: i64) -> usize {
        self.auth.user_db().delete_sessions_for_user(user_id)
    }

    fn get_auth_epoch(&self, user_id: i64) -> Option<i64> {
        self.auth.user_db().get_auth_epoch(user_id)
    }

    fn count_users_with_password(&self) -> i64 {
        self.auth.user_db().count_users_with_password()
    }

    fn list_auth_users(&self) -> Vec<AuthUserRow> {
        self.auth
            .user_db()
            .list_auth_users()
            .into_iter()
            .map(|row| AuthUserRow {
                id: row.id,
                username: row.username,
                has_password: row.has_password,
                created_at: row.created_at,
                last_seen_at: row.last_seen_at,
            })
            .collect()
    }

    fn delete_user(&self, raw: &str) -> Option<User> {
        self.auth.user_db().delete_user(raw).map(map_user)
    }

    fn create_session(&self, token_hash: &str, user_id: i64, expires_at: i64) {
        self.auth
            .user_db()
            .create_session(token_hash, user_id, expires_at);
    }

    fn get_session(&self, token_hash: &str) -> Option<SessionRow> {
        self.auth
            .user_db()
            .get_session(token_hash)
            .map(|s| SessionRow {
                token_hash: s.token_hash,
                user_id: s.user_id,
                created_at: s.created_at,
                expires_at: s.expires_at,
                auth_epoch: s.auth_epoch,
            })
    }

    fn delete_session(&self, token_hash: &str) -> bool {
        self.auth.user_db().delete_session(token_hash)
    }

    fn delete_expired_sessions(&self) -> usize {
        self.auth.user_db().delete_expired_sessions()
    }

    fn get_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        self.auth
            .user_db()
            .get_progress(user_id, library_id, book_id, format)
            .map(map_progress_row)
    }

    fn list_progress_formats(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
    ) -> Vec<ProgressRow> {
        self.auth
            .user_db()
            .list_progress_formats(user_id, library_id, book_id)
            .into_iter()
            .map(map_progress_row)
            .collect()
    }

    fn list_progress(&self, user_id: i64, library_id: &str, limit: u32) -> Vec<ProgressRow> {
        self.auth
            .user_db()
            .list_progress(user_id, library_id, limit)
            .into_iter()
            .map(map_progress_row)
            .collect()
    }

    fn upsert_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        input: &ProgressInput,
    ) -> UpsertProgressResult {
        let result = self.auth.user_db().upsert_progress(
            user_id,
            library_id,
            book_id,
            &map_progress_input(input),
        );
        UpsertProgressResult {
            progress: result.progress.map(map_progress_row),
            applied: result.applied,
            reason: result.reason,
        }
    }

    fn delete_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> bool {
        self.auth
            .user_db()
            .delete_progress(user_id, library_id, book_id, format)
    }

    fn clear_progress(&self, user_id: i64, library_id: &str) -> usize {
        self.auth.user_db().clear_progress(user_id, library_id)
    }

    fn set_finished(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        finished: bool,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        self.auth
            .user_db()
            .set_finished(user_id, library_id, book_id, finished, format)
            .map(map_progress_row)
    }

    fn progress_deletion(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> ProgressDeletionInfo {
        let info = self
            .auth
            .user_db()
            .progress_deletion(user_id, library_id, book_id, format);
        ProgressDeletionInfo {
            seq: info.seq,
            at: info.at,
        }
    }

    fn library_deletion(&self, user_id: i64, library_id: &str) -> ProgressDeletionInfo {
        let info = self.auth.user_db().library_deletion(user_id, library_id);
        ProgressDeletionInfo {
            seq: info.seq,
            at: info.at,
        }
    }

    fn hash_password(&self, password: &str) -> String {
        self.auth.hash_password(password)
    }

    fn verify_password(&self, password: &str, hash: &str) -> bool {
        self.auth.verify_password(password, hash)
    }

    fn is_valid_password(&self, password: &str) -> bool {
        self.auth.is_valid_password(password)
    }

    fn needs_initial_setup(&self, auth_enabled: bool) -> bool {
        self.auth.needs_initial_setup(auth_enabled)
    }

    fn create_session_token(&self, user_id: i64) -> SessionToken {
        let token = self.auth.create_session_token(user_id);
        SessionToken {
            token: token.token,
            expires_at: token.expires_at,
        }
    }

    fn resolve_session_token(&self, token: Option<&str>) -> Option<User> {
        self.auth.resolve_session_token(token).map(map_user)
    }

    fn revoke_session_token(&self, token: Option<&str>) {
        self.auth.revoke_session_token(token);
    }

    fn purge_expired_sessions(&self) {
        self.auth.purge_expired_sessions();
    }

    fn session_cookie_header(&self, token: Option<&str>) -> String {
        self.auth.session_cookie_header(token)
    }

    fn login_rate_limited(&self, client_key: &str) -> bool {
        self.auth.login_rate_limited(client_key)
    }

    fn authenticate_with_password(
        &self,
        client_key: &str,
        username: &str,
        password: &str,
    ) -> Option<User> {
        self.auth
            .authenticate_with_password(client_key, username, password)
            .map(map_user)
    }

    fn parse_basic_auth(&self, header: &str) -> Option<(String, String)> {
        caliber_user::Auth::parse_basic_auth(header)
    }

    fn authenticate_basic(&self, client_key: &str, header: &str) -> Option<User> {
        self.auth
            .authenticate_basic(client_key, header)
            .map(map_user)
    }

    fn set_password_for_user(&self, username: &str, password: &str) -> Result<User, PasswordError> {
        self.auth
            .set_password_for_user(username, password)
            .map(map_user)
            .map_err(|e| PasswordError(e.0))
    }

    fn normalize_username(&self, raw: &str) -> String {
        caliber_user::normalize_username(raw)
    }

    fn is_valid_username(&self, raw: &str) -> bool {
        caliber_user::is_valid_username(raw)
    }

    fn normalize_library_id(&self, raw: &str) -> String {
        caliber_user::normalize_library_id(raw)
    }

    fn is_valid_location_for_format(&self, format: &str, location: Option<&str>) -> bool {
        caliber_user::is_valid_location_for_format(format, location)
    }

    fn sanitize_location_for_format(&self, format: &str, location: Option<&str>) -> Option<String> {
        caliber_user::sanitize_location_for_format(format, location)
    }
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<RealDb>();
    assert_send_sync::<RealUsers>();
};

// Silence unused-import warnings for re-exported names used only in docs.
#[allow(unused_imports)]
use backend as _backend_docs;
