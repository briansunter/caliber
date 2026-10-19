//! In-memory mock backends for route-level tests (`#[cfg(test)]` only).
//! The mocks implement enough of the CONTRACT semantics (cursor pagination
//! shape, progress write protocol, session/throttle mechanics) to exercise
//! the server's black-box behavior without SQLite.

use crate::backend::*;
use caliber_common::config::LibrarySelection;
use caliber_common::{
    AuthorInfo, BookListItem, BookWithDetails, CatalogEntry, CatalogId, CatalogKind,
    CatalogOptions, ConfigError, CursorPaginatedResult, FormatSummary, LibraryConfigStatus,
    LibraryStats, ListOptions, SortField, SortOrder, TagSummary,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// MockDb
// ---------------------------------------------------------------------------

pub struct MockDb {
    pub config: caliber_common::Config,
    pub library_path: PathBuf,
    pub books: Vec<BookWithDetails>,
    pub author_ids: HashMap<String, i64>,
    pub series_ids: HashMap<String, i64>,
    pub tag_ids: HashMap<String, i64>,
    /// Shared with the test harness so file fixtures can be registered after
    /// the state (and its Arc<dyn CaliberBackend>) is built.
    pub files: std::sync::Arc<Mutex<HashMap<(i64, String), PathBuf>>>,
    pub covers: std::sync::Arc<Mutex<HashMap<i64, PathBuf>>>,
    pub revision: u64,
}

fn book(
    id: i64,
    title: &str,
    authors: &[&str],
    series: Option<&str>,
    series_index: f64,
    tags: &[&str],
    formats: &[&str],
    has_cover: bool,
    timestamp: &str,
) -> BookWithDetails {
    BookWithDetails {
        id,
        title: title.to_string(),
        sort: Some(title.to_string()),
        author_sort: Some(authors.first().map(|a| a.to_string()).unwrap_or_default()),
        authors: authors.iter().map(|a| a.to_string().to_string()).collect(),
        series: series.map(str::to_string),
        series_index,
        tags: tags.iter().map(|t| t.to_string().to_string()).collect(),
        formats: formats.iter().map(|f| f.to_string().to_string()).collect(),
        has_cover,
        pubdate: "2023-01-01 00:00:00+00:00".into(),
        timestamp: timestamp.to_string(),
        rating: None,
        uuid: Some(format!("{:08x}-1111-1111-1111-111111111111", id as u32)),
        last_modified: Some(timestamp.to_string()),
        publisher: None,
        comments: None,
        isbn: String::new(),
        path: format!("Book {id}"),
    }
}

pub fn fixture_books() -> Vec<BookWithDetails> {
    vec![
        book(
            1,
            "Alpha & Beta",
            &["Alice Author"],
            Some("Fixture Series"),
            1.0,
            &["Comics", "Fiction"],
            &["EPUB", "PDF"],
            true,
            "2024-01-02 00:00:00+00:00",
        ),
        book(
            2,
            "Gamma Search",
            &["Bob Writer"],
            None,
            1.0,
            &["Fiction"],
            &["EPUB"],
            false,
            "2024-01-03 00:00:00+00:00",
        ),
        book(
            3,
            "Delta Book",
            &["Alice Author"],
            Some("Fixture Series"),
            2.0,
            &["Comics"],
            &["PDF"],
            false,
            "2024-01-04 00:00:00+00:00",
        ),
    ]
}

impl MockDb {
    pub fn new(config: caliber_common::Config, library_path: PathBuf) -> MockDb {
        let books = fixture_books();
        let mut author_ids = HashMap::new();
        author_ids.insert("Alice Author".to_string(), 1);
        author_ids.insert("Bob Writer".to_string(), 2);
        let mut series_ids = HashMap::new();
        series_ids.insert("Fixture Series".to_string(), 1);
        let mut tag_ids = HashMap::new();
        tag_ids.insert("Comics".to_string(), 1);
        tag_ids.insert("Fiction".to_string(), 2);
        MockDb {
            config,
            library_path,
            books,
            author_ids,
            series_ids,
            tag_ids,
            files: std::sync::Arc::new(Mutex::new(HashMap::new())),
            covers: std::sync::Arc::new(Mutex::new(HashMap::new())),
            revision: 7,
        }
    }

    fn to_list_item(b: &BookWithDetails) -> BookListItem {
        BookListItem {
            id: b.id,
            title: b.title.clone(),
            sort: b.sort.clone(),
            author_sort: b.author_sort.clone(),
            authors: b.authors.clone(),
            series: b.series.clone(),
            series_index: b.series_index,
            tags: b.tags.clone(),
            formats: b.formats.clone(),
            has_cover: b.has_cover,
            pubdate: b.pubdate.clone(),
            timestamp: b.timestamp.clone(),
            rating: b.rating,
            uuid: b.uuid.clone(),
            last_modified: b.last_modified.clone(),
        }
    }

    fn sort_key(b: &BookListItem, sort_by: SortField) -> caliber_common::cursor::CursorSort {
        match sort_by {
            SortField::Title => caliber_common::cursor::CursorSort::Text(format!(
                "{}",
                b.sort
                    .clone()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| b.title.to_lowercase())
            )),
            SortField::Author => caliber_common::cursor::CursorSort::Text(
                b.author_sort.clone().unwrap_or_default().to_lowercase(),
            ),
            SortField::Added => caliber_common::cursor::CursorSort::Text(b.timestamp.clone()),
            SortField::Rating => {
                caliber_common::cursor::CursorSort::Number(b.rating.unwrap_or(0) as f64)
            }
            SortField::SeriesIndex => caliber_common::cursor::CursorSort::Number(b.series_index),
        }
    }

    fn filter(&self, opts: &ListOptions) -> Vec<BookListItem> {
        let mut items: Vec<BookListItem> = self
            .books
            .iter()
            .filter(|b| {
                if opts.require_formats && b.formats.is_empty() {
                    return false;
                }
                if !opts.tag_ids.is_empty() {
                    let book_tag_ids: Vec<i64> = b
                        .tags
                        .iter()
                        .filter_map(|t| self.tag_ids.get(t).copied())
                        .collect();
                    if !opts.tag_ids.iter().any(|id| book_tag_ids.contains(id)) {
                        return false;
                    }
                }
                if !opts.formats.is_empty()
                    && !opts
                        .formats
                        .iter()
                        .any(|f| b.formats.iter().any(|bf| bf.eq_ignore_ascii_case(f)))
                {
                    return false;
                }
                true
            })
            .map(Self::to_list_item)
            .collect();
        let sort_by = opts.sort_by();
        let sort_order = opts.sort_order();
        items.sort_by(|a, b| {
            let ka = Self::sort_key(a, sort_by);
            let kb = Self::sort_key(b, sort_by);
            let ord = match (&ka, &kb) {
                (
                    caliber_common::cursor::CursorSort::Text(x),
                    caliber_common::cursor::CursorSort::Text(y),
                ) => x.cmp(y),
                (
                    caliber_common::cursor::CursorSort::Number(x),
                    caliber_common::cursor::CursorSort::Number(y),
                ) => x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal),
                _ => std::cmp::Ordering::Equal,
            }
            .then(a.id.cmp(&b.id));
            if sort_order == SortOrder::Asc {
                ord
            } else {
                ord.reverse()
            }
        });
        items
    }

    fn paginate(
        &self,
        items: Vec<BookListItem>,
        opts: &ListOptions,
        sort_by: SortField,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let limit = opts.limit.unwrap_or(100).clamp(1, 200) as usize;
        let start = match &opts.cursor {
            None => 0,
            Some(cursor) => {
                let decoded =
                    caliber_common::decode_book_cursor(cursor).ok_or(DbError::InvalidCursor)?;
                let expected_sort = match sort_by {
                    SortField::Rating | SortField::SeriesIndex => {
                        matches!(decoded.sort, caliber_common::cursor::CursorSort::Number(_))
                    }
                    _ => matches!(decoded.sort, caliber_common::cursor::CursorSort::Text(_)),
                };
                if !expected_sort {
                    return Err(DbError::InvalidCursor);
                }
                items
                    .iter()
                    .position(|item| {
                        item.id == decoded.id && Self::sort_key(item, sort_by) == decoded.sort
                    })
                    .ok_or(DbError::InvalidCursor)?
                    + 1
            }
        };
        let total = if opts.include_total && opts.cursor.is_none() {
            Some(items.len() as i64)
        } else {
            None
        };
        let page: Vec<BookListItem> = items.into_iter().skip(start).take(limit + 1).collect();
        let has_more = page.len() > limit;
        let mut page = page;
        page.truncate(limit);
        let next_cursor = if has_more {
            page.last().map(|item| {
                caliber_common::encode_book_cursor(item.id, &Self::sort_key(item, sort_by))
            })
        } else {
            None
        };
        Ok(CursorPaginatedResult {
            items: page,
            next_cursor,
            has_more,
            total,
        })
    }

    fn catalog_entries(&self, kind: CatalogKind) -> Vec<CatalogEntry> {
        let mut counts: HashMap<String, i64> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        match kind {
            CatalogKind::Authors => {
                for b in &self.books {
                    for author in &b.authors {
                        if !counts.contains_key(author) {
                            order.push(author.clone());
                        }
                        *counts.entry(author.clone()).or_insert(0) += 1;
                    }
                }
            }
            CatalogKind::Series => {
                for b in &self.books {
                    if let Some(series) = &b.series {
                        if !counts.contains_key(series) {
                            order.push(series.clone());
                        }
                        *counts.entry(series.clone()).or_insert(0) += 1;
                    }
                }
            }
            CatalogKind::Tags => {
                for b in &self.books {
                    for tag in &b.tags {
                        if !counts.contains_key(tag) {
                            order.push(tag.clone());
                        }
                        *counts.entry(tag.clone()).or_insert(0) += 1;
                    }
                }
            }
            CatalogKind::Formats => {
                for b in &self.books {
                    for format in &b.formats {
                        if !counts.contains_key(format) {
                            order.push(format.clone());
                        }
                        *counts.entry(format.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
        order.sort();
        order
            .into_iter()
            .map(|name| CatalogEntry {
                id: match kind {
                    CatalogKind::Authors => {
                        CatalogId::Num(*self.author_ids.get(&name).unwrap_or(&0))
                    }
                    CatalogKind::Series => {
                        CatalogId::Num(*self.series_ids.get(&name).unwrap_or(&0))
                    }
                    CatalogKind::Tags => CatalogId::Num(*self.tag_ids.get(&name).unwrap_or(&0)),
                    CatalogKind::Formats => CatalogId::Text(name.to_ascii_uppercase()),
                },
                title: name.clone(),
                sort: name.clone(),
                book_count: counts[&name],
            })
            .collect()
    }
}

impl CaliberBackend for MockDb {
    fn init(&self) -> bool {
        true
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn snapshot_revision(&self) -> u64 {
        self.revision
    }
    fn snapshot_updated_iso(&self) -> String {
        "2024-06-01T12:00:00.000Z".to_string()
    }
    fn snapshot_status(&self) -> SnapshotStatus {
        SnapshotStatus {
            generation: 1,
            revision: self.revision,
            stale: false,
            refreshing: false,
            failed: None,
        }
    }
    fn acquire_snapshot_lease(&self) -> SnapshotLease {
        SnapshotLease::noop()
    }
    fn reconfigure_library(&self) -> Result<(), DbError> {
        Ok(())
    }
    fn register_refresh_callback(&self, _cb: Box<dyn Fn() + Send + Sync>) {}

    fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let sort_by = opts.sort_by();
        let items = self.filter(opts);
        self.paginate(items, opts, sort_by)
    }

    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        if query.trim().is_empty() {
            return self.list_books(opts);
        }
        let q = query.trim().to_lowercase();
        let filtered: Vec<BookListItem> = self
            .filter(opts)
            .into_iter()
            .filter(|b| {
                b.title.to_lowercase().contains(&q)
                    || b.authors.iter().any(|a| a.to_lowercase().contains(&q))
                    || b.series
                        .as_deref()
                        .map(|s| s.to_lowercase().contains(&q))
                        .unwrap_or(false)
            })
            .collect();
        self.paginate(filtered, opts, opts.sort_by())
    }

    fn list_books_by_author(
        &self,
        author_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let author = self
            .author_ids
            .iter()
            .find(|(_, id)| **id == author_id)
            .map(|(name, _)| name.clone())
            .unwrap_or_default();
        let items: Vec<BookListItem> = self
            .filter(opts)
            .into_iter()
            .filter(|b| b.authors.iter().any(|a| *a == author))
            .collect();
        self.paginate(items, opts, opts.sort_by())
    }

    fn list_books_by_series(
        &self,
        series_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let series = self
            .series_ids
            .iter()
            .find(|(_, id)| **id == series_id)
            .map(|(name, _)| name.clone());
        let mut opts = opts.clone();
        if opts.sort_by.is_none() {
            opts.sort_by = Some(SortField::SeriesIndex);
        }
        let sort_by = opts.sort_by();
        let items: Vec<BookListItem> = self
            .filter(&opts)
            .into_iter()
            .filter(|b| b.series.as_deref() == series.as_deref())
            .collect();
        self.paginate(items, &opts, sort_by)
    }

    fn list_books_by_tag(
        &self,
        tag_id: i64,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let tag = self
            .tag_ids
            .iter()
            .find(|(_, id)| **id == tag_id)
            .map(|(name, _)| name.clone())
            .unwrap_or_default();
        let items: Vec<BookListItem> = self
            .filter(opts)
            .into_iter()
            .filter(|b| b.tags.iter().any(|t| *t == tag))
            .collect();
        self.paginate(items, opts, opts.sort_by())
    }

    fn list_books_by_format(
        &self,
        format: &str,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, DbError> {
        let format = format.to_ascii_uppercase();
        let items: Vec<BookListItem> = self
            .filter(opts)
            .into_iter()
            .filter(|b| b.formats.iter().any(|f| *f == format))
            .collect();
        self.paginate(items, opts, opts.sort_by())
    }

    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, DbError> {
        Ok(self.books.iter().find(|b| b.id == id).cloned())
    }

    fn get_books_by_ids(&self, ids: &[i64]) -> HashMap<i64, BookWithDetails> {
        let mut out = HashMap::new();
        for id in ids.iter().take(500) {
            if let Some(b) = self.books.iter().find(|b| b.id == *id) {
                out.insert(*id, b.clone());
            }
        }
        out
    }

    fn get_book_count(&self) -> Result<i64, DbError> {
        Ok(self.books.len() as i64)
    }

    fn get_library_stats(&self) -> Result<LibraryStats, DbError> {
        Ok(LibraryStats {
            total_books: self.books.len() as i64,
            total_authors: self.author_ids.len() as i64,
            total_series: self.series_ids.len() as i64,
            total_tags: self.tag_ids.len() as i64,
        })
    }

    fn list_authors(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        let entries = self.catalog_entries(CatalogKind::Authors);
        Ok(paginate_catalog(entries, opts))
    }
    fn list_series(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        let entries = self.catalog_entries(CatalogKind::Series);
        Ok(paginate_catalog(entries, opts))
    }
    fn list_tags(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        let entries = self.catalog_entries(CatalogKind::Tags);
        Ok(paginate_catalog(entries, opts))
    }
    fn list_formats(
        &self,
        opts: &CatalogOptions,
    ) -> Result<CursorPaginatedResult<CatalogEntry>, DbError> {
        let entries = self.catalog_entries(CatalogKind::Formats);
        Ok(paginate_catalog(entries, opts))
    }

    fn get_catalog_entry(&self, kind: CatalogKind, id: &CatalogId) -> Option<CatalogEntry> {
        self.catalog_entries(kind).into_iter().find(|e| e.id == *id)
    }

    fn list_all_tags(&self, limit: u32) -> Vec<TagSummary> {
        let limit = limit.clamp(1, 5000);
        self.catalog_entries(CatalogKind::Tags)
            .into_iter()
            .take(limit as usize)
            .filter_map(|e| match e.id {
                CatalogId::Num(id) => Some(TagSummary {
                    id,
                    name: e.title,
                    book_count: e.book_count,
                }),
                CatalogId::Text(_) => None,
            })
            .collect()
    }

    fn list_all_formats(&self) -> Vec<FormatSummary> {
        self.catalog_entries(CatalogKind::Formats)
            .into_iter()
            .map(|e| FormatSummary {
                name: e.title,
                book_count: e.book_count,
            })
            .collect()
    }

    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        let limit = if limit == 0 { 10 } else { limit.min(200) };
        let q = title.to_lowercase();
        self.books
            .iter()
            .filter(|b| b.title.to_lowercase().contains(&q))
            .take(limit as usize)
            .map(|b| MockDb::to_list_item(b))
            .collect()
    }

    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        let limit = if limit == 0 { 10 } else { limit.min(200) };
        let q = author.to_lowercase();
        self.books
            .iter()
            .filter(|b| b.authors.iter().any(|a| a.to_lowercase().contains(&q)))
            .take(limit as usize)
            .map(|b| MockDb::to_list_item(b))
            .collect()
    }

    fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo> {
        let normalized = name.trim();
        let count = self
            .books
            .iter()
            .filter(|b| b.authors.iter().any(|a| a == normalized))
            .count() as i64;
        if count == 0 {
            return None;
        }
        Some(AuthorInfo {
            name: normalized.to_string(),
            book_count: count,
        })
    }

    fn stream_books_batch(
        &self,
        last_id: i64,
        batch_size: u32,
    ) -> Result<Vec<BookListItem>, DbError> {
        let batch = batch_size.clamp(1, 5000) as usize;
        let mut ids: Vec<i64> = self.books.iter().map(|b| b.id).collect();
        ids.sort();
        Ok(ids
            .into_iter()
            .filter(|id| *id > last_id)
            .take(batch)
            .filter_map(|id| self.books.iter().find(|b| b.id == id))
            .map(MockDb::to_list_item)
            .collect())
    }

    fn library_path(&self) -> PathBuf {
        self.library_path.clone()
    }

    fn book_title(&self, id: i64) -> Option<String> {
        self.books
            .iter()
            .find(|b| b.id == id)
            .map(|b| b.title.clone())
    }

    fn book_format_path(&self, book_id: i64, format: &str) -> Option<PathBuf> {
        self.files
            .lock()
            .unwrap()
            .get(&(book_id, format.to_ascii_uppercase()))
            .cloned()
    }

    fn book_cover_path(&self, book_id: i64) -> Option<PathBuf> {
        if self.books.iter().any(|b| b.id == book_id && b.has_cover) {
            self.covers.lock().unwrap().get(&book_id).cloned()
        } else {
            None
        }
    }

    fn save_library_config_with_validation(
        &self,
        selection: LibrarySelection,
    ) -> Result<LibraryConfigStatus, ConfigError> {
        // Prepare (path checks) + a stand-in schema probe (file readable) +
        // apply; the real schema probe lives in caliber-db.
        let (library_path, db_name) = self.config.prepare_library_selection(&selection)?;
        Ok(self.config.apply_library_selection(&library_path, &db_name))
    }
}

fn paginate_catalog(
    entries: Vec<CatalogEntry>,
    opts: &CatalogOptions,
) -> CursorPaginatedResult<CatalogEntry> {
    let limit = opts.limit.unwrap_or(100).clamp(1, 200) as usize;
    let start = match &opts.cursor {
        None => 0,
        Some(cursor) => {
            let Some((id, sort)) = caliber_common::decode_catalog_cursor(cursor) else {
                // Signal invalid cursor through an empty result; tests do not
                // exercise invalid catalog cursors.
                return CursorPaginatedResult {
                    items: Vec::new(),
                    next_cursor: None,
                    has_more: false,
                    total: None,
                };
            };
            entries
                .iter()
                .position(|e| e.id == id && e.sort == sort)
                .map(|p| p + 1)
                .unwrap_or(0)
        }
    };
    let total = if opts.cursor.is_none() {
        Some(entries.len() as i64)
    } else {
        None
    };
    let mut page: Vec<CatalogEntry> = entries.into_iter().skip(start).take(limit + 1).collect();
    let has_more = page.len() > limit;
    page.truncate(limit);
    let next_cursor = if has_more {
        page.last()
            .map(|e| caliber_common::encode_catalog_cursor(&e.id, &e.sort))
    } else {
        None
    };
    CursorPaginatedResult {
        items: page,
        next_cursor,
        has_more,
        total,
    }
}

// ---------------------------------------------------------------------------
// MockUsers
// ---------------------------------------------------------------------------

struct MockUserInner {
    next_id: i64,
    users: Vec<User>,
    password_hashes: HashMap<String, String>,
    auth_epochs: HashMap<i64, i64>,
    sessions: HashMap<String, SessionRow>,
    progress: Vec<ProgressRow>,
    processed_mutations: Vec<String>,
    progress_deletions: HashMap<(i64, String, i64, String), (i64, i64)>,
    library_deletions: HashMap<(i64, String), (i64, i64)>,
    login_failures: HashMap<String, (u32, i64)>,
}

pub struct MockUsers {
    config: caliber_common::Config,
    inner: Mutex<MockUserInner>,
}

impl MockUsers {
    pub fn new(config: caliber_common::Config) -> MockUsers {
        MockUsers {
            config,
            inner: Mutex::new(MockUserInner {
                next_id: 1,
                users: Vec::new(),
                password_hashes: HashMap::new(),
                auth_epochs: HashMap::new(),
                sessions: HashMap::new(),
                progress: Vec::new(),
                processed_mutations: Vec::new(),
                progress_deletions: HashMap::new(),
                library_deletions: HashMap::new(),
                login_failures: HashMap::new(),
            }),
        }
    }

    fn normalize(&self, raw: &str) -> String {
        let trimmed = raw.trim();
        let mut out = String::new();
        let mut in_ws = false;
        for c in trimmed.chars() {
            if c.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                    in_ws = true;
                }
            } else {
                out.push(c);
                in_ws = false;
            }
        }
        out.chars().take(40).collect()
    }
}

