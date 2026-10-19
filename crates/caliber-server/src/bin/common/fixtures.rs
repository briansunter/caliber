//! In-memory fixtures powering the CLI/MCP module unit tests (no database
//! files, no network, no real library access).

use caliber_common::types::{
    AuthorInfo, BookListItem, BookWithDetails, CursorPaginatedResult, LibraryStats, ListOptions,
};
use std::collections::HashMap;
use std::path::PathBuf;

use super::traits::{AuthUserInfo, CatalogSource, UserAdmin};

fn book(
    id: i64,
    title: &str,
    authors: &[&str],
    series: Option<&str>,
    series_index: f64,
    formats: &[&str],
) -> BookListItem {
    BookListItem {
        id,
        title: title.to_string(),
        sort: Some(title.to_string()),
        author_sort: authors.first().map(|a| a.to_string()),
        authors: authors.iter().map(|a| a.to_string()).collect(),
        series: series.map(|s| s.to_string()),
        series_index,
        tags: vec![],
        formats: formats.iter().map(|f| f.to_string()).collect(),
        has_cover: false,
        pubdate: "2020-01-01T00:00:00+00:00".to_string(),
        timestamp: "2020-01-02T00:00:00+00:00".to_string(),
        rating: None,
        uuid: Some(format!("urn-{id}")),
        last_modified: None,
    }
}

#[derive(Default)]
pub struct MockCatalog {
    pub books: Vec<BookListItem>,
    /// (book id, FORMAT) -> real file path for download/cover tests.
    pub format_paths: HashMap<(i64, String), PathBuf>,
    pub cover_paths: HashMap<i64, PathBuf>,
    pub source_exists: bool,
    pub ready: bool,
    pub inited: bool,
    /// When set, `get_book_count` fails (drives the health error path).
    pub count_fails: bool,
}

impl MockCatalog {
    pub fn with_default_books() -> MockCatalog {
        MockCatalog {
            books: vec![
                book(1, "Dune", &["Frank Herbert"], None, 1.0, &["EPUB"]),
                book(
                    2,
                    "Dune Messiah",
                    &["Frank Herbert"],
                    Some("Dune"),
                    2.0,
                    &["EPUB", "PDF"],
                ),
                book(3, "The Hobbit", &["J. R. R. Tolkien"], None, 1.0, &["EPUB"]),
                book(
                    4,
                    "The Fellowship of the Ring",
                    &["J. R. R. Tolkien"],
                    Some("The Lord of the Rings"),
                    1.0,
                    &["MOBI"],
                ),
            ],
            source_exists: true,
            ready: true,
            inited: false,
            format_paths: HashMap::new(),
            cover_paths: HashMap::new(),
            count_fails: false,
        }
    }
}

impl CatalogSource for MockCatalog {
    fn init(&self) -> bool {
        true
    }
    fn is_ready(&self) -> bool {
        self.ready
    }
    fn get_library_stats(&self) -> Result<LibraryStats, String> {
        let mut authors: Vec<String> = self.books.iter().flat_map(|b| b.authors.clone()).collect();
        authors.sort();
        authors.dedup();
        let mut series: Vec<&str> = self
            .books
            .iter()
            .filter_map(|b| b.series.as_deref())
            .collect();
        series.sort();
        series.dedup();
        Ok(LibraryStats {
            total_books: self.books.len() as i64,
            total_authors: authors.len() as i64,
            total_series: series.len() as i64,
            total_tags: 0,
        })
    }
    fn get_book_count(&self) -> Result<i64, String> {
        if self.count_fails {
            return Err("library not ready".to_string());
        }
        Ok(self.books.len() as i64)
    }
    fn list_books(
        &self,
        opts: &ListOptions,
    ) -> Result<CursorPaginatedResult<BookListItem>, String> {
        let mut sorted = self.books.clone();
        sorted.sort_by(|a, b| a.title.cmp(&b.title));
        let start = opts
            .cursor
            .as_deref()
            .and_then(|c| c.strip_prefix("mock:"))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = opts.limit.unwrap_or(100).clamp(1, 200) as usize;
        let end = (start + limit).min(sorted.len());
        let items: Vec<BookListItem> = sorted
            .get(start..end)
            .map(|s| s.to_vec())
            .unwrap_or_default();
        let has_more = end < sorted.len();
        Ok(CursorPaginatedResult {
            next_cursor: has_more.then(|| format!("mock:{end}")),
            has_more,
            total: if opts.include_total && start == 0 {
                Some(sorted.len() as i64)
            } else {
                None
            },
            items,
        })
    }
    fn search_books(
        &self,
        opts: &ListOptions,
        query: &str,
    ) -> Result<CursorPaginatedResult<BookListItem>, String> {
        let needle = query.to_lowercase();
        let mut all: Vec<BookListItem> = self
            .books
            .iter()
            .filter(|b| b.title.to_lowercase().contains(&needle))
            .cloned()
            .collect();
        all.sort_by(|a, b| a.title.cmp(&b.title));
        let limit = opts.limit.unwrap_or(100).clamp(1, 200) as usize;
        let has_more = all.len() > limit;
        all.truncate(limit);
        Ok(CursorPaginatedResult {
            items: all,
            next_cursor: has_more.then(|| "mock:1".to_string()),
            has_more,
            total: None,
        })
    }
    fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, String> {
        Ok(self
            .books
            .iter()
            .find(|b| b.id == id)
            .map(|b| BookWithDetails {
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
                publisher: None,
                comments: None,
                isbn: String::new(),
                path: format!("dir/{}", b.id),
            }))
    }
    fn stream_batch(&self, last_id: i64, batch_size: u32) -> Result<Vec<BookListItem>, String> {
        let mut batch: Vec<BookListItem> = self
            .books
            .iter()
            .filter(|b| b.id > last_id)
            .take(batch_size as usize)
            .cloned()
            .collect();
        batch.sort_by_key(|b| b.id);
        Ok(batch)
    }
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        let needle = title.to_lowercase();
        self.books
            .iter()
            .filter(|b| b.title.to_lowercase().contains(&needle))
            .take(limit as usize)
            .cloned()
            .collect()
    }
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        let needle = author.to_lowercase();
        self.books
            .iter()
            .filter(|b| b.authors.iter().any(|a| a.to_lowercase().contains(&needle)))
            .take(limit as usize)
            .cloned()
            .collect()
    }
    fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo> {
        let needle = name.to_lowercase();
        self.books
            .iter()
            .find(|b| b.authors.iter().any(|a| a.to_lowercase().contains(&needle)))
            .and_then(|b| b.authors.first().map(|a| (a, b.id)))
            .map(|(author, _)| AuthorInfo {
                name: author.clone(),
                book_count: self
                    .books
                    .iter()
                    .filter(|b| b.authors.contains(author))
                    .count() as i64,
            })
    }
    fn library_path(&self) -> PathBuf {
        PathBuf::from("/tmp/mock-library")
    }
    fn db_name(&self) -> String {
        "metadata.db".to_string()
    }
    fn source_db_exists(&self) -> bool {
        self.source_exists
    }
    fn book_format_path(&self, id: i64, format: &str) -> Option<PathBuf> {
        self.format_paths.get(&(id, format.to_uppercase())).cloned()
    }
    fn book_cover_path(&self, id: i64) -> Option<PathBuf> {
        self.cover_paths.get(&id).cloned()
    }
}

