//! caliber-db: the Calibre metadata data layer.
//!
//! Port of `src/lib/calibre-optimized.ts` (+ the library-selection tail of
//! `src/lib/config.ts`). The source library is never written: a serialized
//! snapshot with FTS5 + expression indexes is built in the config cache
//! directory and republished as immutable generations; readers use a bounded
//! connection pool and RAII snapshot leases. All operations are synchronous —
//! the server wraps them in `spawn_blocking`.

mod catalog;
mod detail;
mod error;
mod listing;
mod setup;
mod snapshot;
mod util;

use caliber_common::config::LibrarySelection;
use caliber_common::types::{
    AuthorInfo, BookListItem, BookWithDetails, CatalogEntry, CatalogId, CatalogKind,
    CatalogOptions, CursorPaginatedResult, FormatSummary, LibraryStats, ListOptions, SortField,
    TagSummary,
};
use caliber_common::{Config, ConfigError, LibraryConfigStatus};
use rusqlite::{Connection, OpenFlags};
use snapshot::{Inner, Shared};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub use error::DbError;
pub use snapshot::{SnapshotLease, SnapshotStatus};

/// Handle to the data engine. Cheap to wrap in `Arc`; `Send + Sync`.
pub struct CaliberDb {
    shared: Arc<Shared>,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<CaliberDb>();
    assert_send_sync::<SnapshotLease>();
};

impl CaliberDb {
    /// Create the engine. No I/O happens until [`CaliberDb::init`].
    pub fn open(config: Config) -> CaliberDb {
        let config_dir = config.resolved().config_dir.clone();
        let writable = config_dir.join("metadata.db");
        CaliberDb {
            shared: Arc::new(Shared {
                config,
                inner: std::sync::Mutex::new(Inner {
                    generation_counter: 0,
                    active: snapshot::ActiveGeneration {
                        id: 0,
                        path: writable,
                        revision: 0,
                    },
                    leases: HashMap::new(),
                    refreshing: false,
                    failed: None,
                    refresh_pending: false,
                    checkouts: 0,
                    timer_started: false,
                }),
                inner_cv: std::sync::Condvar::new(),
                pool: std::sync::Mutex::new(Vec::new()),
                gate: std::sync::Mutex::new(()),
                callbacks: std::sync::Mutex::new(Vec::new()),
                ready: std::sync::atomic::AtomicBool::new(false),
                stop: std::sync::atomic::AtomicBool::new(false),
                timer_gate: std::sync::Mutex::new(()),
                timer_cv: std::sync::Condvar::new(),
            }),
        }
    }

    /// `initFTS()`: build/verify snapshot + FTS, warm up, start the refresh
    /// timer. Returns readiness; `false` leaves the server up for
    /// Settings-driven library selection.
    pub fn init(&self) -> bool {
        let ready = self.shared.init();
        self.shared.start_refresh_timer();
        ready
    }

    pub fn is_ready(&self) -> bool {
        self.shared.ready.load(Ordering::SeqCst)
    }

    /// Monotonic revision of the published snapshot; cache-key component.
    pub fn snapshot_revision(&self) -> u64 {
        self.shared.inner.lock().unwrap().active.revision
    }

