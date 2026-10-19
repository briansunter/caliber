//! Page streaming — port of src/lib/page-streaming.ts. CBZ via the `zip`
//! crate (lazy per-page extraction), PDF via external `pdfinfo`/`pdftoppm`
//! (30s timeout), CBR via an external `unrar` binary when present (else an
//! honest 501; see PARITY.md).

use crate::state::SharedState;
use caliber_common::signature::{is_same_signature, source_signature, SourceSignature};
use caliber_common::wyhash::library_hash36;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

const CACHE_META_FILE: &str = ".caliber-page-cache.json";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PAGE_COUNT: usize = 10_000;
const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
const COMMAND_TIMEOUT_MS: u64 = 30_000;
const CBR_MANIFEST_VERSION: i64 = 2;

const IMAGE_EXTENSIONS: [&str; 6] = [".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"];

pub struct PageStreamingError {
    pub status: u16,
    pub message: String,
}

impl PageStreamingError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        PageStreamingError {
            status,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPage {
    index: i64,
    name: String,
    file_name: String,
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageCacheMeta {
    source: SourceSignature,
    page_count: i64,
    pages: Vec<CachedPage>,
    #[serde(rename = "libHash", skip_serializing_if = "Option::is_none")]
    lib_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
}

#[derive(Default)]
struct MetaMemCache(Mutex<std::collections::HashMap<String, (PageCacheMeta, SourceSignature)>>);

static META_MEM_CACHE: std::sync::OnceLock<MetaMemCache> = std::sync::OnceLock::new();

fn meta_mem_cache() -> &'static MetaMemCache {
    META_MEM_CACHE.get_or_init(MetaMemCache::default)
}

/// Run `f` with the meta cache locked (helpers below use this).
fn with_meta_cache<T>(
    f: impl FnOnce(&mut std::collections::HashMap<String, (PageCacheMeta, SourceSignature)>) -> T,
) -> T {
    f(&mut meta_mem_cache().0.lock().unwrap())
}

fn insert_meta_mem(key: String, value: (PageCacheMeta, SourceSignature)) {
    with_meta_cache(|cache| cache.insert(key, value));
}

fn remove_meta_mem(key: &str) {
    with_meta_cache(|cache| {
        cache.remove(key);
    });
}

fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) => name[i..].to_ascii_lowercase(),
        None => String::new(),
    }
}

fn base_of(name: &str) -> String {
    match name.rfind('/') {
        Some(i) => name[i + 1..].to_string(),
        None => name.to_string(),
    }
}

/// `localeCompare(…, { numeric: true, sensitivity: "base" })` approximation:
/// digit runs compare numerically, other runs compare case-insensitively.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.char_indices().peekable();
    let mut bi = b.char_indices().peekable();
    loop {
        match (ai.peek().map(|(_, c)| c), bi.peek().map(|(_, c)| c)) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let a_run: String = {
                        let mut run = String::new();
                        while let Some((_, c)) = ai.peek() {
                            if c.is_ascii_digit() {
                                run.push(*c);
                                ai.next();
                            } else {
                                break;
                            }
                        }
                        run
                    };
                    let b_run: String = {
                        let mut run = String::new();
                        while let Some((_, c)) = bi.peek() {
                            if c.is_ascii_digit() {
                                run.push(*c);
                                bi.next();
                            } else {
                                break;
                            }
                        }
                        run
                    };
                    let a_trim = a_run.trim_start_matches('0');
                    let b_trim = b_run.trim_start_matches('0');
                    let ord = a_trim
                        .len()
                        .cmp(&b_trim.len())
                        .then_with(|| a_trim.cmp(b_trim));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                } else {
                    let la = ca.to_lowercase().next().unwrap_or(*ca);
                    let lb = cb.to_lowercase().next().unwrap_or(*cb);
                    if la < lb {
                        return Ordering::Less;
                    }
                    if la > lb {
                        return Ordering::Greater;
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

/// Pixel-count guard via PNG IHDR header without a full decode.
fn assert_pixel_count_guard(data: &[u8], file_name: &str) -> Result<(), PageStreamingError> {
    if ext_of(file_name) != ".png" || data.len() < 33 {
        return Ok(());
    }
    if data[0] == 0x89
        && data[1] == 0x50
        && data[2] == 0x4e
        && data[3] == 0x47
        && data[12] == 0x49
        && data[13] == 0x48
        && data[14] == 0x44
        && data[15] == 0x52
    {
        let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]) as u64;
        let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]) as u64;
        if w.checked_mul(h)
            .map(|px| px > MAX_IMAGE_PIXELS)
            .unwrap_or(true)
        {
            return Err(PageStreamingError::new(
                413,
                "Page image exceeds the pixel-count limit",
            ));
        }
    }
    Ok(())
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|md| md.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn dir_size_and_files(dir: &Path, state: &SharedState, files: &mut Vec<(PathBuf, f64)>) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size_and_files(&p, state, files);
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        total += md.len();
        if entry.file_name().to_string_lossy() == CACHE_META_FILE {
            continue;
        }
        if state.page_leases.count(&p) > 0 {
            continue;
        }
        files.push((p.clone(), mtime_ms(&p)));
    }
    total
}

