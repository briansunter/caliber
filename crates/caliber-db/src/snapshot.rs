//! Snapshot generations, connection pool, cross-process publish lock, and the
//! periodic refresh thread — the port of the module-level engine in
//! `src/lib/calibre-optimized.ts` (`copyDbToWritable` / `ensureWritableDb` /
//! `swapDatabaseFile` / pool + leases).
//!
//! Where the TypeScript engine relied on the single-threaded event loop for
//! exclusion, this port makes the invariants explicit:
//! - `gate` serializes snapshot publishes against pool checkouts and lease
//!   acquisition;
//! - `inner` (guarded by its mutex + condvar) carries the generation pointer,
//!   lease refcounts, checkout refcount, and refresh-pending flag;
//! - a refresh is deferred while any checkout or lease is outstanding and is
//!   retriggered by the last release (RAII guards).

use crate::error::DbError;
use crate::setup::setup_snapshot_db;
use crate::util::normalize_path;
use caliber_common::signature::{database_signature, is_same_signature, SourceSignature};
use caliber_common::Config;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

pub(crate) const MAX_POOL_SIZE: usize = 5;

/// Status surface for the config/health endpoints.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    pub generation: u64,
    pub revision: u64,
    pub stale: bool,
    pub refreshing: bool,
    pub failed: Option<String>,
}

pub(crate) struct ActiveGeneration {
    pub id: u64,
    pub path: PathBuf,
    pub revision: u64,
}

pub(crate) struct Inner {
    pub generation_counter: u64,
    pub active: ActiveGeneration,
    pub leases: HashMap<u64, u64>,
    pub refreshing: bool,
    pub failed: Option<String>,
    pub refresh_pending: bool,
    pub checkouts: u64,
    pub timer_started: bool,
}

pub(crate) struct Shared {
    pub config: Config,
    pub inner: Mutex<Inner>,
    pub inner_cv: Condvar,
    pub pool: Mutex<Vec<Connection>>,
    /// Serializes snapshot publishes against pool checkouts and lease
    /// acquisition (implicit in the TS single-threaded event loop).
    pub gate: Mutex<()>,
    pub callbacks: Mutex<Vec<Arc<Box<dyn Fn() + Send + Sync>>>>,
    pub ready: AtomicBool,
    pub stop: AtomicBool,
    pub timer_gate: Mutex<()>,
    pub timer_cv: Condvar,
}

fn total_leases(inner: &Inner) -> u64 {
    inner.leases.values().sum()
}

/// Clonable RAII pin on the current snapshot generation. While any lease (or
/// pool checkout) is held, a refresh is deferred; the last release retriggers
/// it.
pub struct SnapshotLease {
    pub(crate) shared: Arc<Shared>,
    pub(crate) generation: u64,
}

impl Clone for SnapshotLease {
    fn clone(&self) -> Self {
        let mut inner = self.shared.inner.lock().unwrap();
        *inner.leases.entry(self.generation).or_insert(0) += 1;
        SnapshotLease {
            shared: self.shared.clone(),
            generation: self.generation,
        }
    }
}

impl Drop for SnapshotLease {
    fn drop(&mut self) {
        {
            let mut inner = self.shared.inner.lock().unwrap();
            let remaining = inner
                .leases
                .get(&self.generation)
                .copied()
                .unwrap_or(0)
                .saturating_sub(1);
            if remaining == 0 {
                inner.leases.remove(&self.generation);
            } else {
                inner.leases.insert(self.generation, remaining);
            }
        }
        self.shared.maybe_trigger_deferred();
    }
}

/// A checked-out pool connection. Dropping the guard returns the connection to
/// the pool (bounded at [`MAX_POOL_SIZE`]) and, when it was the last checkout,
/// runs a deferred refresh.
pub(crate) struct Checkout {
    shared: Arc<Shared>,
    conn: Option<Connection>,
}

impl std::ops::Deref for Checkout {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("checkout connection present")
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            let mut pool = self.shared.pool.lock().unwrap();
            if pool.len() < MAX_POOL_SIZE {
                pool.push(conn);
            }
        }
        {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.checkouts = inner.checkouts.saturating_sub(1);
            self.shared.inner_cv.notify_one();
        }
        self.shared.maybe_trigger_deferred();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotMetadata {
    pub source_path: String,
    pub signature: SourceSignature,
}