impl super::mcp_core::McpSource for MockCatalog {
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem> {
        CatalogSource::search_books_by_title(self, title, limit)
    }
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem> {
        CatalogSource::search_books_by_author(self, author, limit)
    }
    fn get_author_by_name(&self, name: &str) -> Option<super::mcp_core::AuthorSummary> {
        CatalogSource::get_author_by_name(self, name).map(|a| super::mcp_core::AuthorSummary {
            name: a.name,
            book_count: a.book_count,
        })
    }
    fn search_books_paged(&self, query: &str, limit: u32) -> Vec<BookListItem> {
        CatalogSource::search_books(
            self,
            &ListOptions {
                limit: Some(limit),
                ..Default::default()
            },
            query,
        )
        .map(|r| r.items)
        .unwrap_or_default()
    }
}

#[derive(Default)]
pub struct MockUsers {
    pub users: Vec<MockUser>,
    next_id: i64,
}

#[derive(Clone)]
pub struct MockUser {
    pub id: i64,
    pub username: String,
    pub has_password: bool,
    pub last_seen_at: i64,
}

impl MockUsers {
    pub fn with_users(entries: &[(&str, bool)]) -> MockUsers {
        let mut users = MockUsers {
            next_id: 0,
            users: vec![],
        };
        for (username, has_password) in entries {
            users.next_id += 1;
            users.users.push(MockUser {
                id: users.next_id,
                username: username.to_string(),
                has_password: *has_password,
                last_seen_at: 42,
            });
        }
        users
    }
}

impl UserAdmin for MockUsers {
    fn get_credential(&self, username: &str) -> Option<(String, bool)> {
        let lower = username.trim().to_lowercase();
        self.users
            .iter()
            .find(|u| u.username.to_lowercase() == lower)
            .map(|u| (u.username.clone(), u.has_password))
    }
    fn list_auth_users(&self) -> Vec<AuthUserInfo> {
        self.users
            .iter()
            .map(|u| AuthUserInfo {
                id: u.id,
                username: u.username.clone(),
                has_password: u.has_password,
                last_seen_at: u.last_seen_at,
            })
            .collect()
    }
    fn delete_user(&self, username: &str) -> Option<String> {
        let lower = username.trim().to_lowercase();
        self.users
            .iter()
            .find(|u| u.username.to_lowercase() == lower)
            .map(|u| u.username.clone())
    }
    fn set_password_for_user(
        &self,
        username: &str,
        password: &str,
    ) -> Result<(i64, String), String> {
        if password.chars().count() < self.min_password_length() {
            return Err(format!(
                "Password must be at least {} characters",
                self.min_password_length()
            ));
        }
        let lower = username.trim().to_lowercase();
        match self
            .users
            .iter()
            .find(|u| u.username.to_lowercase() == lower)
        {
            Some(existing) => Ok((existing.id, existing.username.clone())),
            None => {
                let new_id = self.users.iter().map(|u| u.id).max().unwrap_or(0) + 1;
                Ok((new_id, username.to_string()))
            }
        }
    }
}