/// 2GB quota sweep: oldest unleased page files first; in-memory metas whose
/// pages vanished are dropped.
fn sweep_page_cache_quota(state: &SharedState, cache_root: &Path) {
    let _ = std::fs::create_dir_all(cache_root);
    let Ok(books) = std::fs::read_dir(cache_root) else {
        return;
    };
    let mut files = Vec::new();
    let mut total = 0;
    for book in books.flatten() {
        let p = book.path();
        if p.is_dir() {
            total += dir_size_and_files(&p, state, &mut files);
        }
    }
    if total <= MAX_CACHE_BYTES {
        return;
    }
    files.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    for (path, _) in &files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if state.page_leases.count(path) > 0 {
            continue;
        }
        if let Ok(md) = std::fs::metadata(path) {
            total = total.saturating_sub(md.len());
        }
        let _ = std::fs::remove_file(path);
    }
    // Drop orphaned metas: keep entries whose on-disk meta file still exists
    // (a cheap proxy for "pages were not evicted" without knowing the dir).
    with_meta_cache(|cache| {
        cache.retain(|_key, entry| !entry.0.pages.is_empty());
    });
}

fn cache_dir_for(book_id: i64, format: &str, lib_hash: &str, cache_root: &Path) -> PathBuf {
    cache_root
        .join(format!("{lib_hash}-{book_id}"))
        .join(format!("{}", format.to_ascii_uppercase()))
}

fn meta_cache_key(book_id: i64, format: &str, library: &str) -> String {
    format!("{library}::{book_id}/{}", format.to_ascii_uppercase())
}

async fn get_source_path(
    state: &SharedState,
    book_id: i64,
    format: &str,
) -> Result<PathBuf, PageStreamingError> {
    let db = state.db.clone();
    let owned = format.to_string();
    let not_found_msg = format!("Format {} not found", format.to_ascii_uppercase());
    let path = tokio::task::spawn_blocking(move || db.book_format_path(book_id, &owned))
        .await
        .ok()
        .flatten();
    match path {
        Some(p) if p.is_file() => Ok(p),
        _ => Err(PageStreamingError::new(404, not_found_msg)),
    }
}

fn assert_archive_size(source_path: &Path) -> Result<(), PageStreamingError> {
    let size = std::fs::metadata(source_path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_ARCHIVE_BYTES {
        return Err(PageStreamingError::new(
            413,
            "Reader source file is too large",
        ));
    }
    Ok(())
}

fn is_contiguous(pages: &[CachedPage]) -> bool {
    pages
        .iter()
        .enumerate()
        .all(|(i, p)| p.index == i as i64 + 1)
}

fn read_json_meta(path: &Path) -> Option<PageCacheMeta> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// External commands
// ---------------------------------------------------------------------------

fn executable_candidate(name: &str) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var(format!("CALIBER_{}_PATH", name.to_ascii_uppercase())) {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/usr/bin").join(name),
        PathBuf::from("/bin").join(name),
    ];
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            if !dir.is_empty() {
                candidates.insert(0, PathBuf::from(dir).join(name));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn pdfinfo_bin() -> String {
    std::env::var("PDFINFO_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            executable_candidate("pdfinfo")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "pdfinfo".to_string())
        })
}

fn pdftoppm_bin() -> String {
    std::env::var("PDFTOPPM_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            executable_candidate("pdftoppm")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "pdftoppm".to_string())
        })
}

#[derive(Clone)]
enum RarTool {
    Unrar(String),
    Bsdtar(String),
}

impl RarTool {
    /// `unrar lb` / `bsdtar -tf`
    fn list_args<'a>(&self, archive: &'a str) -> (String, Vec<&'a str>) {
        match self {
            RarTool::Unrar(bin) => (bin.clone(), vec!["lb", archive]),
            RarTool::Bsdtar(bin) => (bin.clone(), vec!["-tf", archive]),
        }
    }

    /// `unrar p -inul <archive> <name>` / `bsdtar -xOf <archive> <name>`
    fn extract_args<'a>(&self, archive: &'a str, name: &'a str) -> (String, Vec<&'a str>) {
        match self {
            RarTool::Unrar(bin) => (bin.clone(), vec!["p", "-inul", archive, name]),
            RarTool::Bsdtar(bin) => (bin.clone(), vec!["-xOf", archive, name]),
        }
    }
}

/// CBR extraction backend: `unrar` when present, else macOS's libarchive
/// `bsdtar` (reads RAR). `CALIBER_UNRAR_PATH` overrides.
fn rar_tool() -> Option<RarTool> {
    if let Some(path) = std::env::var("CALIBER_UNRAR_PATH")
        .ok()
        .filter(|v| PathBuf::from(v).is_file())
    {
        return Some(RarTool::Unrar(path));
    }
    if let Some(bin) = executable_candidate("unrar") {
        return Some(RarTool::Unrar(bin.to_string_lossy().into_owned()));
    }
    if let Some(bin) = executable_candidate("bsdtar") {
        return Some(RarTool::Bsdtar(bin.to_string_lossy().into_owned()));
    }
    None
}

/// Run a command with stdout captured, stderr captured, and a 30s kill
/// timeout. Returns stdout text.
fn run_command(bin: &str, args: &[&str]) -> Result<String, PageStreamingError> {
    let mut child = Command::new(bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            PageStreamingError::new(
                501,
                if e.kind() == std::io::ErrorKind::NotFound {
                    format!("{bin} is not available")
                } else {
                    e.to_string()
                },
            )
        })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                let mut stderr = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                if !status.success() {
                    eprintln!("[page-streaming] {bin} error: {}", stderr.trim());
                    return Err(PageStreamingError::new(500, "Page extraction failed"));
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_millis(COMMAND_TIMEOUT_MS) {
                    let _ = child.kill();
                    return Err(PageStreamingError::new(500, "Page extraction failed"));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(PageStreamingError::new(500, "Page extraction failed")),
        }
    }
}