impl Shared {
    pub(crate) fn config_dir(&self) -> PathBuf {
        self.config.resolved().config_dir
    }

    pub(crate) fn writable_db_path(&self) -> PathBuf {
        self.config_dir().join("metadata.db")
    }

    pub(crate) fn sidecar_path(&self) -> PathBuf {
        self.config_dir().join("metadata.source.json")
    }

    fn lock_dir(&self) -> PathBuf {
        self.config_dir().join("snapshot.lock")
    }

    pub(crate) fn source_db_path(&self) -> PathBuf {
        self.config.database_path()
    }

    pub(crate) fn read_snapshot_metadata(&self) -> Option<SnapshotMetadata> {
        let raw = fs::read_to_string(self.sidecar_path()).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
        if !parsed.is_object() {
            return None;
        }
        serde_json::from_value(parsed).ok()
    }

    /// Source freshness: has the source db (or its WAL sidecars) changed since
    /// the snapshot was published? A missing sidecar or path change counts as
    /// stale.
    pub(crate) fn source_changed(&self) -> bool {
        let db_path = self.source_db_path();
        if !db_path.exists() {
            return false; // TS skips the tick when the stat fails
        }
        let signature = database_signature(&db_path);
        match self.read_snapshot_metadata() {
            None => true,
            Some(meta) => {
                meta.source_path != normalize_path(&db_path).to_string_lossy()
                    || !is_same_signature(Some(&meta.signature), &signature)
            }
        }
    }

    // --- Cross-process lock (exclusive mkdir) -----------------------------

