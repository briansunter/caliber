//! Shared server state: config, backend trait objects, the API LRU cache,
//! media-cache semaphores/leases, and single-flight maps.

use crate::backend::{CaliberBackend, UserBackend};
use caliber_common::Config;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

// ---------------------------------------------------------------------------
// API response LRU (port of the TS LRUCache + CachedResponse)
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES: usize = 100;
const MAX_CACHE_BYTES: usize = 50 * 1024 * 1024;
const CACHE_TTL_MS: i64 = 60 * 1000;

struct CachedResponse {
    data: Arc<str>,
    etag: String,
    timestamp: i64,
}

#[derive(Default)]
struct LruInner {
    entries: HashMap<String, CachedResponse>,
    order: VecDeque<String>,
    total_bytes: usize,
}

/// LRU keyed response cache: max 100 entries, max 50MB payload, 60s TTL.
/// `data.len()` counts the UTF-8 bytes of the payload (TS used `string.length`
/// as a byte-ish proxy; payloads are ASCII JSON/XML here).
pub struct ApiCache(Mutex<LruInner>);

impl ApiCache {
    pub fn new() -> ApiCache {
        ApiCache(Mutex::new(LruInner::default()))
    }

    pub fn get(&self, key: &str) -> Option<(Arc<str>, String)> {
        let mut inner = self.0.lock().unwrap();
        // Refresh recency like the TS Map delete+set.
        if let Some(pos) = inner.order.iter().position(|k| k == key) {
            let k = inner.order.remove(pos).unwrap();
            inner.order.push_back(k);
        }
        inner
            .entries
            .get(key)
            .map(|e| (e.data.clone(), e.etag.clone()))
    }

    pub fn set(&self, key: String, data: String, etag: String, timestamp: i64) {
        let incoming = data.len();
        let mut inner = self.0.lock().unwrap();
        if let Some(existing) = inner.entries.remove(key.as_str()) {
            inner.total_bytes -= existing.data.len();
            if let Some(pos) = inner.order.iter().position(|k| k == &key) {
                inner.order.remove(pos);
            }
        }
        while !inner.order.is_empty()
            && (inner.entries.len() >= MAX_CACHE_ENTRIES
                || inner.total_bytes + incoming > MAX_CACHE_BYTES)
        {
            let evict = inner.order.pop_front().unwrap();
            if let Some(evicted) = inner.entries.remove(&evict) {
                inner.total_bytes -= evicted.data.len();
            }
        }
        inner.total_bytes += incoming;
        inner.order.push_back(key.clone());
        inner.entries.insert(
            key,
            CachedResponse {
                data: Arc::from(data),
                etag,
                timestamp,
            },
        );
    }

    /// Entries whose TTL (60s) has expired are treated as absent by the
    /// callers; expose the timestamp so they can decide.
    pub fn get_fresh(&self, key: &str, now: i64) -> Option<(Arc<str>, String)> {
        let mut inner = self.0.lock().unwrap();
        if let Some(pos) = inner.order.iter().position(|k| k == key) {
            let k = inner.order.remove(pos).unwrap();
            inner.order.push_back(k);
        }
        let entry = inner.entries.get(key)?;
        if now - entry.timestamp >= CACHE_TTL_MS {
            return None;
        }
        Some((entry.data.clone(), entry.etag.clone()))
    }

    pub fn clear(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.entries.clear();
        inner.order.clear();
        inner.total_bytes = 0;
    }
}