    /// ISO instant the published snapshot file was written (epoch on error).
    pub fn snapshot_updated_iso(&self) -> String {
        let path = self.shared.inner.lock().unwrap().active.path.clone();
        match std::fs::metadata(&path) {
            Ok(md) => util::iso8601_utc(md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)),
            Err(_) => util::iso8601_utc(std::time::SystemTime::UNIX_EPOCH),
        }
    }

    pub fn snapshot_status(&self) -> SnapshotStatus {
        let inner = self.shared.inner.lock().unwrap();
        let generation = inner.active.id;
        let revision = inner.active.revision;
        let mut stale = inner.refresh_pending || inner.refreshing;
        let refreshing = inner.refreshing;
        let failed = inner.failed.clone();
        drop(inner);
        if self.shared.source_changed() {
            stale = true;
        }
        SnapshotStatus {
            generation,
            revision,
            stale,
            refreshing,
            failed,
        }
    }

    /// Pin the current generation; a refresh defers until all leases and pool
    /// checkouts release. Clone-able RAII guard.
    pub fn acquire_snapshot_lease(&self) -> SnapshotLease {
        self.shared.acquire_snapshot_lease()
    }

    /// Re-point at the Config's (new) library and rebuild the snapshot.
    /// Defers while leases/checkouts are held
    /// (mirrors `reconfigureLibraryDatabase`).
    pub fn reconfigure_library(&self) -> Result<(), DbError> {
        self.shared.run_refresh_result().map_err(DbError::from)
    }

    pub fn register_refresh_callback(&self, cb: Box<dyn Fn() + Send + Sync>) {
        self.shared.callbacks.lock().unwrap().push(Arc::new(cb));
    }

    // --- Listings ----------------------------------------------------------

    pub fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        listing::list_books_with_where(&self.shared, opts, "WHERE 1=1", Vec::new())
    }

    /// FTS5 search; empty/whitespace query delegates to [`Self::list_books`].
    pub fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        listing::search_books(&self.shared, opts, query)
    }

    pub fn list_books_by_author(
        &self,
        author_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        listing::list_books_with_where(
            &self.shared,
            opts,
            "WHERE b.id IN (SELECT book FROM books_authors_link WHERE author = ?)",
            vec![rusqlite::types::Value::Integer(author_id)],
        )
    }

    /// Defaults sortBy=series_index when opts.sort_by is None (TS F25).
    pub fn list_books_by_series(
        &self,
        series_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let mut options = opts.clone();
        if options.sort_by.is_none() {
            options.sort_by = Some(SortField::SeriesIndex);
        }
        listing::list_books_with_where(
            &self.shared,
            &options,
            "WHERE b.id IN (SELECT book FROM books_series_link WHERE series = ?)",
            vec![rusqlite::types::Value::Integer(series_id)],
        )
    }

    pub fn list_books_by_tag(
        &self,
        tag_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        listing::list_books_with_where(
            &self.shared,
            opts,
            "WHERE b.id IN (SELECT book FROM books_tags_link WHERE tag = ?)",
            vec![rusqlite::types::Value::Integer(tag_id)],
        )
    }

    pub fn list_books_by_format(
        &self,
        format: &str,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        listing::list_books_with_where(
            &self.shared,
            opts,
            "WHERE b.id IN (SELECT book FROM data WHERE format = ?)",
            vec![rusqlite::types::Value::Text(format.to_uppercase())],
        )
    }

    // --- Details / counts --------------------------------------------------

    pub fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, DbError> {
        detail::get_book(&self.shared, id)
    }

    /// Batched details lookup; dedups, caps at 500 ids
    /// (TS `getBooksByIdsOptimized`).
    pub fn get_books_by_ids(&self, ids: &[i64]) -> HashMap<i64, BookWithDetails> {
        detail::get_books_by_ids(&self.shared, ids)
    }

    pub fn get_book_count(&self) -> Result<i64, DbError> {
        detail::get_book_count(&self.shared)
    }

    pub fn get_library_stats(&self) -> Result<LibraryStats, DbError> {
        detail::get_library_stats(&self.shared)
    }

    // --- Catalogs ----------------------------------------------------------

    pub fn list_authors(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        catalog::list_catalog_entries(&self.shared, CatalogKind::Authors, opts)
    }

    pub fn list_series(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        catalog::list_catalog_entries(&self.shared, CatalogKind::Series, opts)
    }

    pub fn list_tags(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        catalog::list_catalog_entries(&self.shared, CatalogKind::Tags, opts)
    }

    pub fn list_formats(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        catalog::list_catalog_entries(&self.shared, CatalogKind::Formats, opts)
    }

    pub fn get_catalog_entry(&self, kind: CatalogKind, id: &CatalogId) -> Option<CatalogEntry> {
        catalog::get_catalog_entry(&self.shared, kind, id)
    }

    /// All tags with book counts, most-popular-first (clamp 1..=5000).
    pub fn list_all_tags(&self, limit: u32) -> Vec<TagSummary> {
        catalog::list_all_tags(&self.shared, limit)
    }

    pub fn list_all_formats(&self) -> Vec<FormatSummary> {
        catalog::list_all_formats(&self.shared)
    }

    /// Title search via FTS5 prefix MATCH (clamp 1..=200).
    pub fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        catalog::search_books_by_title(&self.shared, title, limit)
    }

    pub fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        catalog::search_books_by_author(&self.shared, author, limit)
    }

    pub fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo> {
        catalog::get_author_by_name(&self.shared, name)
    }

    // --- Stream ------------------------------------------------------------

    /// One id-ordered batch for `/api/books/stream` and the CLI stream
    /// (`WHERE b.id > last_id ORDER BY b.id ASC LIMIT batch`, clamped
    /// 1..=5000). Column set matches the TS stream query (no uuid /
    /// last_modified).
    pub fn stream_books_batch(
        &self,
        last_id: i64,
        batch_size: u32,
    ) -> Result<Vec<BookListItem>, DbError> {
        detail::stream_books_batch(&self.shared, last_id, batch_size)
    }

    // --- Paths -------------------------------------------------------------

    /// Live library path from Config.
    pub fn library_path(&self) -> PathBuf {
        self.shared.config.library_path()
    }

    pub fn book_title(&self, id: i64) -> Option<String> {
        detail::book_title(&self.shared, id)
    }

    /// join(library, b.path, "{d.name}.{format.to_lowercase()}") + containment
    /// check.
    pub fn book_format_path(&self, book_id: i64, format: &str) -> Option<PathBuf> {
        let library = self.library_path();
        detail::book_format_path(&self.shared, &library, book_id, format)
    }

    /// join(library, b.path, "cover.jpg") when has_cover + containment check.
    pub fn book_cover_path(&self, book_id: i64) -> Option<PathBuf> {
        let library = self.library_path();
        detail::book_cover_path(&self.shared, &library, book_id)
    }
}