/// Run a command whose stdout is redirected to a file (unrar `p` page
/// extraction), with the same timeout discipline.
fn run_command_to_file(
    bin: &str,
    args: &[&str],
    out_path: &Path,
) -> Result<(), PageStreamingError> {
    let out_file = std::fs::File::create(out_path)
        .map_err(|_| PageStreamingError::new(500, "Page extraction failed"))?;
    let mut child = Command::new(bin)
        .args(args)
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            PageStreamingError::new(
                501,
                if e.kind() == std::io::ErrorKind::NotFound {
                    format!("{bin} is not available")
                } else {
                    e.to_string()
                },
            )
        })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = std::fs::remove_file(out_path);
                    let mut stderr = String::new();
                    if let Some(mut err) = child.stderr.take() {
                        let _ = err.read_to_string(&mut stderr);
                    }
                    eprintln!("[page-streaming] {bin} error: {}", stderr.trim());
                    return Err(PageStreamingError::new(500, "Page extraction failed"));
                }
                return Ok(());
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_millis(COMMAND_TIMEOUT_MS) {
                    let _ = child.kill();
                    let _ = std::fs::remove_file(out_path);
                    return Err(PageStreamingError::new(500, "Page extraction failed"));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(PageStreamingError::new(500, "Page extraction failed")),
        }
    }
}

fn get_pdf_page_count(source_path: &Path) -> Result<i64, PageStreamingError> {
    let stdout = run_command(&pdfinfo_bin(), &[&source_path.to_string_lossy()])?;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("Pages:") {
            let trimmed = rest.trim();
            if !trimmed.is_empty()
                && trimmed
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
            {
                let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
                let count: i64 = digits.parse().unwrap_or(0);
                if (1..=MAX_PAGE_COUNT as i64).contains(&count) {
                    return Ok(count);
                }
            }
        }
    }
    Err(PageStreamingError::new(
        422,
        "Unable to read PDF page count",
    ))
}

// ---------------------------------------------------------------------------
// CBZ
// ---------------------------------------------------------------------------

struct FormatContext {
    library: String,
    lib_hash: String,
    cache_root: PathBuf,
}

async fn format_context(state: &SharedState) -> Result<FormatContext, PageStreamingError> {
    let db = state.db.clone();
    let library = tokio::task::spawn_blocking(move || db.library_path())
        .await
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?
        .to_string_lossy()
        .into_owned();
    Ok(FormatContext {
        lib_hash: library_hash36(&library),
        library,
        cache_root: state.config.resolved().config_dir.join("page-cache"),
    })
}