    fn acquire_snapshot_lock(&self) -> Result<bool, String> {
        match fs::create_dir(self.lock_dir()) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    fn release_snapshot_lock(&self) {
        let _ = fs::remove_dir(self.lock_dir());
    }

    // --- Connection pool ---------------------------------------------------

    pub(crate) fn checkout(self: &Arc<Self>) -> Result<Checkout, DbError> {
        let _gate = self.gate.lock().unwrap();
        {
            let mut inner = self.inner.lock().unwrap();
            while inner.checkouts >= MAX_POOL_SIZE as u64 {
                inner = self.inner_cv.wait(inner).unwrap();
            }
        }
        let path = self.writable_db_path();
        if !path.exists() {
            return Err(DbError::NotReady(format!(
                "Library snapshot is not ready: {}",
                path.display()
            )));
        }
        let pooled = self.pool.lock().unwrap().pop();
        let conn = match pooled {
            Some(conn) => conn,
            None => open_pool_connection(&path)?,
        };
        let mut inner = self.inner.lock().unwrap();
        inner.checkouts += 1;
        Ok(Checkout {
            shared: self.clone(),
            conn: Some(conn),
        })
    }

    fn close_pool(&self) -> Result<(), String> {
        self.pool.lock().unwrap().clear();
        Ok(())
    }

    pub(crate) fn acquire_snapshot_lease(self: &Arc<Self>) -> SnapshotLease {
        let _gate = self.gate.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        let generation = inner.active.id;
        *inner.leases.entry(generation).or_insert(0) += 1;
        SnapshotLease {
            shared: self.clone(),
            generation,
        }
    }

    // --- Refresh orchestration ---------------------------------------------

    /// `runRefresh` + `reconfigureLibraryDatabase`: defer while checkouts or
    /// leases are held, otherwise publish a new generation.
    pub(crate) fn run_refresh_result(self: &Arc<Self>) -> Result<(), String> {
        let deferred = {
            let mut inner = self.inner.lock().unwrap();
            if inner.checkouts > 0 || total_leases(&inner) > 0 {
                inner.refresh_pending = true;
                true
            } else {
                false
            }
        };
        if deferred {
            return Ok(());
        }
        self.swap_database_file()
    }

    /// Last checkout/lease release retrigger for a deferred refresh.
    pub(crate) fn maybe_trigger_deferred(self: &Arc<Self>) {
        let should_run = {
            let mut inner = self.inner.lock().unwrap();
            if inner.checkouts == 0 && total_leases(&inner) == 0 && inner.refresh_pending {
                inner.refresh_pending = false;
                true
            } else {
                false
            }
        };
        if !should_run {
            return;
        }
        if let Err(error) = self.run_refresh_result() {
            eprintln!("🔄 Deferred database refresh failed: {error}");
        }
    }

    fn swap_database_file(self: &Arc<Self>) -> Result<(), String> {
        let _gate = self.gate.lock().unwrap();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.checkouts > 0 || total_leases(&inner) > 0 {
                inner.refresh_pending = true;
                return Ok(());
            }
        }
        match self.acquire_snapshot_lock() {
            Ok(true) => {}
            Ok(false) => {
                // Another process is publishing; mark stale and retry on the
                // next tick.
                self.inner.lock().unwrap().refresh_pending = true;
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.refreshing = true;
            inner.failed = None;
        }
        // Indexes/FTS/projection are built in the tmp generation inside
        // copy_db_to_writable, before the generation is published — the pool
        // is closed first so no checkout can observe the swap mid-publish.
        let result = self
            .close_pool()
            .and_then(|()| self.copy_db_to_writable())
            .map(|()| {
                self.notify_db_refreshed();
                self.ready.store(true, Ordering::SeqCst);
            });
        {
            let mut inner = self.inner.lock().unwrap();
            if let Err(message) = &result {
                inner.failed = Some(message.clone());
            }
            inner.refreshing = false;
        }
        self.release_snapshot_lock();
        result
    }

    /// `ensureWritableDb`: create or refresh the published snapshot at startup.
    fn ensure_writable_db(self: &Arc<Self>) -> Result<(), String> {
        let writable = self.writable_db_path();
        let result = if !writable.exists() {
            let _gate = self.gate.lock().unwrap();
            if !self.acquire_snapshot_lock()? {
                Err(
                    "Another Caliber process is building the library snapshot; retry shortly"
                        .to_string(),
                )
            } else {
                let outcome = self.close_pool().and_then(|()| self.copy_db_to_writable());
                self.release_snapshot_lock();
                outcome
            }
        } else if self.source_changed() {
            // Another process may be publishing; let the periodic tick retry
            // rather than contending on the lock here.
            let _gate = self.gate.lock().unwrap();
            if !self.acquire_snapshot_lock()? {
                Ok(())
            } else {
                let outcome = self.close_pool().and_then(|()| self.copy_db_to_writable());
                self.release_snapshot_lock();
                outcome
            }
        } else {
            Ok(())
        };
        // The TS engine only records `failed` on the swap path; recording it
        // here too means a faulted first publish (CALIBER_SNAPSHOT_FAULT) is
        // visible in SnapshotStatus (contract requirement).
        if let Err(message) = &result {
            self.inner.lock().unwrap().failed = Some(message.clone());
        }
        result
    }

    // --- Publish -----------------------------------------------------------

    fn copy_db_to_writable(self: &Arc<Self>) -> Result<(), String> {
        let db_path = self.source_db_path();
        let writable = self.writable_db_path();
        let work_dir = self.config_dir();
        if normalize_path(&db_path) == normalize_path(&writable) {
            return Err(
                "Calibre source database must be outside Caliber's cache directory".to_string(),
            );
        }
        if !db_path.exists() {
            let db_name = self.config.resolved().db_name;
            return Err(format!(
                "Calibre database not found at {}. Set CALIBRE_LIBRARY_PATH (or CALIBRE_LIBRARY_PATH) to a library containing {}.",
                db_path.display(),
                db_name
            ));
        }
        fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

        // Build the new generation in a tmp file: serialize a consistent
        // snapshot of the source, then build indexes/FTS/projection IN THE
        // TMP GENERATION before publishing, so readers only ever see a
        // complete context at the published path.
        let next_id = {
            let inner = self.inner.lock().unwrap();
            inner.generation_counter + 1
        };
        let temporary_path = work_dir.join(format!(
            "metadata.db.gen-{next_id}.tmp-{}",
            std::process::id()
        ));
        let _ = fs::remove_file(&temporary_path); // stale remnant of a crashed run

        {
            // SQLite can have committed changes in the source WAL.
            // VACUUM INTO asks SQLite for a consistent serialized copy — the
            // equivalent of Bun's `db.serialize()` — without touching the
            // read-only source.
            let source = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| {
                format!(
                    "Could not open Calibre database at {}: {e}",
                    db_path.display()
                )
            })?;
            let tables: HashSet<String> = {
                let mut stmt = source
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                let mut set = HashSet::new();
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    set.insert(row.get::<_, String>(0).map_err(|e| e.to_string())?);
                }
                set
            };
            let missing: Vec<&str> = ["books", "authors", "data", "books_authors_link"]
                .into_iter()
                .filter(|table| !tables.contains(*table))
                .collect();
            if !missing.is_empty() {
                return Err(format!(
                    "Unsupported Calibre database; missing {}",
                    missing.join(", ")
                ));
            }
            source
                .execute(
                    "VACUUM INTO ?1",
                    [temporary_path.to_string_lossy().to_string()],
                )
                .map_err(|e| format!("Snapshot build failed: {e}"))?;
        }
        // Durability: fsync the tmp generation so its bytes are on stable
        // storage before it is ever renamed into place (best-effort).
        if let Ok(file) = fs::File::open(&temporary_path) {
            let _ = file.sync_all();
        }