impl Drop for CaliberDb {
    fn drop(&mut self) {
        // Stop the refresh timer thread promptly (it holds only a Weak).
        self.shared.stop_background_threads();
    }
}

/// PUT `/api/config/library` backend: prepare (path validation via Config) →
/// Calibre schema validation (books/authors/data/books_authors_link tables) →
/// apply. Mirrors TS `saveLibraryConfig` including its error strings.
pub fn save_library_config_with_validation(
    config: &Config,
    selection: LibrarySelection,
) -> Result<LibraryConfigStatus, ConfigError> {
    let (library_path, db_name) = config.prepare_library_selection(&selection)?;
    let database_path = library_path.join(&db_name);
    validate_calibre_database(&database_path)?;
    Ok(config.apply_library_selection(&library_path, &db_name))
}

/// `validateCalibreDatabase` port with the TS error strings.
fn validate_calibre_database(database_path: &Path) -> Result<(), ConfigError> {
    let read_tables = |conn: &Connection| -> Result<HashSet<String>, rusqlite::Error> {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let mut rows = stmt.query([])?;
        let mut tables = HashSet::new();
        while let Some(row) = rows.next()? {
            tables.insert(row.get::<_, String>(0)?);
        }
        Ok(tables)
    };
    let outcome = (|| -> Result<HashSet<String>, rusqlite::Error> {
        let conn = Connection::open_with_flags(
            database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        read_tables(&conn)
    })();
    let tables = match outcome {
        Ok(tables) => tables,
        Err(_) => {
            return Err(ConfigError::Library(format!(
                "Could not read the Calibre database: {}",
                database_path.display()
            )))
        }
    };
    let missing: Vec<&str> = ["books", "authors", "data", "books_authors_link"]
        .into_iter()
        .filter(|table| !tables.contains(*table))
        .collect();
    if !missing.is_empty() {
        return Err(ConfigError::Library(format!(
            "This file is not a supported Calibre database; missing {}",
            missing.join(", ")
        )));
    }
    Ok(())
}