impl UserBackend for MockUsers {
    fn get_or_create_user(&self, raw: &str) -> Option<User> {
        let name = self.normalize(raw);
        let mut inner = self.inner.lock().unwrap();
        if let Some(existing) = inner.users.iter().find(|u| u.username == name).cloned() {
            return Some(existing);
        }
        let user = User {
            id: inner.next_id,
            username: name.clone(),
            created_at: now_ms(),
            last_seen_at: now_ms(),
        };
        inner.next_id += 1;
        inner.auth_epochs.entry(user.id).or_insert(0);
        inner.users.push(user.clone());
        let _ = name;
        Some(user)
    }

    fn get_user_by_username(&self, raw: &str) -> Option<User> {
        let name = self.normalize(raw);
        self.inner
            .lock()
            .unwrap()
            .users
            .iter()
            .find(|u| u.username == name)
            .cloned()
    }

    fn get_user_by_id(&self, id: i64) -> Option<User> {
        self.inner
            .lock()
            .unwrap()
            .users
            .iter()
            .find(|u| u.id == id)
            .cloned()
    }

    fn get_credential_by_username(&self, raw: &str) -> Option<UserWithCredential> {
        let name = self.normalize(raw);
        let inner = self.inner.lock().unwrap();
        let user = inner.users.iter().find(|u| u.username == name)?;
        Some(UserWithCredential {
            id: user.id,
            username: user.username.clone(),
            password_hash: inner.password_hashes.get(&name).cloned(),
            auth_epoch: inner.auth_epochs.get(&user.id).copied().unwrap_or(0),
        })
    }