        let build = (|| -> Result<(), String> {
            let tmp_db = Connection::open(&temporary_path).map_err(|e| e.to_string())?;
            let _ = tmp_db.execute_batch("PRAGMA journal_mode = DELETE;");
            setup_snapshot_db(&tmp_db, &db_path)?;
            Ok(())
        })();

        // Fault-injection hook for tests: CALIBER_SNAPSHOT_FAULT=1 aborts here
        // — after the tmp generation is fully built, before any rename — so
        // the crash window is exercisable. The stale tmp file is removed by
        // the cleanup below; the published generation is untouched.
        if build.is_ok() && std::env::var("CALIBER_SNAPSHOT_FAULT").ok().as_deref() == Some("1") {
            let _ = fs::remove_file(&temporary_path);
            return Err("CALIBER_SNAPSHOT_FAULT: injected failure mid-publish".to_string());
        }
        build?;

        let publish = (|| -> Result<(), String> {
            for suffix in ["-wal", "-shm"] {
                let path = work_dir.join(format!("metadata.db{suffix}"));
                if path.exists() {
                    let _ = fs::remove_file(&path);
                }
            }
            // Retain the previous generation until leases drain: rename it
            // aside instead of overwriting it, then unlink the superseded
            // file only when no pool checkouts or generation leases can
            // still read it.
            let previous_id = self.inner.lock().unwrap().active.id;
            if writable.exists() {
                let previous = work_dir.join(format!("metadata.db.prev-{previous_id}"));
                fs::rename(&writable, &previous).map_err(|e| e.to_string())?;
            }
            if let Err(e) = fs::rename(&temporary_path, &writable) {
                let fallback = matches!(
                    e.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
                );
                if !fallback {
                    return Err(e.to_string());
                }
                let _ = fs::remove_file(&writable);
                fs::rename(&temporary_path, &writable).map_err(|e| e.to_string())?;
            }
            // Durability: fsync the published file and the directory entry so
            // a crash right after publish cannot leave a zero-length
            // generation visible (best-effort; macOS has no dir fsync).
            if let Ok(file) = fs::File::open(&writable) {
                let _ = file.sync_all();
            }
            if let Ok(dir) = fs::File::open(&work_dir) {
                let _ = dir.sync_all();
            }
            Ok(())
        })();
        if publish.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        publish?;

        let signature = database_signature(&db_path);
        let metadata = SnapshotMetadata {
            source_path: normalize_path(&db_path).to_string_lossy().to_string(),
            signature,
        };
        let body = format!(
            "{}\n",
            serde_json::to_string(&metadata).expect("sidecar is always serializable")
        );
        fs::write(self.sidecar_path(), body).map_err(|e| e.to_string())?;