impl Default for ApiCache {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Single-flight
// ---------------------------------------------------------------------------

/// Keyed single-flight: concurrent callers with the same key await one shared
/// task instead of racing (port of `runSingleFlight`).
#[derive(Default)]
pub struct SingleFlight {
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl SingleFlight {
    /// Keyed single-flight: concurrent callers with the same key await one
    /// shared task instead of racing (port of `runSingleFlight`). The task
    /// must own its captures ('static) — clone what you need inside.
    pub async fn run<T, F, Fut>(&self, key: String, task: F) -> T
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let lock = {
            let mut map = self.inflight.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        task().await
    }
}

// ---------------------------------------------------------------------------
// Refcounted on-disk leases (epub/page caches)
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct LeaseMap(Arc<Mutex<HashMap<PathBuf, usize>>>);

impl LeaseMap {
    pub fn acquire(&self, path: &std::path::Path) -> LeaseGuard {
        let mut map = self.0.lock().unwrap();
        *map.entry(path.to_path_buf()).or_insert(0) += 1;
        LeaseGuard {
            map: Arc::clone(&self.0),
            path: path.to_path_buf(),
            released: false,
        }
    }

    pub fn count(&self, path: &std::path::Path) -> usize {
        *self.0.lock().unwrap().get(path).unwrap_or(&0)
    }

    fn release(map: &Mutex<HashMap<PathBuf, usize>>, path: &std::path::Path) {
        let mut map = map.lock().unwrap();
        match map.get_mut(path) {
            Some(count) if *count > 1 => *count -= 1,
            _ => {
                map.remove(path);
            }
        }
    }
}

pub struct LeaseGuard {
    map: Arc<Mutex<HashMap<PathBuf, usize>>>,
    path: PathBuf,
    released: bool,
}

impl LeaseGuard {
    pub fn release(mut self) {
        Self::release_inner(&mut self);
    }

    fn release_inner(&mut self) {
        if !self.released {
            self.released = true;
            LeaseMap::release(&self.map, &self.path);
        }
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        self.release_inner();
    }
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

pub struct AppState {
    pub config: Config,
    pub db: Arc<dyn CaliberBackend + Send + Sync>,
    pub users: Arc<dyn UserBackend + Send + Sync>,
    pub cache: ApiCache,
    /// Library snapshot readiness (false until init/refresh succeeds).
    pub ready: AtomicBool,
    pub static_dir: PathBuf,
    /// Serializes first-run setup requests.
    pub setup_mutex: tokio::sync::Mutex<()>,
    /// Max 2 concurrent thumbnail resizes.
    pub thumb_limiter: Semaphore,
    /// Max 2 concurrent EPUB extractions.
    pub epub_extract: Semaphore,
    /// Max 3 concurrent PDF page renders.
    pub pdf_render: Semaphore,
    /// Max 2 concurrent page-cache archive extracts.
    pub archive_extract: Semaphore,
    pub epub_singleflight: SingleFlight,
    pub page_singleflight: SingleFlight,
    pub epub_leases: LeaseMap,
    pub page_leases: LeaseMap,
    pub thumb_degraded_logged: AtomicBool,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(
        config: Config,
        db: Arc<dyn CaliberBackend + Send + Sync>,
        users: Arc<dyn UserBackend + Send + Sync>,
        static_dir: PathBuf,
    ) -> SharedState {
        let ready = AtomicBool::new(false);
        ready.store(db.is_ready(), std::sync::atomic::Ordering::SeqCst);
        Arc::new(AppState {
            config,
            db,
            users,
            cache: ApiCache::new(),
            ready,
            static_dir,
            setup_mutex: tokio::sync::Mutex::new(()),
            thumb_limiter: Semaphore::new(2),
            epub_extract: Semaphore::new(2),
            pdf_render: Semaphore::new(3),
            archive_extract: Semaphore::new(2),
            epub_singleflight: SingleFlight::default(),
            page_singleflight: SingleFlight::default(),
            epub_leases: LeaseMap::default(),
            page_leases: LeaseMap::default(),
            thumb_degraded_logged: AtomicBool::new(false),
        })
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Registers the DB refresh callback: on every refresh, clear the API
    /// cache and mark the library ready (mirrors TS `onDbRefresh`).
    pub fn wire_refresh_callback(self: &SharedState) {
        let weak = Arc::downgrade(self);
        self.db.register_refresh_callback(Box::new(move || {
            if let Some(state) = weak.upgrade() {
                state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
                state.cache.clear();
            }
        }));
    }
}
