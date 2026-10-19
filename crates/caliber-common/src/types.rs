//! Wire-format data types shared by every Caliber crate.
//!
//! JSON field names here are a compatibility contract with the TypeScript
//! implementation and the React frontend (see `src/lib/calibre-optimized.ts`).
//! Do not rename fields without a migration plan.

use serde::{Deserialize, Serialize};

/// Sort keys accepted by the listing endpoints. Mirrors `SORT_FIELDS` in
/// `src/index.ts` / `calibre-optimized.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    Title,
    Author,
    Added,
    Rating,
    SeriesIndex,
}

impl SortField {
    pub fn as_str(&self) -> &'static str {
        match self {
            SortField::Title => "title",
            SortField::Author => "author",
            SortField::Added => "added",
            SortField::Rating => "rating",
            SortField::SeriesIndex => "series_index",
        }
    }

    pub fn parse(value: &str) -> SortField {
        match value {
            "author" => SortField::Author,
            "added" => SortField::Added,
            "rating" => SortField::Rating,
            "series_index" => SortField::SeriesIndex,
            _ => SortField::Title,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    Asc,
    Desc,
}

impl SortOrder {
    pub fn as_str(&self) -> &'static str {
        match self {
            SortOrder::Asc => "asc",
            SortOrder::Desc => "desc",
        }
    }

    pub fn is_asc(&self) -> bool {
        matches!(self, SortOrder::Asc)
    }
}

/// Normalized sort-key SQL expressions. The ORDER BY clause, the cursor
/// seek/tie-break predicates, and the expression indexes built on the
/// snapshot must use these exact strings (modulo the `b.`/`p.` aliases that
/// expression indexes must strip) so SQLite can seek instead of sorting.
pub fn book_sort_expression(sort_by: SortField) -> &'static str {
    match sort_by {
        SortField::Title => "COALESCE(NULLIF(lower(b.sort), ''), lower(b.title))",
        SortField::Author => "COALESCE(lower(b.author_sort), '')",
        SortField::Added => "COALESCE(b.timestamp, '')",
        // `p` is the `book_list_projection` alias used by the rating page
        // query; the matching index is idx_book_list_projection_rating
        // (rating, book) and the tie-break column is p.book.
        SortField::Rating => "p.rating",
        SortField::SeriesIndex => "COALESCE(b.series_index, 1)",
    }
}

/// Options for cursor-paginated book listings (`ListOptions` in
/// `calibre-optimized.ts`).
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub cursor: Option<String>,
    /// Caller-requested limit; implementations clamp to 1..=200
    /// (default 100). HTTP routes clamp to 1..=100 (default 50) before
    /// calling in, OPDS uses 1..=100 (default 50).
    pub limit: Option<u32>,
    pub sort_by: Option<SortField>,
    pub sort_order: Option<SortOrder>,
    /// Tag ids to filter by with OR semantics (dedup, > 0, max 50).
    pub tag_ids: Vec<i64>,
    /// Formats (uppercased, `^[A-Z0-9]{1,10}$`) to filter by with OR
    /// semantics (max 20).
    pub formats: Vec<String>,
    /// Exclude metadata-only books (no rows in `data`). Used by OPDS feeds.
    pub require_formats: bool,
    /// Include a cheap first-page COUNT(*) total (only when no cursor).
    pub include_total: bool,
}

impl ListOptions {
    pub fn sort_by(&self) -> SortField {
        self.sort_by.unwrap_or(SortField::Title)
    }

    pub fn sort_order(&self) -> SortOrder {
        self.sort_order.unwrap_or(SortOrder::Asc)
    }
}

/// Options for catalog (authors/series/tags/formats) listings.
#[derive(Debug, Clone, Default)]
pub struct CatalogOptions {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub sort_order: Option<SortOrder>,
}

/// A book row as serialized by `/api/books`, `/api/books/search`, OPDS feeds,
/// and the CLI. `snake_case` field names with `uuid` omitted when unknown —
/// exactly matching the TS `BookListItem` JSON.
#[derive(Debug, Clone, Serialize)]
pub struct BookListItem {
    pub id: i64,
    pub title: String,
    pub sort: Option<String>,
    pub author_sort: Option<String>,
    pub authors: Vec<String>,
    pub series: Option<String>,
    pub series_index: f64,
    pub tags: Vec<String>,
    pub formats: Vec<String>,
    pub has_cover: bool,
    pub pubdate: String,
    pub timestamp: String,
    pub rating: Option<i64>,
    /// Present only when the source row has a uuid (TS sets `undefined`
    /// otherwise, which JSON.stringify drops).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Always present in list items (TS `row.last_modified ?? null`).
    pub last_modified: Option<String>,
}