    fn create_user_with_password(&self, raw: &str, password_hash: &str) -> Option<User> {
        let user = self.get_or_create_user(raw)?;
        let mut inner = self.inner.lock().unwrap();
        inner.auth_epochs.entry(user.id).or_insert(0);
        inner
            .password_hashes
            .insert(user.username.clone(), password_hash.to_string());
        Some(user)
    }

    fn set_user_password(&self, user_id: i64, password_hash: Option<&str>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(user) = inner.users.iter().find(|u| u.id == user_id).cloned() else {
            return;
        };
        match password_hash {
            Some(hash) => {
                inner
                    .password_hashes
                    .insert(user.username.clone(), hash.to_string());
            }
            None => {
                inner.password_hashes.remove(&user.username);
            }
        }
        let epoch = inner.auth_epochs.entry(user_id).or_insert(0);
        *epoch += 1;
        inner.sessions.retain(|_, row| row.user_id != user_id);
    }

    fn delete_sessions_for_user(&self, user_id: i64) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.sessions.len();
        inner.sessions.retain(|_, row| row.user_id != user_id);
        before - inner.sessions.len()
    }

    fn get_auth_epoch(&self, user_id: i64) -> Option<i64> {
        self.inner
            .lock()
            .unwrap()
            .auth_epochs
            .get(&user_id)
            .copied()
    }

    fn count_users_with_password(&self) -> i64 {
        self.inner.lock().unwrap().password_hashes.len() as i64
    }

    fn list_auth_users(&self) -> Vec<AuthUserRow> {
        let inner = self.inner.lock().unwrap();
        inner
            .users
            .iter()
            .map(|u| AuthUserRow {
                id: u.id,
                username: u.username.clone(),
                has_password: inner.password_hashes.contains_key(&u.username),
                created_at: u.created_at,
                last_seen_at: u.last_seen_at,
            })
            .collect()
    }

    fn delete_user(&self, raw: &str) -> Option<User> {
        let name = self.normalize(raw);
        let mut inner = self.inner.lock().unwrap();
        let idx = inner.users.iter().position(|u| u.username == name)?;
        let user = inner.users.remove(idx);
        inner.password_hashes.remove(&name);
        Some(user)
    }

    fn create_session(&self, token_hash: &str, user_id: i64, expires_at: i64) {
        let mut inner = self.inner.lock().unwrap();
        let auth_epoch = inner.auth_epochs.get(&user_id).copied().unwrap_or(0);
        inner.sessions.insert(
            token_hash.to_string(),
            SessionRow {
                token_hash: token_hash.to_string(),
                user_id,
                created_at: now_ms(),
                expires_at,
                auth_epoch,
            },
        );
    }

    fn get_session(&self, token_hash: &str) -> Option<SessionRow> {
        self.inner.lock().unwrap().sessions.get(token_hash).cloned()
    }

    fn delete_session(&self, token_hash: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .remove(token_hash)
            .is_some()
    }

    fn delete_expired_sessions(&self) -> usize {
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap();
        let before = inner.sessions.len();
        inner.sessions.retain(|_, row| row.expires_at > now);
        before - inner.sessions.len()
    }

    fn get_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        // The mock stores a single logical user (progress rows carry no user
        // column in this fixture); route tests use one user at a time.
        let _ = user_id;
        self.inner
            .lock()
            .unwrap()
            .progress
            .iter()
            .find(|p| {
                p.book_id == book_id
                    && p.library_id == library_id
                    && format.map_or(true, |f| Some(f) == Some(p.format.as_str()))
            })
            .cloned()
    }

    fn list_progress_formats(
        &self,
        _user_id: i64,
        library_id: &str,
        book_id: i64,
    ) -> Vec<ProgressRow> {
        self.inner
            .lock()
            .unwrap()
            .progress
            .iter()
            .filter(|p| p.book_id == book_id && p.library_id == library_id)
            .cloned()
            .collect()
    }

    fn list_progress(&self, _user_id: i64, library_id: &str, limit: u32) -> Vec<ProgressRow> {
        let limit = limit.clamp(1, 500) as usize;
        let mut rows: Vec<ProgressRow> = self
            .inner
            .lock()
            .unwrap()
            .progress
            .iter()
            .filter(|p| p.library_id == library_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        rows.truncate(limit);
        rows
    }

    fn upsert_progress(
        &self,
        _user_id: i64,
        library_id: &str,
        book_id: i64,
        input: &ProgressInput,
    ) -> UpsertProgressResult {
        let mut inner = self.inner.lock().unwrap();
        // Mutation-history duplicate check.
        if let Some(mid) = &input.mutation_id {
            if inner.processed_mutations.iter().any(|m| m == mid) {
                let existing = inner
                    .progress
                    .iter()
                    .find(|p| {
                        p.book_id == book_id
                            && p.library_id == library_id
                            && p.format == input.format
                    })
                    .cloned();
                return UpsertProgressResult {
                    progress: existing,
                    applied: true,
                    reason: Some("duplicate".into()),
                };
            }
        }
        // Deletion-generation resurrect guard.
        let deletion_key = (
            _user_id_label(),
            library_id.to_string(),
            book_id,
            input.format.clone(),
        );
        let deletion_seq = inner
            .progress_deletions
            .get(&deletion_key)
            .map(|(seq, _)| *seq)
            .unwrap_or(0);
        let existing_index = inner.progress.iter().position(|p| {
            p.book_id == book_id && p.library_id == library_id && p.format == input.format
        });
        if existing_index.is_none() && deletion_seq > 0 && !input.force {
            let fresh = input
                .base_deletion_seq
                .map_or(false, |base| base >= deletion_seq);
            if !fresh {
                return UpsertProgressResult {
                    progress: None,
                    applied: false,
                    reason: Some("deleted".into()),
                };
            }
        }
        if let Some(mutation) = &input.mutation_id {
            inner.processed_mutations.push(mutation.clone());
            if inner.processed_mutations.len() > 500 {
                let drop = inner.processed_mutations.len() - 500;
                inner.processed_mutations.drain(0..drop);
            }
        }
        let now = now_ms();
        match existing_index {
            Some(index) => {
                let current = &mut inner.progress[index];
                // baseRevision conflict: monotonic merge, no server_seq bump.
                if let Some(base) = input.base_revision {
                    if base != current.server_seq && !input.force {
                        let merged = UpsertProgressResult {
                            progress: Some(ProgressRow {
                                furthest_percentage: current
                                    .furthest_percentage
                                    .max(input.percentage.unwrap_or(0.0))
                                    .min(100.0),
                                finished: current.finished || input.finished,
                                updated_at: now,
                                ..current.clone()
                            }),
                            applied: false,
                            reason: Some("conflict".into()),
                        };
                        inner.progress[index] = merged.progress.clone().unwrap();
                        return merged;
                    }
                }
                current.location = input.location.clone();
                if let Some(p) = input.percentage {
                    current.percentage = p.clamp(0.0, 100.0);
                    current.furthest_percentage =
                        current.furthest_percentage.max(current.percentage);
                }
                current.finished = input.finished;
                if let Some(m) = &input.mutation_id {
                    current.last_mutation_id = Some(m.clone());
                }
                current.updated_at = input.client_ts.unwrap_or(now);
                current.server_seq += 1;
                UpsertProgressResult {
                    progress: Some(current.clone()),
                    applied: true,
                    reason: None,
                }
            }
            None => {
                let row = ProgressRow {
                    book_id,
                    library_id: library_id.to_string(),
                    format: input.format.clone(),
                    location: input.location.clone(),
                    percentage: input.percentage.unwrap_or(0.0).clamp(0.0, 100.0),
                    furthest_percentage: input.percentage.unwrap_or(0.0).clamp(0.0, 100.0),
                    finished: input.finished,
                    started_at: now,
                    updated_at: input.client_ts.unwrap_or(now),
                    server_seq: 1,
                    last_mutation_id: input.mutation_id.clone(),
                };
                inner.progress.push(row.clone());
                UpsertProgressResult {
                    progress: Some(row),
                    applied: true,
                    reason: None,
                }
            }
        }
    }

    fn delete_progress(
        &self,
        _user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.progress.len();
        inner.progress.retain(|p| {
            !(p.book_id == book_id
                && p.library_id == library_id
                && format.map_or(true, |f| p.format == f))
        });
        let removed = before != inner.progress.len();
        let now = now_ms();
        if format.is_some() {
            let key = (
                _user_id_label(),
                library_id.to_string(),
                book_id,
                format.unwrap().to_string(),
            );
            let seq = inner
                .progress_deletions
                .get(&key)
                .map(|(s, _)| *s)
                .unwrap_or(0)
                + 1;
            inner.progress_deletions.insert(key, (seq, now));
        } else {
            for fmt in ["EPUB", "PDF", "CBZ", "CBR"] {
                let key = (
                    _user_id_label(),
                    library_id.to_string(),
                    book_id,
                    fmt.to_string(),
                );
                let seq = inner
                    .progress_deletions
                    .get(&key)
                    .map(|(s, _)| *s)
                    .unwrap_or(0)
                    + 1;
                inner.progress_deletions.insert(key, (seq, now));
            }
        }
        removed
    }

    fn clear_progress(&self, _user_id: i64, library_id: &str) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.progress.len();
        inner.progress.retain(|p| p.library_id != library_id);
        let removed = before - inner.progress.len();
        let now = now_ms();
        let seq = inner
            .library_deletions
            .get(&(_user_id_label(), library_id.to_string()))
            .map(|(s, _)| *s)
            .unwrap_or(0)
            + 1;
        inner
            .library_deletions
            .insert((_user_id_label(), library_id.to_string()), (seq, now));
        removed
    }

    fn set_finished(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        finished: bool,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        let result = self.upsert_progress(
            user_id,
            library_id,
            book_id,
            &ProgressInput {
                format: format.unwrap_or("EPUB").to_string(),
                finished,
                force: true,
                ..Default::default()
            },
        );
        result.progress
    }

    fn progress_deletion(
        &self,
        _user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> ProgressDeletionInfo {
        let inner = self.inner.lock().unwrap();
        if let Some(format) = format {
            let key = (
                _user_id_label(),
                library_id.to_string(),
                book_id,
                format.to_string(),
            );
            let (seq, at) = inner
                .progress_deletions
                .get(&key)
                .copied()
                .unwrap_or((0, 0));
            ProgressDeletionInfo {
                seq: (seq > 0).then_some(seq),
                at: (at > 0).then_some(at),
            }
        } else {
            let mut best: Option<(i64, i64)> = None;
            for ((_, lib, book, _), value) in inner.progress_deletions.iter() {
                if *lib == library_id && *book == book_id {
                    best = Some(match best {
                        Some(current) if current.0 >= value.0 => current,
                        _ => *value,
                    });
                }
            }
            ProgressDeletionInfo {
                seq: best.map(|(seq, _)| seq).filter(|s| *s > 0),
                at: best.map(|(_, at)| at).filter(|a| *a > 0),
            }
        }
    }

    fn library_deletion(&self, _user_id: i64, library_id: &str) -> ProgressDeletionInfo {
        let inner = self.inner.lock().unwrap();
        let (seq, at) = inner
            .library_deletions
            .get(&(_user_id_label(), library_id.to_string()))
            .copied()
            .unwrap_or((0, 0));
        ProgressDeletionInfo {
            seq: (seq > 0).then_some(seq),
            at: (at > 0).then_some(at),
        }
    }

    fn hash_password(&self, password: &str) -> String {
        format!("mock${}$", sha256_hex(password))
    }

    fn verify_password(&self, password: &str, hash: &str) -> bool {
        hash == self.hash_password(password)
    }

    fn is_valid_password(&self, password: &str) -> bool {
        password.len() >= MIN_PASSWORD_LENGTH && password.len() <= 512
    }

    fn needs_initial_setup(&self, auth_enabled: bool) -> bool {
        auth_enabled && self.count_users_with_password() == 0
    }

    fn create_session_token(&self, user_id: i64) -> SessionToken {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        use base64::Engine;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let expires_at = now_ms() + SESSION_TTL_MS;
        self.create_session(&sha256_hex(&token), user_id, expires_at);
        SessionToken { token, expires_at }
    }

    fn resolve_session_token(&self, token: Option<&str>) -> Option<User> {
        let token = token?;
        let session = self.get_session(&sha256_hex(token))?;
        if session.expires_at <= now_ms() {
            return None;
        }
        let epoch = self.get_auth_epoch(session.user_id)?;
        if epoch != session.auth_epoch {
            return None;
        }
        self.get_user_by_id(session.user_id)
    }

    fn revoke_session_token(&self, token: Option<&str>) {
        if let Some(token) = token {
            self.delete_session(&sha256_hex(token));
        }
    }

    fn purge_expired_sessions(&self) {
        let _ = self.delete_expired_sessions();
    }

    fn session_cookie_header(&self, token: Option<&str>) -> String {
        let base = format!("{SESSION_COOKIE}=");
        let secure = if self.config.resolved().cookie_secure {
            "; Secure"
        } else {
            ""
        };
        let attrs = format!("Path=/; HttpOnly; SameSite=Lax{secure}");
        match token {
            None => format!("{base}; {attrs}; Max-Age=0"),
            Some(token) => format!("{base}{token}; {attrs}; Max-Age={}", SESSION_TTL_MS / 1000),
        }
    }

    fn login_rate_limited(&self, client_key: &str) -> bool {
        let now = now_ms();
        let inner = self.inner.lock().unwrap();
        inner
            .login_failures
            .get(client_key)
            .map(|(count, reset_at)| *count >= 10 && *reset_at > now)
            .unwrap_or(false)
    }

    fn authenticate_with_password(
        &self,
        client_key: &str,
        username: &str,
        password: &str,
    ) -> Option<User> {
        let credential = self.get_credential_by_username(username)?;
        let hash = credential.password_hash.clone()?;
        if !self.verify_password(password, &hash) {
            self.record_failure(client_key);
            return None;
        }
        self.clear_failures(client_key);
        self.get_user_by_id(credential.id)
    }

    fn parse_basic_auth(&self, header: &str) -> Option<(String, String)> {
        let space = header.find(' ')?;
        let scheme = &header[..space];
        let encoded = &header[space + 1..];
        if encoded.is_empty() || !scheme.eq_ignore_ascii_case("basic") {
            return None;
        }
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())?;
        let sep = decoded.find(':')?;
        let username = decoded[..sep].to_string();
        let password = decoded[sep + 1..].to_string();
        if username.is_empty() || password.is_empty() {
            return None;
        }
        Some((username, password))
    }

    fn authenticate_basic(&self, client_key: &str, header: &str) -> Option<User> {
        let (username, password) = self.parse_basic_auth(header)?;
        let throttle_key = format!("{client_key}|{}", username.to_lowercase());
        if self.login_rate_limited(&throttle_key) {
            return None;
        }
        self.authenticate_with_password(&throttle_key, &username, &password)
    }

    fn set_password_for_user(&self, username: &str, password: &str) -> Result<User, PasswordError> {
        if !self.is_valid_password(password) {
            return Err(PasswordError(format!(
                "Password must be at least {MIN_PASSWORD_LENGTH} characters"
            )));
        }
        let hash = self.hash_password(password);
        let credential = self.get_credential_by_username(username);
        match credential {
            None => self
                .create_user_with_password(username, &hash)
                .ok_or_else(|| PasswordError("Could not create user".into())),
            Some(credential) => {
                self.set_user_password(credential.id, Some(&hash));
                self.get_user_by_id(credential.id)
                    .ok_or_else(|| PasswordError("Could not update user".into()))
            }
        }
    }

    fn normalize_username(&self, raw: &str) -> String {
        self.normalize(raw)
    }

    fn is_valid_username(&self, raw: &str) -> bool {
        let name = self.normalize(raw);
        !name.is_empty() && name.chars().count() <= 40
    }

    fn normalize_library_id(&self, raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            "default".to_string()
        } else {
            trimmed.chars().take(200).collect()
        }
    }

    fn is_valid_location_for_format(&self, _format: &str, _location: Option<&str>) -> bool {
        true
    }

    fn sanitize_location_for_format(
        &self,
        _format: &str,
        location: Option<&str>,
    ) -> Option<String> {
        let value = location?;
        let truncated: String = value.chars().take(20000).collect();
        if truncated.is_empty() {
            None
        } else {
            Some(truncated)
        }
    }
}

impl MockUsers {
    fn record_failure(&self, client_key: &str) {
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap();
        let entry = inner
            .login_failures
            .entry(client_key.to_string())
            .or_insert((0, now + 15 * 60 * 1000));
        entry.0 += 1;
    }

    fn clear_failures(&self, client_key: &str) {
        self.inner.lock().unwrap().login_failures.remove(client_key);
    }
}

fn _user_id_label() -> i64 {
    1
}
