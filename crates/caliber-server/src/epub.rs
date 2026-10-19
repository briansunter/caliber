//! EPUB entry cache — port of src/lib/epub-cache.ts. Entries are extracted
//! on demand from the source zip into `<config>/epub-cache/{libHash}-{bookId}/`
//! with signature metas, single-flight, caps, and a 1GB quota sweep.

use crate::helpers::js_decode_uri_component;
use crate::state::SharedState;
use caliber_common::signature::{is_same_signature, source_signature, SourceSignature};
use caliber_common::wyhash::library_hash36;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const CACHE_META_FILE: &str = ".caliber-epub-cache.json";
const MAX_EPUB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EPUB_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EPUB_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

pub struct EpubCacheError {
    pub status: u16,
    pub message: String,
    pub code: String,
}

impl EpubCacheError {
    fn new(status: u16, message: &str, code: &str) -> Self {
        EpubCacheError {
            status,
            message: message.to_string(),
            code: code.to_string(),
        }
    }
}

/// On-disk meta: the source signature plus the library hash that owns the
/// scoped dir (TS `EpubCacheMeta extends SourceSignature`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EpubCacheMeta {
    #[serde(flatten)]
    signature: SourceSignature,
    #[serde(rename = "libHash", skip_serializing_if = "Option::is_none")]
    lib_hash: Option<String>,
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|md| md.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size_bytes(&p);
        } else if let Ok(md) = entry.metadata() {
            total += md.len();
        }
    }
    total
}

fn epub_cache_size_bytes(cache_root: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(cache_root) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size_bytes(&p);
        } else if let Ok(md) = entry.metadata() {
            total += md.len();
        }
    }
    total
}

