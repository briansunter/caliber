//! Detail queries, batched ids, the export stream, file-path containment,
//! and catalog/author helpers — against a fixture with authors, an isbn,
//! publishers/comments, and malicious `b.path` rows.

mod common;

use caliber_common::types::{CatalogId, CatalogKind, CatalogOptions, ListOptions, SortField};
use caliber_db::{CaliberDb, DbError};
use rusqlite::{params, Connection};
use std::sync::OnceLock;

struct Fixture {
    db: CaliberDb,
    library: std::path::PathBuf,
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        // Leaked on purpose: the fixture outlives the initializer closure.
        let temp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
        let library = temp.path().join("library");
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();

        let conn: Connection = common::build_fixture_db(&library.join("metadata.db"), common::BOOKS);
        // Author fixture: author 1 linked to book 1.
        conn.execute(
            "INSERT INTO authors (id, name, sort) VALUES (1, 'Alice Author', 'Author, Alice')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO books_authors_link (book, author) VALUES (1, 1)", [])
            .unwrap();
        // isbn for book 8; publisher + comments for book 1.
        conn.execute(
            "INSERT INTO identifiers (book, type, val) VALUES (8, 'isbn', '978-0-13-235088-4')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO publishers (id, name) VALUES (1, 'Pub Co')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO books_publishers_link (book, publisher) VALUES (1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comments (book, text) VALUES (1, 'Great read.')",
            [],
        )
        .unwrap();
        // Path probes: book 90 with a safe path and cover; book 91 with a
        // malicious b.path ("../evil") for the containment checks.
        for (id, title, path, has_cover, data_name) in [
            (90i64, "Path Probe", "", 1i64, "probe"),
            (91i64, "Evil Path", "../evil", 1, "evil"),
        ] {
            conn.execute(
                "INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
                 VALUES (?1, ?2, ?2, '2024-02-01 00:00:00+00:00', '2023-01-01 00:00:00+00:00', 1.0, '', ?3, 1, '', ?4, '2024-02-01 00:00:00+00:00')",
                params![id, title, path, has_cover],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?1, 'EPUB', 100, ?2)",
                params![id, data_name],
            )
            .unwrap();
        }
        conn.close().unwrap();

        std::env::set_var("CALIBRE_LIBRARY_PATH", &library);
        std::env::remove_var("CALIBER_SNAPSHOT_FAULT");
        std::env::remove_var("CALIBER_DB_REFRESH_INTERVAL_MS");
        let config = caliber_common::Config::load_from(config_dir);
        let db = CaliberDb::open(config);
        assert!(db.init());
        Fixture {
            db,
            library: library.to_path_buf(),
        }
    })
}

const TOTAL_BOOKS: usize = common::BOOKS.len() + 2; // 22 + books 90, 91

#[test]
fn book_count_and_stats() {
    let f = fixture();
    assert_eq!(f.db.get_book_count().unwrap(), TOTAL_BOOKS as i64);
    let stats = f.db.get_library_stats().unwrap();
    assert_eq!(stats.total_books, TOTAL_BOOKS as i64);
    assert_eq!(stats.total_authors, 1);
    assert_eq!(stats.total_series, 0);
    assert_eq!(stats.total_tags, 3);
}

#[test]
fn detail_returns_all_fields() {
    let f = fixture();
    let book = f.db.get_book(1).unwrap().expect("book 1");
    assert_eq!(book.title, "Aardvark Tales");
    assert_eq!(book.authors, ["Alice Author"]);
    assert_eq!(book.publisher, Some("Pub Co".into()));
    assert_eq!(book.comments, Some("Great read.".into()));
    assert_eq!(book.isbn, "");
    assert_eq!(book.series, None);
    assert_eq!(book.tags, ["Fiction"]);
    assert_eq!(book.formats, ["EPUB"]);
    assert_eq!(book.rating, Some(10));
    assert_eq!(book.has_cover, false);
    assert_eq!(book.path, "");
    assert_eq!(book.uuid, Some("".into())); // detail rows always carry uuid

    let isbn = f.db.get_book(8).unwrap().expect("book 8");
    assert_eq!(isbn.isbn, "978-0-13-235088-4");
    assert!(f.db.get_book(424242).unwrap().is_none());
}