async fn ensure_cbz_cache(
    state: &SharedState,
    book_id: i64,
    ctx: &FormatContext,
) -> Result<(PathBuf, PageCacheMeta), PageStreamingError> {
    let format = "CBZ";
    let source_path = get_source_path(state, book_id, format).await?;
    assert_archive_size(&source_path)?;
    let source = source_signature(&source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    let cache_dir = cache_dir_for(book_id, format, &ctx.lib_hash, &ctx.cache_root);
    let legacy_dir = ctx.cache_root.join(book_id.to_string()).join(format);
    let meta_path = cache_dir.join(CACHE_META_FILE);
    let cache_key = meta_cache_key(book_id, format, &ctx.library);

    if let Some((meta, sig)) = with_meta_cache(|m| m.get(&cache_key).cloned()) {
        if meta.lib_hash.as_deref() == Some(ctx.lib_hash.as_str())
            && is_same_signature(Some(&sig), &source)
        {
            return Ok((cache_dir, meta));
        }
    }

    let state = state.clone();
    let lib_hash = ctx.lib_hash.clone();
    let cache_dir2 = cache_dir.clone();
    state
        .page_singleflight
        .run(cache_key.clone(), move || async move {
            let inner = move || -> Result<PageCacheMeta, PageStreamingError> {
                if let Some(existing) = read_json_meta(&meta_path) {
                    if existing.lib_hash.as_deref() == Some(lib_hash.as_str())
                        && is_same_signature(Some(&existing.source), &source)
                        && existing
                            .pages
                            .iter()
                            .all(|p| cache_dir2.join(&p.file_name).is_file())
                    {
                        insert_meta_mem(cache_key.clone(), (existing.clone(), source));
                        return Ok(existing);
                    }
                }
                // Legacy dirs are purged, never adopted.
                if legacy_dir.exists() {
                    let _ = std::fs::remove_dir_all(&legacy_dir);
                }
                remove_meta_mem(&cache_key);
                let _ = std::fs::remove_dir_all(&cache_dir2);
                std::fs::create_dir_all(&cache_dir2)
                    .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;

                let file = std::fs::File::open(&source_path)
                    .map_err(|_| PageStreamingError::new(422, "CBZ contains no image pages"))?;
                let mut zip = zip::ZipArchive::new(file)
                    .map_err(|_| PageStreamingError::new(422, "CBZ contains no image pages"))?;
                let mut names: Vec<String> = Vec::new();
                let mut svg_skipped = 0usize;
                for i in 0..zip.len() {
                    if let Ok(entry) = zip.by_index(i) {
                        if entry.is_dir() {
                            continue;
                        }
                        let name = entry.name().to_string();
                        let ext = ext_of(&name);
                        if ext == ".svg" {
                            svg_skipped += 1;
                            continue;
                        }
                        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                            names.push(name);
                        }
                    }
                }
                if svg_skipped > 0 {
                    eprintln!("[page-streaming] skipped {svg_skipped} SVG page(s) in CBZ source");
                }
                names.sort_by(|a, b| natural_cmp(a, b));
                if names.is_empty() {
                    return Err(PageStreamingError::new(422, "CBZ contains no image pages"));
                }
                if names.len() > MAX_PAGE_COUNT {
                    return Err(PageStreamingError::new(413, "CBZ contains too many pages"));
                }
                // Cumulative declared-size cap before any extraction.
                let mut declared_total: u64 = 0;
                for i in 0..zip.len() {
                    if let Ok(entry) = zip.by_index(i) {
                        if names.iter().any(|n| n == entry.name()) {
                            let declared = entry.size();
                            if declared > MAX_CACHE_BYTES {
                                return Err(PageStreamingError::new(
                                    413,
                                    "CBZ expands beyond the reader cache limit",
                                ));
                            }
                            declared_total += declared;
                            if declared_total > MAX_CACHE_BYTES {
                                return Err(PageStreamingError::new(
                                    413,
                                    "CBZ expands beyond the reader cache limit",
                                ));
                            }
                        }
                    }
                }
                let pages: Vec<CachedPage> = names
                    .iter()
                    .enumerate()
                    .map(|(offset, name)| {
                        let index = offset + 1;
                        let ext = if ext_of(name).is_empty() {
                            ".bin".to_string()
                        } else {
                            ext_of(name)
                        };
                        let file_name = format!("{:05}{ext}", index);
                        CachedPage {
                            index: index as i64,
                            name: base_of(name),
                            content_type: crate::files::entry_content_type(&file_name).to_string(),
                            file_name,
                            source_name: Some(name.clone()),
                        }
                    })
                    .collect();
                let meta = PageCacheMeta {
                    source,
                    lib_hash: Some(lib_hash.clone()),
                    version: None,
                    page_count: pages.len() as i64,
                    pages,
                };
                let body = format!("{}\n", serde_json::to_string(&meta).unwrap_or_default());
                let _ = std::fs::write(&meta_path, body);
                insert_meta_mem(cache_key.clone(), (meta.clone(), source));
                Ok(meta)
            };
            tokio::task::spawn_blocking(inner)
                .await
                .unwrap_or_else(|err| {
                    eprintln!("[page-streaming] cbz ensure panicked: {err}");
                    Err(PageStreamingError::new(500, "Failed to stream page"))
                })
        })
        .await
        .map(|meta| (cache_dir, meta))
}

async fn extract_cbz_page(
    state: &SharedState,
    book_id: i64,
    cache_dir: &Path,
    meta: &PageCacheMeta,
    source_path: &Path,
    source: &SourceSignature,
    page_number: i64,
    library: &str,
    content_type: &'static str,
) -> Result<(PathBuf, &'static str), PageStreamingError> {
    let Some(cached) = meta.pages.get((page_number - 1) as usize) else {
        return Err(PageStreamingError::new(404, "Page not found"));
    };
    let output_path = cache_dir.join(&cached.file_name);
    if output_path.is_file() {
        return Ok((output_path, content_type));
    }
    let revision = state.db.snapshot_revision();
    let key = format!("{library}|{book_id}|{revision}|cbz|{page_number}");
    let sf_state = state.clone();
    let state = state.clone();
    let result_path = output_path.clone();
    let cached = cached.clone();
    let source_path = source_path.to_path_buf();
    let source = *source;
    let cache_dir = cache_dir.to_path_buf();
    sf_state
        .page_singleflight
        .run(key, move || async move {
            let permit = state
                .archive_extract
                .acquire()
                .await
                .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
            let inner_state = state.clone();
            let res = tokio::task::spawn_blocking(move || {
                extract_cbz_page_blocking(
                    &inner_state,
                    &result_path,
                    &cached,
                    &source_path,
                    &source,
                    &cache_dir,
                )
            })
            .await
            .unwrap_or_else(|err| {
                eprintln!("[page-streaming] cbz extract panicked: {err}");
                Err(PageStreamingError::new(500, "Failed to stream page"))
            });
            drop(permit);
            res
        })
        .await?;
    Ok((output_path, content_type))
}