/// `/api/books/:id` response body. Extends [`BookListItem`] with
/// always-present detail fields.
#[derive(Debug, Clone, Serialize)]
pub struct BookWithDetails {
    pub id: i64,
    pub title: String,
    pub sort: Option<String>,
    pub author_sort: Option<String>,
    pub authors: Vec<String>,
    pub series: Option<String>,
    pub series_index: f64,
    pub tags: Vec<String>,
    pub formats: Vec<String>,
    pub has_cover: bool,
    pub pubdate: String,
    pub timestamp: String,
    pub rating: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    pub last_modified: Option<String>,
    pub publisher: Option<String>,
    pub comments: Option<String>,
    /// Empty string when the book has no isbn identifier (TS `?? ""`).
    pub isbn: String,
    pub path: String,
}

impl From<BookWithDetails> for BookListItem {
    fn from(d: BookWithDetails) -> BookListItem {
        BookListItem {
            id: d.id,
            title: d.title,
            sort: d.sort,
            author_sort: d.author_sort,
            authors: d.authors,
            series: d.series,
            series_index: d.series_index,
            tags: d.tags,
            formats: d.formats,
            has_cover: d.has_cover,
            pubdate: d.pubdate,
            timestamp: d.timestamp,
            rating: d.rating,
            uuid: d.uuid,
            last_modified: d.last_modified,
        }
    }
}

/// Cursor-paginated envelope. Note the intentionally mixed casing:
/// `nextCursor`/`hasMore` are camelCase in the TS API.
#[derive(Debug, Clone, Serialize)]
pub struct CursorPaginatedResult<T> {
    pub items: Vec<T>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    /// Present on first pages only when `include_total` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

/// Catalog facet kinds with paged listings under `/api` and `/opds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogKind {
    Authors,
    Series,
    Tags,
    Formats,
}

impl CatalogKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogKind::Authors => "authors",
            CatalogKind::Series => "series",
            CatalogKind::Tags => "tags",
            CatalogKind::Formats => "formats",
        }
    }
}

/// Catalog id: numeric for authors/series/tags, uppercase format string for
/// formats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CatalogId {
    Num(i64),
    Text(String),
}

/// One entry of a catalog feed (`CatalogEntry` in TS).
#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub id: CatalogId,
    pub title: String,
    pub sort: String,
    #[serde(rename = "bookCount")]
    pub book_count: i64,
}

/// `/api/stats` response (camelCase, matching `getLibraryStats`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total_books: i64,
    pub total_authors: i64,
    pub total_series: i64,
    pub total_tags: i64,
}

/// `/api/tags` entry (`TagSummary`, camelCase `bookCount`).
#[derive(Debug, Clone, Serialize)]
pub struct TagSummary {
    pub id: i64,
    pub name: String,
    #[serde(rename = "bookCount")]
    pub book_count: i64,
}

/// `/api/formats` entry (`FormatSummary`).
#[derive(Debug, Clone, Serialize)]
pub struct FormatSummary {
    pub name: String,
    #[serde(rename = "bookCount")]
    pub book_count: i64,
}

/// `getAuthorByName` result.
#[derive(Debug, Clone, Serialize)]
pub struct AuthorInfo {
    pub name: String,
    #[serde(rename = "bookCount")]
    pub book_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_list_item_json_shape() {
        let item = BookListItem {
            id: 1,
            title: "T".into(),
            sort: None,
            author_sort: None,
            authors: vec!["A".into()],
            series: None,
            series_index: 1.0,
            tags: vec![],
            formats: vec!["EPUB".into()],
            has_cover: false,
            pubdate: "2020-01-01T00:00:00+00:00".into(),
            timestamp: "2020-01-01T00:00:00+00:00".into(),
            rating: None,
            uuid: None,
            last_modified: None,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["author_sort"], serde_json::Value::Null);
        assert!(json.get("uuid").is_none());
        assert!(json.get("last_modified").is_some());
        assert_eq!(json["series_index"], 1.0);
    }

    #[test]
    fn paginated_result_uses_camel_case() {
        let r = CursorPaginatedResult {
            items: vec![1i64],
            next_cursor: Some("cur".into()),
            has_more: false,
            total: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"nextCursor\":\"cur\""));
        assert!(json.contains("\"hasMore\":false"));
        assert!(!json.contains("total"));
    }
}