#[test]
fn batch_details_dedup_and_cap() {
    let f = fixture();
    let found = f.db.get_books_by_ids(&[8, 8, 1, 999]);
    assert_eq!(found.len(), 2);
    assert!(found.contains_key(&1) && found.contains_key(&8));

    // >500 ids: capped at 500 processed, still complete for this fixture.
    let many: Vec<i64> = (1..=600).collect();
    let capped = f.db.get_books_by_ids(&many);
    assert_eq!(capped.len(), TOTAL_BOOKS);
    assert_eq!(capped[&90].title, "Path Probe");
}

#[test]
fn stream_batches_are_id_ordered_without_uuid() {
    let f = fixture();
    let mut all = Vec::new();
    let mut last_id = 0i64;
    loop {
        let batch = f.db.stream_books_batch(last_id, 7).unwrap();
        if batch.is_empty() {
            break;
        }
        last_id = batch.last().unwrap().id;
        all.extend(batch);
        if all.len() > TOTAL_BOOKS + 7 {
            panic!("stream did not terminate");
        }
    }
    assert_eq!(all.len(), TOTAL_BOOKS);
    for pair in all.windows(2) {
        assert!(pair[0].id < pair[1].id);
    }
    // Stream rows omit uuid/last_modified (TS stream column set).
    assert!(all
        .iter()
        .all(|b| b.uuid.is_none() && b.last_modified.is_none()));
    assert!(all
        .iter()
        .any(|b| b.id == 1 && b.authors == ["Alice Author"]));

    // batch_size clamps to 1.
    let single = f.db.stream_books_batch(0, 0).unwrap();
    assert_eq!(single.len(), 1);
}

#[test]
fn format_path_resolution_and_containment() {
    let f = fixture();
    // Book 1: data name "1.epub", b.path "" → library/1.epub.epub (the TS
    // join is `{d.name}.{ext}`; the cursor fixture stores names with the
    // extension, real Calibre stores them without).
    assert_eq!(
        f.db.book_format_path(1, "EPUB").unwrap(),
        f.library.join("1.epub.epub")
    );
    // Case-insensitive format lookup, lowercase extension.
    assert_eq!(
        f.db.book_format_path(1, "epub").unwrap(),
        f.library.join("1.epub.epub")
    );
    // Extension-less data name: probe → probe.epub.
    assert_eq!(
        f.db.book_format_path(90, "EPUB").unwrap(),
        f.library.join("probe.epub")
    );
    // Missing format row → None.
    assert!(f.db.book_format_path(1, "MOBI").is_none());
    // Malicious b.path escapes the library → None.
    assert!(f.db.book_format_path(91, "EPUB").is_none());
    // Unknown book → None.
    assert!(f.db.book_format_path(424242, "EPUB").is_none());
}

#[test]
fn cover_path_resolution_and_containment() {
    let f = fixture();
    assert_eq!(
        f.db.book_cover_path(90).unwrap(),
        f.library.join("cover.jpg")
    );
    assert!(f.db.book_cover_path(91).is_none()); // ../evil containment
    assert!(f.db.book_cover_path(1).is_none()); // has_cover = 0
}

#[test]
fn library_path_and_book_title() {
    let f = fixture();
    assert_eq!(f.db.library_path(), f.library);
    assert_eq!(f.db.book_title(1).unwrap(), "Aardvark Tales");
    assert!(f.db.book_title(424242).is_none());
}