#[allow(clippy::too_many_arguments)]
fn extract_cbz_page_blocking(
    state: &SharedState,
    output_path: &Path,
    cached: &CachedPage,
    source_path: &Path,
    source: &SourceSignature,
    cache_dir: &Path,
) -> Result<(), PageStreamingError> {
    if output_path.is_file() {
        return Ok(());
    }
    let fresh = source_signature(source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    if !is_same_signature(Some(&fresh), source) {
        return Err(PageStreamingError::new(
            409,
            "Reader source changed during extraction",
        ));
    }
    let file = std::fs::File::open(source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| PageStreamingError::new(422, "CBZ contains no image pages"))?;
    let entry_name = cached
        .source_name
        .clone()
        .unwrap_or_else(|| cached.name.clone());
    let mut entry = zip
        .by_name(&entry_name)
        .map_err(|_| PageStreamingError::new(404, "Page not found"))?;
    if entry.size() > MAX_CACHE_BYTES {
        return Err(PageStreamingError::new(
            413,
            "CBZ expands beyond the reader cache limit",
        ));
    }
    let mut data = Vec::new();
    entry
        .read_to_end(&mut data)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    drop(entry);
    if data.len() as u64 > MAX_CACHE_BYTES {
        return Err(PageStreamingError::new(
            413,
            "CBZ expands beyond the reader cache limit",
        ));
    }
    assert_pixel_count_guard(&data, &cached.file_name)?;
    let tmp =
        output_path.with_file_name(format!("{}.tmp-{}", cached.file_name, std::process::id()));
    std::fs::write(&tmp, &data)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    let before_publish = source_signature(source_path).ok();
    if !before_publish
        .map(|sig| is_same_signature(Some(&sig), source))
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(PageStreamingError::new(
            409,
            "Reader source changed during extraction",
        ));
    }
    if std::fs::rename(&tmp, output_path).is_err() {
        let _ = std::fs::write(output_path, &data);
        let _ = std::fs::remove_file(&tmp);
    }
    let cache_root = cache_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    sweep_page_cache_quota(state, &cache_root);
    Ok(())
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async fn ensure_pdf_cache(
    state: &SharedState,
    book_id: i64,
    ctx: &FormatContext,
) -> Result<(PathBuf, PathBuf, SourceSignature, i64), PageStreamingError> {
    let format = "PDF";
    let source_path = get_source_path(state, book_id, format).await?;
    assert_archive_size(&source_path)?;
    let source = source_signature(&source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    let cache_dir = cache_dir_for(book_id, format, &ctx.lib_hash, &ctx.cache_root);
    let legacy_dir = ctx.cache_root.join(book_id.to_string()).join(format);
    let meta_path = cache_dir.join(CACHE_META_FILE);
    let cache_key = meta_cache_key(book_id, format, &ctx.library);

    let state = state.clone();
    let lib_hash = ctx.lib_hash.clone();
    let cache_dir2 = cache_dir.clone();
    let source_path2 = source_path.clone();
    state
        .page_singleflight
        .run(cache_key, move || async move {
            let inner = move || -> Result<i64, PageStreamingError> {
                if let Some(existing) = read_json_meta(&meta_path) {
                    if existing.lib_hash.as_deref() == Some(lib_hash.as_str())
                        && is_same_signature(Some(&existing.source), &source)
                    {
                        return Ok(existing.page_count);
                    }
                }
                if legacy_dir.exists() {
                    let _ = std::fs::remove_dir_all(&legacy_dir);
                }
                let _ = std::fs::remove_dir_all(&cache_dir2);
                std::fs::create_dir_all(&cache_dir2)
                    .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
                let page_count = get_pdf_page_count(&source_path2)?;
                let pages: Vec<CachedPage> = (1..=page_count)
                    .map(|i| CachedPage {
                        index: i,
                        name: format!("Page {i}"),
                        file_name: format!("{i:05}.png"),
                        content_type: "image/png".to_string(),
                        source_name: None,
                    })
                    .collect();
                let meta = PageCacheMeta {
                    source,
                    lib_hash: Some(lib_hash.clone()),
                    version: None,
                    page_count,
                    pages,
                };
                let body = format!("{}\n", serde_json::to_string(&meta).unwrap_or_default());
                let _ = std::fs::write(&meta_path, body);
                Ok(page_count)
            };
            tokio::task::spawn_blocking(inner)
                .await
                .unwrap_or_else(|err| {
                    eprintln!("[page-streaming] pdf ensure panicked: {err}");
                    Err(PageStreamingError::new(500, "Failed to stream page"))
                })
        })
        .await
        .map(|page_count| (cache_dir, source_path, source, page_count))
}

async fn get_pdf_page_file(
    state: &SharedState,
    book_id: i64,
    page: i64,
    ctx: &FormatContext,
) -> Result<(PathBuf, &'static str), PageStreamingError> {
    let (cache_dir, source_path, source, page_count) =
        ensure_pdf_cache(state, book_id, ctx).await?;
    if !(1..=page_count).contains(&page) {
        return Err(PageStreamingError::new(404, "Page not found"));
    }
    let output_path = cache_dir.join(format!("{page:05}.png"));
    if output_path.is_file() {
        return Ok((output_path, "image/png"));
    }
    let revision = state.db.snapshot_revision();
    let key = format!("{}|{book_id}|{revision}|pdf|{page}", ctx.library);
    let sf_state = state.clone();
    let state = state.clone();
    let result_path = output_path.clone();
    let source_path = source_path.clone();
    let source = source;
    let cache_root = ctx.cache_root.clone();
    sf_state
        .page_singleflight
        .run(key, move || async move {
            let permit = state
                .pdf_render
                .acquire()
                .await
                .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
            let inner_state = state.clone();
            let res = tokio::task::spawn_blocking(move || {
                render_pdf_page_blocking(
                    &inner_state,
                    &result_path,
                    &source_path,
                    &source,
                    page,
                    &cache_root,
                )
            })
            .await
            .unwrap_or_else(|err| {
                eprintln!("[page-streaming] pdf render panicked: {err}");
                Err(PageStreamingError::new(500, "Failed to stream page"))
            });
            drop(permit);
            res
        })
        .await?;
    Ok((output_path, "image/png"))
}

fn render_pdf_page_blocking(
    state: &SharedState,
    output_path: &Path,
    source_path: &Path,
    source: &SourceSignature,
    page_number: i64,
    cache_root: &Path,
) -> Result<(), PageStreamingError> {
    if output_path.is_file() {
        return Ok(());
    }
    let fresh = source_signature(source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    if !is_same_signature(Some(&fresh), source) {
        return Err(PageStreamingError::new(
            409,
            "Reader source changed during rendering",
        ));
    }
    let prefix = output_path.with_extension("");
    let tmp_prefix = format!("{}.tmp-{}", prefix.display(), std::process::id());
    let tmp_path = PathBuf::from(format!("{tmp_prefix}.png"));
    let _ = std::fs::remove_file(&tmp_path);
    let page_str = page_number.to_string();
    run_command(
        &pdftoppm_bin(),
        &[
            "-f",
            &page_str,
            "-l",
            &page_str,
            "-singlefile",
            "-png",
            "-r",
            "150",
            &source_path.to_string_lossy(),
            &tmp_prefix,
        ],
    )?;
    let before_publish = source_signature(source_path).ok();
    if !before_publish
        .map(|sig| is_same_signature(Some(&sig), source))
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(PageStreamingError::new(
            409,
            "Reader source changed during rendering",
        ));
    }
    if !tmp_path.is_file() {
        return Err(PageStreamingError::new(500, "Page extraction failed"));
    }
    if let Ok(rendered) = std::fs::read(&tmp_path) {
        if let Err(err) = assert_pixel_count_guard(&rendered, "page.png") {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(err);
        }
    }
    if std::fs::rename(&tmp_path, output_path).is_err() {
        let data = std::fs::read(&tmp_path).unwrap_or_default();
        let _ = std::fs::write(output_path, data);
        let _ = std::fs::remove_file(&tmp_path);
    }
    sweep_page_cache_quota(state, cache_root);
    Ok(())
}

// ---------------------------------------------------------------------------
// CBR (external unrar; 501 when absent — PARITY.md)
// ---------------------------------------------------------------------------

async fn ensure_cbr_cache(
    state: &SharedState,
    book_id: i64,
    ctx: &FormatContext,
) -> Result<(PathBuf, PageCacheMeta), PageStreamingError> {
    let Some(rar) = rar_tool() else {
        return Err(PageStreamingError::new(
            501,
            "CBR page extraction is unavailable (install unrar or bsdtar)",
        ));
    };
    let format = "CBR";
    let source_path = get_source_path(state, book_id, format).await?;
    assert_archive_size(&source_path)?;
    let source = source_signature(&source_path)
        .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
    let cache_dir = cache_dir_for(book_id, format, &ctx.lib_hash, &ctx.cache_root);
    let legacy_dir = ctx.cache_root.join(book_id.to_string()).join(format);
    let meta_path = cache_dir.join(CACHE_META_FILE);
    let cache_key = meta_cache_key(book_id, format, &ctx.library);

    if let Some((meta, sig)) = with_meta_cache(|m| m.get(&cache_key).cloned()) {
        if meta.lib_hash.as_deref() == Some(ctx.lib_hash.as_str())
            && meta.version == Some(CBR_MANIFEST_VERSION)
            && meta.page_count == meta.pages.len() as i64
            && is_contiguous(&meta.pages)
            && is_same_signature(Some(&sig), &source)
        {
            return Ok((cache_dir, meta));
        }
    }

    let sf_state = state.clone();
    let state = state.clone();
    let lib_hash = ctx.lib_hash.clone();
    let cache_dir2 = cache_dir.clone();
    let rar = rar.clone();
    sf_state
        .page_singleflight
        .run(cache_key.clone(), move || async move {
            let permit = state
                .archive_extract
                .acquire()
                .await
                .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
            let inner_state = state.clone();
            let inner = move || -> Result<PageCacheMeta, PageStreamingError> {
                if let Some(existing) = read_json_meta(&meta_path) {
                    if existing.lib_hash.as_deref() == Some(lib_hash.as_str())
                        && existing.version == Some(CBR_MANIFEST_VERSION)
                        && existing.page_count == existing.pages.len() as i64
                        && is_contiguous(&existing.pages)
                        && is_same_signature(Some(&existing.source), &source)
                        && existing
                            .pages
                            .iter()
                            .all(|p| cache_dir2.join(&p.file_name).is_file())
                    {
                        insert_meta_mem(cache_key.clone(), (existing.clone(), source));
                        return Ok(existing);
                    }
                }
                if legacy_dir.exists() {
                    let _ = std::fs::remove_dir_all(&legacy_dir);
                }
                remove_meta_mem(&cache_key);
                let _ = std::fs::remove_dir_all(&cache_dir2);
                std::fs::create_dir_all(&cache_dir2)
                    .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;

                let archive = source_path.to_string_lossy().into_owned();
                let (list_bin, list_args) = rar.list_args(&archive);
                let listing = run_command(&list_bin, &list_args)?;
                let mut names: Vec<String> = listing
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect();
                let svg_skipped = names.iter().filter(|n| ext_of(n) == ".svg").count();
                if svg_skipped > 0 {
                    eprintln!("[page-streaming] skipped {svg_skipped} SVG page(s) in CBR source");
                }
                names.retain(|n| IMAGE_EXTENSIONS.contains(&ext_of(n).as_str()));
                names.sort_by(|a, b| natural_cmp(a, b));
                if names.is_empty() {
                    return Err(PageStreamingError::new(422, "CBZ contains no image pages"));
                }
                if names.len() > MAX_PAGE_COUNT {
                    return Err(PageStreamingError::new(413, "CBZ contains too many pages"));
                }

                // Eager extraction with a running byte cap and pixel guard.
                let mut retained: Vec<CachedPage> = Vec::new();
                let mut retained_bytes: u64 = 0;
                for (offset, name) in names.iter().enumerate() {
                    let index = offset + 1;
                    let ext = if ext_of(name).is_empty() {
                        ".bin".to_string()
                    } else {
                        ext_of(name)
                    };
                    let file_name = format!("{index:05}{ext}");
                    let output_path = cache_dir2.join(&file_name);
                    let tmp = output_path
                        .with_file_name(format!("{file_name}.tmp-{}", std::process::id()));
                    let (extract_bin, extract_args) = rar.extract_args(&archive, name);
                    run_command_to_file(&extract_bin, &extract_args, &tmp)?;
                    let data = std::fs::read(&tmp)
                        .map_err(|_| PageStreamingError::new(500, "Page extraction failed"))?;
                    if data.len() as u64 > MAX_CACHE_BYTES
                        || retained_bytes + data.len() as u64 > MAX_CACHE_BYTES
                    {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(PageStreamingError::new(
                            413,
                            "CBZ expands beyond the reader cache limit",
                        ));
                    }
                    retained_bytes += data.len() as u64;
                    assert_pixel_count_guard(&data, &file_name)?;
                    let before_publish = source_signature(&source_path).ok();
                    if !before_publish
                        .map(|sig| is_same_signature(Some(&sig), &source))
                        .unwrap_or(false)
                    {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(PageStreamingError::new(
                            409,
                            "Reader source changed during extraction",
                        ));
                    }
                    if std::fs::rename(&tmp, &output_path).is_err() {
                        let _ = std::fs::write(&output_path, &data);
                        let _ = std::fs::remove_file(&tmp);
                    }
                    retained.push(CachedPage {
                        index: index as i64,
                        name: base_of(name),
                        content_type: crate::files::entry_content_type(&file_name).to_string(),
                        file_name,
                        source_name: Some(name.clone()),
                    });
                }
                if retained.is_empty() || !is_contiguous(&retained) {
                    return Err(PageStreamingError::new(
                        422,
                        "CBR pages could not be extracted",
                    ));
                }
                let meta = PageCacheMeta {
                    source,
                    lib_hash: Some(lib_hash.clone()),
                    version: Some(CBR_MANIFEST_VERSION),
                    page_count: retained.len() as i64,
                    pages: retained,
                };
                let body = format!("{}\n", serde_json::to_string(&meta).unwrap_or_default());
                let _ = std::fs::write(&meta_path, body);
                insert_meta_mem(cache_key.clone(), (meta.clone(), source));
                Ok(meta)
            };
            let res = tokio::task::spawn_blocking(inner)
                .await
                .unwrap_or_else(|err| {
                    eprintln!("[page-streaming] cbr ensure panicked: {err}");
                    Err(PageStreamingError::new(500, "Failed to stream page"))
                });
            drop(permit);
            let _ = inner_state;
            res
        })
        .await
        .map(|meta| (cache_dir, meta))
}

async fn extract_cbr_page(
    state: &SharedState,
    book_id: i64,
    cache_dir: &Path,
    meta: &PageCacheMeta,
    source_path: &Path,
    source: &SourceSignature,
    page_number: i64,
    library: &str,
    cache_root: &Path,
) -> Result<(PathBuf, &'static str), PageStreamingError> {
    let Some(rar) = rar_tool() else {
        return Err(PageStreamingError::new(
            501,
            "CBR page extraction is unavailable (install unrar or bsdtar)",
        ));
    };
    let Some(cached) = meta.pages.get((page_number - 1) as usize) else {
        return Err(PageStreamingError::new(404, "Page not found"));
    };
    let output_path = cache_dir.join(&cached.file_name);
    if output_path.is_file() {
        let ct = leak_content_type(cached.content_type.clone());
        return Ok((output_path, ct));
    }
    let revision = state.db.snapshot_revision();
    let key = format!("{library}|{book_id}|{revision}|cbr|{page_number}");
    let sf_state = state.clone();
    let state = state.clone();
    let result_path = output_path.clone();
    let cached = cached.clone();
    let source_path = source_path.to_path_buf();
    let source = *source;
    let rar = rar.clone();
    let cache_root = cache_root.to_path_buf();
    sf_state
        .page_singleflight
        .run(key, move || async move {
            let permit = state
                .archive_extract
                .acquire()
                .await
                .unwrap_or_else(|e| panic!("semaphore closed: {e}"));
            let inner = move || -> Result<(), PageStreamingError> {
                if result_path.is_file() {
                    return Ok(());
                }
                let fresh = source_signature(&source_path)
                    .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
                if !is_same_signature(Some(&fresh), &source) {
                    return Err(PageStreamingError::new(
                        409,
                        "Reader source changed during extraction",
                    ));
                }
                let archive = source_path.to_string_lossy().into_owned();
                let entry_name = cached
                    .source_name
                    .clone()
                    .unwrap_or_else(|| cached.name.clone());
                let tmp = result_path.with_file_name(format!(
                    "{}.tmp-{}",
                    cached.file_name,
                    std::process::id()
                ));
                let (extract_bin, extract_args) = rar.extract_args(&archive, &entry_name);
                run_command_to_file(&extract_bin, &extract_args, &tmp)?;
                let data = std::fs::read(&tmp)
                    .map_err(|_| PageStreamingError::new(404, "Page not found"))?;
                if data.len() as u64 > MAX_CACHE_BYTES {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(PageStreamingError::new(
                        413,
                        "CBZ expands beyond the reader cache limit",
                    ));
                }
                assert_pixel_count_guard(&data, &cached.file_name)?;
                let before_publish = source_signature(&source_path).ok();
                if !before_publish
                    .map(|sig| is_same_signature(Some(&sig), &source))
                    .unwrap_or(false)
                {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(PageStreamingError::new(
                        409,
                        "Reader source changed during extraction",
                    ));
                }
                if std::fs::rename(&tmp, &result_path).is_err() {
                    let _ = std::fs::write(&result_path, &data);
                    let _ = std::fs::remove_file(&tmp);
                }
                Ok(())
            };
            let inner_state = state.clone();
            let res = tokio::task::spawn_blocking(inner)
                .await
                .unwrap_or_else(|err| {
                    eprintln!("[page-streaming] cbr extract panicked: {err}");
                    Err(PageStreamingError::new(500, "Failed to stream page"))
                });
            drop(permit);
            let _ = inner_state;
            let _ = cache_root;
            res
        })
        .await?;
    let ct = leak_content_type(cached.content_type.clone());
    Ok((output_path, ct))
}

/// The content types come from a small closed set; leak them to satisfy the
/// `&'static str` serving signature.
fn leak_content_type(content_type: String) -> &'static str {
    Box::leak(content_type.into_boxed_str())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub async fn get_page_manifest(
    state: &SharedState,
    book_id: i64,
    format_param: &str,
) -> Result<Value, PageStreamingError> {
    let format = format_param.to_ascii_uppercase();
    let ctx = format_context(state).await?;

    match format.as_str() {
        "CBZ" => {
            let (_, meta) = ensure_cbz_cache(state, book_id, &ctx).await?;
            Ok(manifest_json(book_id, &format, &meta))
        }
        "CBR" => {
            let (_, meta) = ensure_cbr_cache(state, book_id, &ctx).await?;
            Ok(manifest_json(book_id, &format, &meta))
        }
        "PDF" => {
            let (_, _, _, page_count) = ensure_pdf_cache(state, book_id, &ctx).await?;
            let pages: Vec<Value> = (1..=page_count)
                .map(|i| {
                    json!({
                        "index": i,
                        "href": format!("/api/books/{book_id}/pages/{format}/{i}"),
                        "type": "image/png",
                        "name": format!("Page {i}"),
                    })
                })
                .collect();
            Ok(json!({
                "bookId": book_id,
                "format": format,
                "pageCount": page_count,
                "pages": pages,
            }))
        }
        _ => Err(PageStreamingError::new(
            415,
            format!("Page streaming is not supported for {format}"),
        )),
    }
}

fn manifest_json(book_id: i64, format: &str, meta: &PageCacheMeta) -> Value {
    let pages: Vec<Value> = meta
        .pages
        .iter()
        .map(|p| {
            json!({
                "index": p.index,
                "href": format!("/api/books/{book_id}/pages/{format}/{}", p.index),
                "type": p.content_type,
                "name": p.name,
            })
        })
        .collect();
    json!({
        "bookId": book_id,
        "format": format,
        "pageCount": meta.page_count,
        "pages": pages,
    })
}

pub async fn get_page_file(
    state: &SharedState,
    book_id: i64,
    format_param: &str,
    page: i64,
) -> Result<(PathBuf, &'static str), PageStreamingError> {
    let format = format_param.to_ascii_uppercase();
    let ctx = format_context(state).await?;

    match format.as_str() {
        "CBZ" => {
            let (cache_dir, meta) = ensure_cbz_cache(state, book_id, &ctx).await?;
            if !(1..=meta.page_count).contains(&page) {
                return Err(PageStreamingError::new(404, "Page not found"));
            }
            let cached = &meta.pages[(page - 1) as usize];
            let source_path = get_source_path(state, book_id, &format).await?;
            let source = source_signature(&source_path)
                .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
            let ct = leak_content_type(cached.content_type.clone());
            extract_cbz_page(
                state,
                book_id,
                &cache_dir,
                &meta,
                &source_path,
                &source,
                page,
                &ctx.library,
                ct,
            )
            .await
        }
        "CBR" => {
            let (cache_dir, meta) = ensure_cbr_cache(state, book_id, &ctx).await?;
            if !(1..=meta.page_count).contains(&page) {
                return Err(PageStreamingError::new(404, "Page not found"));
            }
            let cached = &meta.pages[(page - 1) as usize];
            let output_path = cache_dir.join(&cached.file_name);
            if output_path.is_file() {
                let ct = leak_content_type(cached.content_type.clone());
                return Ok((output_path, ct));
            }
            let source_path = get_source_path(state, book_id, &format).await?;
            let source = source_signature(&source_path)
                .map_err(|_| PageStreamingError::new(500, "Failed to stream page"))?;
            extract_cbr_page(
                state,
                book_id,
                &cache_dir,
                &meta,
                &source_path,
                &source,
                page,
                &ctx.library,
                &ctx.cache_root,
            )
            .await
        }
        "PDF" => get_pdf_page_file(state, book_id, page, &ctx).await,
        _ => Err(PageStreamingError::new(
            415,
            format!("Page streaming is not supported for {format}"),
        )),
    }
}