/// 1GB quota sweep: oldest dirs first, leased dirs kept.
fn sweep_epub_cache_quota(state: &SharedState, cache_root: &Path) {
    let _ = std::fs::create_dir_all(cache_root);
    if epub_cache_size_bytes(cache_root) <= MAX_EPUB_CACHE_BYTES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(cache_root) else {
        return;
    };
    let mut dirs: Vec<(PathBuf, f64)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| {
            let mtime = mtime_ms(&p);
            (p, mtime)
        })
        .collect();
    dirs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    for (dir, _) in dirs {
        if epub_cache_size_bytes(cache_root) <= MAX_EPUB_CACHE_BYTES {
            break;
        }
        if state.epub_leases.count(&dir) > 0 {
            continue;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn read_cache_meta(cache_dir: &Path) -> Option<EpubCacheMeta> {
    let raw = std::fs::read_to_string(cache_dir.join(CACHE_META_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// TS `safeCachePath`: normalize, reject traversal, ensure containment.
fn safe_cache_path(cache_dir: &Path, entry_path: &str) -> Option<PathBuf> {
    // normalize(): "." segments collapse; backslashes treated as separators.
    let mut parts: Vec<String> = Vec::new();
    for seg in entry_path.replace('\\', "/").split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                // leading ".." runs are stripped by the TS regex; interior
                // ones make the path unsafe
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    let normalized = parts.join("/");
    if normalized.is_empty() || normalized.split('/').any(|p| p == "..") {
        return None;
    }
    let target = cache_dir.join(&normalized);
    // Containment: every remaining component must be under cache_dir.
    if !target.starts_with(cache_dir) {
        return None;
    }
    Some(target)
}

struct EnsureResult {
    cache_dir: PathBuf,
    epub_path: PathBuf,
    signature: SourceSignature,
    library: String,
    lib_hash: String,
}

async fn ensure_epub_cache(
    state: &SharedState,
    book_id: i64,
) -> Result<Option<EnsureResult>, EpubCacheError> {
    // Capture the coherent catalog context at entry (coherence rule).
    let library = {
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || db.library_path())
            .await
            .map_err(|_| EpubCacheError::new(500, "Failed to serve EPUB entry", "internal"))?
            .to_string_lossy()
            .into_owned()
    };
    let lib_hash = library_hash36(&library);
    let epub_path = {
        let db = state.db.clone();
        let lformat = "EPUB".to_string();
        tokio::task::spawn_blocking(move || db.book_format_path(book_id, &lformat))
            .await
            .map_err(|_| EpubCacheError::new(500, "Failed to serve EPUB entry", "internal"))?
    };
    let Some(epub_path) = epub_path else {
        return Ok(None);
    };
    if !epub_path.is_file() {
        return Ok(None);
    }

    let cache_root = state.config.resolved().config_dir.join("epub-cache");
    let cache_dir = cache_root.join(format!("{lib_hash}-{book_id}"));
    let legacy_dir = cache_root.join(book_id.to_string());

    // Clones for the singleflight task (which must own its captures).
    let cache_dir_for_result = cache_dir.clone();
    let library_for_result = library.clone();
    let lib_hash_for_result = lib_hash.clone();
    let epub_path_for_sig = epub_path.clone();

    let key = format!("{library}::epub:{book_id}");
    let sf_state = state.clone();
    sf_state
        .epub_singleflight
        .run(key, move || async move {
            let inner = move || -> Result<(), EpubCacheError> {
                let current = source_signature(&epub_path).map_err(|_| {
                    EpubCacheError::new(500, "Failed to serve EPUB entry", "internal")
                })?;
                // S5: legacy unscoped dirs are disposable — always drop.
                if legacy_dir.exists() {
                    let _ = std::fs::remove_dir_all(&legacy_dir);
                }
                let cached = read_cache_meta(&cache_dir);
                let matches = is_same_signature(cached.as_ref().map(|m| &m.signature), &current)
                    && cached.as_ref().and_then(|m| m.lib_hash.clone()) == Some(lib_hash.clone());
                if !matches {
                    let _ = std::fs::remove_dir_all(&cache_dir);
                    std::fs::create_dir_all(&cache_dir).map_err(|_| {
                        EpubCacheError::new(500, "Failed to serve EPUB entry", "internal")
                    })?;
                    let meta = EpubCacheMeta {
                        signature: current,
                        lib_hash: Some(lib_hash.clone()),
                    };
                    let body = format!("{}\n", serde_json::to_string(&meta).unwrap_or_default());
                    let _ = std::fs::write(cache_dir.join(CACHE_META_FILE), body);
                } else {
                    let _ = std::fs::create_dir_all(&cache_dir);
                }
                Ok(())
            };
            tokio::task::spawn_blocking(inner).await.map_err(|_| {
                EpubCacheError::new(500, "Failed to serve EPUB entry", "internal")
            })??;
            Ok::<(), EpubCacheError>(())
        })
        .await?;

    let signature = source_signature(&epub_path_for_sig)
        .map_err(|_| EpubCacheError::new(500, "Failed to serve EPUB entry", "internal"))?;

    Ok(Some(EnsureResult {
        cache_dir: cache_dir_for_result,
        epub_path: epub_path_for_sig,
        signature,
        library: library_for_result,
        lib_hash: lib_hash_for_result,
    }))
}

/// Port of `getEpubEntryPath`. Returns the extracted entry path, `None` when
/// the entry does not exist (route → 404), or an error for cap/zip issues.
pub async fn get_epub_entry_path(
    state: &SharedState,
    book_id: i64,
    entry_path: &str,
) -> Result<Option<PathBuf>, EpubCacheError> {
    let decoded = js_decode_uri_component(entry_path)
        .map_err(|_| EpubCacheError::new(400, "Invalid EPUB entry path", "invalid_path"))?;

    let Some(cache) = ensure_epub_cache(state, book_id).await? else {
        return Ok(None);
    };

    let Some(target) = safe_cache_path(&cache.cache_dir, &decoded) else {
        return Ok(None);
    };
    if target.is_file() {
        return Ok(Some(target));
    }

    let revision = state.db.snapshot_revision();
    let singleflight_key = format!(
        "{}|{}|{}|{}|{}:{}",
        cache.library,
        0,
        revision,
        "extractEpubEntry",
        cache.epub_path.display(),
        decoded
    );

    let lease = state.epub_leases.acquire(&cache.cache_dir);
    let state = state.clone();
    let sf_state = state.clone();
    let result = sf_state
        .epub_singleflight
        .run(singleflight_key, move || async move {
            let permit = state
                .epub_extract
                .acquire()
                .await
                .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
            let inner_state = state.clone();
            let cache_clone = EnsureResultClone::from(&cache);
            let decoded_inner = decoded.clone();
            let target_inner = target.clone();
            let res = tokio::task::spawn_blocking(move || {
                extract_entry(&inner_state, &cache_clone, &decoded_inner, &target_inner)
            })
            .await
            .unwrap_or_else(|err| {
                eprintln!("[epub] extract panicked: {err}");
                Err(EpubCacheError::new(
                    500,
                    "Failed to serve EPUB entry",
                    "internal",
                ))
            });
            drop(permit);
            res
        })
        .await;
    lease.release();
    result
}

/// Clonable view over the ensure result for the blocking closure.
#[derive(Clone)]
struct EnsureResultClone {
    cache_dir: PathBuf,
    epub_path: PathBuf,
    signature: SourceSignature,
    lib_hash: String,
}

impl From<&EnsureResult> for EnsureResultClone {
    fn from(value: &EnsureResult) -> Self {
        EnsureResultClone {
            cache_dir: value.cache_dir.clone(),
            epub_path: value.epub_path.clone(),
            signature: value.signature,
            lib_hash: value.lib_hash.clone(),
        }
    }
}

fn extract_entry(
    state: &SharedState,
    cache: &EnsureResultClone,
    decoded: &str,
    target: &Path,
) -> Result<Option<PathBuf>, EpubCacheError> {
    // Recheck after acquiring the singleflight slot.
    if target.is_file() {
        return Ok(Some(target.to_path_buf()));
    }
    // Never publish entries for a stale generation.
    let fresh = source_signature(&cache.epub_path)
        .map_err(|_| EpubCacheError::new(500, "Failed to serve EPUB entry", "internal"))?;
    if !is_same_signature(Some(&fresh), &cache.signature) {
        return Ok(None);
    }

    if target.is_file() {
        return Ok(Some(target.to_path_buf()));
    }
    let epub_size = std::fs::metadata(&cache.epub_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if epub_size > MAX_EPUB_BYTES {
        return Err(EpubCacheError::new(
            413,
            "EPUB file is too large",
            "epub_too_large",
        ));
    }
    let file = std::fs::File::open(&cache.epub_path)
        .map_err(|_| EpubCacheError::new(422, "Invalid EPUB archive", "invalid_epub"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| EpubCacheError::new(422, "Invalid EPUB archive", "invalid_epub"))?;
    let mut entry = match zip.by_name(decoded) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    if entry.is_dir() {
        return Ok(None);
    }
    if entry.size() > MAX_EPUB_ENTRY_BYTES {
        return Err(EpubCacheError::new(
            413,
            "EPUB resource is too large",
            "entry_too_large",
        ));
    }
    let mut data = Vec::new();
    if entry.read_to_end(&mut data).is_err() {
        return Err(EpubCacheError::new(
            422,
            "Invalid EPUB archive",
            "invalid_epub",
        ));
    }
    if data.len() as u64 > MAX_EPUB_ENTRY_BYTES {
        return Err(EpubCacheError::new(
            413,
            "EPUB resource is too large",
            "entry_too_large",
        ));
    }
    drop(entry);

    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = target.with_file_name(format!(
        "{}.tmp-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("entry"),
        std::process::id()
    ));
    if std::fs::write(&tmp, &data).is_err() {
        return Err(EpubCacheError::new(
            500,
            "Failed to serve EPUB entry",
            "internal",
        ));
    }
    // Recheck generation before publish.
    let before_publish = source_signature(&cache.epub_path).ok();
    if !before_publish
        .map(|sig| is_same_signature(Some(&sig), &cache.signature))
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&tmp);
        return Ok(None);
    }
    if std::fs::rename(&tmp, target).is_err() {
        let _ = std::fs::write(target, &data);
        let _ = std::fs::remove_file(&tmp);
    }
    // Refresh the meta when a racing reset dropped it.
    let existing = read_cache_meta(&cache.cache_dir);
    let needs_refresh =
        !is_same_signature(existing.as_ref().map(|m| &m.signature), &cache.signature)
            || existing.and_then(|m| m.lib_hash) != Some(cache.lib_hash.clone());
    if needs_refresh {
        let meta = EpubCacheMeta {
            signature: cache.signature,
            lib_hash: Some(cache.lib_hash.clone()),
        };
        let body = format!("{}\n", serde_json::to_string(&meta).unwrap_or_default());
        let _ = std::fs::write(cache.cache_dir.join(CACHE_META_FILE), body);
    }
    let cache_root = cache
        .cache_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    sweep_epub_cache_quota(state, &cache_root);

    Ok(Some(target.to_path_buf()))
}