        // Publish: bump the generation pointer only after the rename
        // succeeded.
        {
            let mut inner = self.inner.lock().unwrap();
            let revision = inner.active.revision + 1;
            inner.generation_counter = next_id;
            inner.active = ActiveGeneration {
                id: next_id,
                path: writable,
                revision,
            };
        }
        self.prune_old_generations();
        eprintln!(
            "📋 Copied database snapshot to {} (generation {next_id})",
            self.writable_db_path().display()
        );
        Ok(())
    }

    /// Unlink superseded generation files, but never while pool checkouts or
    /// generation leases might still read them; survivors are pruned on the
    /// next publish.
    fn prune_old_generations(&self) {
        {
            let inner = self.inner.lock().unwrap();
            if inner.checkouts > 0 || total_leases(&inner) > 0 {
                return;
            }
        }
        let Ok(entries) = fs::read_dir(self.config_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("metadata.db.prev-") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub(crate) fn notify_db_refreshed(&self) {
        let callbacks: Vec<Arc<Box<dyn Fn() + Send + Sync>>> =
            self.callbacks.lock().unwrap().clone();
        for callback in callbacks {
            let _ = callback();
        }
    }

    // --- initFTS -----------------------------------------------------------

    pub(crate) fn init(self: &Arc<Self>) -> bool {
        let result = (|| -> Result<(), String> {
            self.ensure_writable_db()?;

            // runFtsSetup: verify the published snapshot (idempotent).
            {
                let conn = self.checkout().map_err(|e| e.to_string())?;
                let db_path = self.source_db_path();
                setup_snapshot_db(&conn, &db_path)?;
            }

            // Warm up: run initial queries to populate mmap/cache.
            eprintln!("🔥 Warming up database...");
            {
                let conn = self.checkout().map_err(|e| e.to_string())?;
                conn.query_row("SELECT COUNT(*) FROM books", [], |_| Ok(()))
                    .map_err(|e| e.to_string())?;
                conn.query_row(
                    "SELECT b.id FROM books b
                     LEFT JOIN books_authors_link bal ON b.id = bal.book
                     LEFT JOIN books_tags_link btl ON b.id = btl.book
                     LEFT JOIN data d ON b.id = d.book
                     ORDER BY b.sort ASC LIMIT 1",
                    [],
                    |_| Ok(()),
                )
                .map_err(|e| e.to_string())?;
            }
            eprintln!("🔥 Database warm");
            Ok(())
        })();
        match &result {
            Ok(()) => {
                self.ready.store(true, Ordering::SeqCst);
                true
            }
            Err(message) => {
                eprintln!("📚 Library is not ready: {message}");
                false
            }
        }
    }

    pub(crate) fn start_refresh_timer(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.timer_started {
                return;
            }
            inner.timer_started = true;
        }
        let interval_ms = self.config.resolved().db_refresh_interval_ms.max(1);
        let weak: Weak<Shared> = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("caliber-db-refresh".to_string())
            .spawn(move || refresh_timer_loop(weak, Duration::from_millis(interval_ms)));
        if spawned.is_err() {
            self.inner.lock().unwrap().timer_started = false;
        }
    }

    pub(crate) fn stop_background_threads(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _guard = self.timer_gate.lock().unwrap();
        self.timer_cv.notify_all();
    }
}

/// Low-frequency freshness check: compare the source signature to the sidecar
/// and refresh when they drift. Exits when the engine is dropped or stopped.
fn refresh_timer_loop(weak: Weak<Shared>, interval: Duration) {
    let mut deadline = Instant::now() + interval;
    loop {
        let now = Instant::now();
        if now < deadline {
            let Some(shared) = weak.upgrade() else { return };
            if shared.stop.load(Ordering::SeqCst) {
                return;
            }
            let slice = (deadline - now).min(Duration::from_millis(250));
            let guard = shared.timer_gate.lock().unwrap();
            let _ = shared.timer_cv.wait_timeout(guard, slice);
            continue;
        }
        deadline = Instant::now() + interval;
        let Some(shared) = weak.upgrade() else { return };
        if shared.source_changed() {
            eprintln!("🔄 Source DB changed — refreshing...");
            if let Err(error) = shared.run_refresh_result() {
                eprintln!("🔄 Database refresh failed: {error}");
            }
        }
    }
}

fn open_pool_connection(path: &std::path::Path) -> Result<Connection, DbError> {
    let conn = Connection::open(path).map_err(DbError::from)?;
    // Best-effort pragmas, mirroring getDb() (each ignored on failure).
    let _ = conn.execute_batch("PRAGMA cache_size = -64000;");
    let _ = conn.execute_batch("PRAGMA temp_store = memory;");
    let _ = conn.execute_batch("PRAGMA mmap_size = 268435456;");
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    Ok(conn)
}