#[test]
fn catalog_authors_series_tags_formats() {
    let f = fixture();
    let authors = f.db.list_authors(&CatalogOptions::default()).unwrap();
    assert_eq!(authors.items.len(), 1);
    assert_eq!(authors.items[0].id, CatalogId::Num(1));
    assert_eq!(authors.items[0].title, "Alice Author");
    assert_eq!(authors.items[0].book_count, 1);

    let tags = f.db.list_tags(&CatalogOptions::default()).unwrap();
    let titles: Vec<&str> = tags.items.iter().map(|t| t.title.as_str()).collect();
    // Titles keep the original case; the lowercase value is the sort key.
    assert_eq!(titles, ["Fiction", "History", "Sci-Fi"]);
    assert!(tags.next_cursor.is_none());

    // Formats CTE: id/title uppercase, bookCount distinct. Books 90/91 add
    // two EPUB rows on top of the cursor fixture's four.
    let formats = f.db.list_formats(&CatalogOptions::default()).unwrap();
    assert!(formats
        .items
        .iter()
        .any(|e| e.id == CatalogId::Text("EPUB".into()) && e.book_count == 6));

    // Empty series catalog.
    let series = f.db.list_series(&CatalogOptions::default()).unwrap();
    assert_eq!(series.items.len(), 0);

    // Cursor pagination over tags (limit 2 → one more page).
    let page1 =
        f.db.list_tags(&CatalogOptions {
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page1.items.len(), 2);
    assert!(page1.next_cursor.is_some());
    let page2 =
        f.db.list_tags(&CatalogOptions {
            cursor: page1.next_cursor.clone(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page1.items.len() + page2.items.len(), 3);

    // Invalid catalog cursor.
    let err =
        f.db.list_tags(&CatalogOptions {
            cursor: Some("garbage!!!".into()),
            ..Default::default()
        })
        .unwrap_err();
    assert!(matches!(err, DbError::InvalidCursor));
}

#[test]
fn catalog_entry_lookup_by_kind() {
    let f = fixture();
    let author =
        f.db.get_catalog_entry(CatalogKind::Authors, &CatalogId::Num(1))
            .expect("author 1");
    assert_eq!(author.title, "Alice Author");
    assert_eq!(author.book_count, 1);

    let tag =
        f.db.get_catalog_entry(CatalogKind::Tags, &CatalogId::Num(2))
            .expect("tag 2");
    assert_eq!(tag.title, "History");
    assert_eq!(tag.book_count, 3);

    let format =
        f.db.get_catalog_entry(CatalogKind::Formats, &CatalogId::Text("EPUB".into()))
            .expect("EPUB");
    assert_eq!(format.book_count, 6);
    // Format lookup is uppercased.
    let lowercase =
        f.db.get_catalog_entry(CatalogKind::Formats, &CatalogId::Text("epub".into()))
            .expect("epub → EPUB");
    assert_eq!(lowercase.book_count, 6);

    assert!(f
        .db
        .get_catalog_entry(CatalogKind::Authors, &CatalogId::Num(4242))
        .is_none());
    assert!(f
        .db
        .get_catalog_entry(CatalogKind::Tags, &CatalogId::Text("not-a-number".into()))
        .is_none());
}

#[test]
fn search_by_author_and_author_info() {
    let f = fixture();
    let by_author: Vec<i64> =
        f.db.search_books_by_author("Alice", 10)
            .iter()
            .map(|b| b.id)
            .collect();
    assert_eq!(by_author, [1]);

    let info = f.db.get_author_by_name("Alice").expect("author found");
    assert_eq!(info.name, "Alice Author");
    assert_eq!(info.book_count, 1);
    assert!(f.db.get_author_by_name("Nobody Named This").is_none());
}

#[test]
fn by_author_by_tag_by_format_listings() {
    let f = fixture();
    let by_author =
        f.db.list_books_by_author(
            1,
            &ListOptions {
                sort_by: Some(SortField::Title),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        by_author.items.iter().map(|b| b.id).collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(by_author.items[0].authors, ["Alice Author"]);

    let by_tag =
        f.db.list_books_by_tag(
            2,
            &ListOptions {
                sort_by: Some(SortField::Title),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        by_tag.items.iter().map(|b| b.id).collect::<Vec<_>>(),
        [3, 4, 5]
    );

    let by_format =
        f.db.list_books_by_format(
            "mobi",
            &ListOptions {
                sort_by: Some(SortField::Title),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        by_format.items.iter().map(|b| b.id).collect::<Vec<_>>(),
        [5, 6]
    );
}
