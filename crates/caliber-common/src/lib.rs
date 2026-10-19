//! caliber-common: shared contracts for Caliber's Rust backend.
//!
//! Everything in this crate is a wire- or disk-compatibility contract with
//! the original TypeScript implementation (`src/lib/*.ts`) and the React
//! frontend, which is preserved unchanged. See `docs/rust-backend.md` for
//! the overall migration map.

pub mod config;
pub mod cursor;
pub mod signature;
pub mod types;
pub mod wyhash;

pub use config::{Config, ConfigError, LibraryConfigStatus, ResolvedConfig};
pub use cursor::{
    decode_book_cursor, decode_catalog_cursor, encode_book_cursor, encode_catalog_cursor,
    BookCursor, CursorSort,
};
pub use signature::{database_signature, is_same_signature, source_signature, SourceSignature};
pub use types::{
    book_sort_expression, AuthorInfo, BookListItem, BookWithDetails, CatalogEntry, CatalogId,
    CatalogKind, CatalogOptions, CursorPaginatedResult, FormatSummary, LibraryStats, ListOptions,
    SortField, SortOrder, TagSummary,
};
pub use wyhash::{bun_hash, canonical_library_id, library_hash36, to_base36};
