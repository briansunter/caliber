//! Port of `tests/cursor-pagination.test.ts`: cursor round-trips per sort,
//! invalid-cursor errors, rating correctness, FTS prefix search, tag/format
//! OR filters, series default ordering, and first-page totals.
//!
//! One shared fixture (like the TS `beforeAll`): tests run in parallel
//! threads against a single `CaliberDb`, which also exercises the pool.

mod common;

use caliber_common::types::{ListOptions, SortField, SortOrder};
use caliber_db::{CaliberDb, DbError};
use std::collections::HashSet;
use std::sync::OnceLock;

fn db() -> &'static CaliberDb {
    static FIXTURE: OnceLock<CaliberDb> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        // Leaked on purpose: the fixture outlives the initializer closure.
        let temp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
        let library = temp.path().join("library");
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();

        let conn = common::build_fixture_db(&library.join("metadata.db"), common::BOOKS);
        // Series fixture: series 1 "Cosmos" with varied series_index values.
        conn.execute("INSERT INTO series (id, name) VALUES (1, 'Cosmos')", [])
            .unwrap();
        for (book, index) in [(3i64, 7.5f64), (1, 2.0), (5, 4.25), (2, 0.5)] {
            conn.execute(
                "UPDATE books SET series_index = ?1 WHERE id = ?2",
                rusqlite::params![index, book],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO books_series_link (book, series) VALUES (?1, 1)",
                [book],
            )
            .unwrap();
        }
        // isbn fixture for the detail-query coverage in this binary.
        conn.execute(
            "INSERT INTO identifiers (book, type, val) VALUES (8, 'isbn', '978-3-16-148410-0')",
            [],
        )
        .unwrap();
        conn.close().unwrap();

        // Point the engine at the fixture. Env is process-global: this runs
        // exactly once (OnceLock) before any test body.
        std::env::set_var("CALIBRE_LIBRARY_PATH", &library);
        std::env::remove_var("CALIBRE_SNAPSHOT_FAULT");
        std::env::remove_var("CALIBER_DB_REFRESH_INTERVAL_MS");
        let config = caliber_common::Config::load_from(config_dir);
        let db = CaliberDb::open(config);
        assert!(db.init(), "fixture init must succeed");
        db
    })
}

fn opts() -> ListOptions {
    ListOptions::default()
}

fn list_ids(extra: ListOptions) -> Vec<i64> {
    db().list_books(&extra)
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect()
}

fn sorted_ids(sort_by: SortField, sort_order: SortOrder, limit: u32) -> Vec<i64> {
    db().list_books(&ListOptions {
        limit: Some(limit),
        sort_by: Some(sort_by),
        sort_order: Some(sort_order),
        ..opts()
    })
    .unwrap()
    .items
    .iter()
    .map(|b| b.id)
    .collect()
}

fn collect_pages(sort_by: SortField, sort_order: SortOrder, page_size: u32) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut guard = 0;
    loop {
        let page = db()
            .list_books(&ListOptions {
                cursor: cursor.clone(),
                limit: Some(page_size),
                sort_by: Some(sort_by),
                sort_order: Some(sort_order),
                ..opts()
            })
            .unwrap();
        ids.extend(page.items.iter().map(|b| b.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        guard += 1;
        assert!(guard < 100, "runaway pagination loop");
    }
    ids
}

fn rating_of(item: &caliber_common::types::BookListItem) -> i64 {
    item.rating.unwrap_or(0)
}

fn search_ids(query: &str) -> Vec<i64> {
    db().search_books(&opts(), query)
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect()
}

// --- 1. Cursor round-trips ------------------------------------------------

#[test]
fn title_asc_walk_covers_every_book_once() {
    let walked = collect_pages(SortField::Title, SortOrder::Asc, 5);
    assert_eq!(walked.len(), common::BOOKS.len());
    assert_eq!(
        walked.iter().collect::<HashSet<_>>().len(),
        common::BOOKS.len()
    );
    assert_eq!(walked, sorted_ids(SortField::Title, SortOrder::Asc, 200));
}

#[test]
fn title_desc_walk_covers_every_book_once() {
    let walked = collect_pages(SortField::Title, SortOrder::Desc, 5);
    assert_eq!(walked.len(), common::BOOKS.len());
    assert_eq!(
        walked.iter().collect::<HashSet<_>>().len(),
        common::BOOKS.len()
    );
    assert_eq!(walked, sorted_ids(SortField::Title, SortOrder::Desc, 200));
}

#[test]
fn title_non_ascii_survives_page_size_1_boundaries() {
    let ids = collect_pages(SortField::Title, SortOrder::Asc, 1);
    assert_eq!(ids, sorted_ids(SortField::Title, SortOrder::Asc, 200));
    // Titles whose JS-lowercased key differs from the SQL sort key are present.
    for expected in [15, 16, 17, 18, 19, 21, 22] {
        assert!(ids.contains(&expected), "missing non-ASCII book {expected}");
    }
}

#[test]
fn author_asc_walk_covers_every_book_once() {
    let walked = collect_pages(SortField::Author, SortOrder::Asc, 5);
    assert_eq!(walked.len(), common::BOOKS.len());
    assert_eq!(walked, sorted_ids(SortField::Author, SortOrder::Asc, 200));
}

#[test]
fn author_desc_walk_covers_every_book_once() {
    let walked = collect_pages(SortField::Author, SortOrder::Desc, 5);
    assert_eq!(walked.len(), common::BOOKS.len());
    assert_eq!(walked, sorted_ids(SortField::Author, SortOrder::Desc, 200));
}

#[test]
fn author_non_ascii_survives_page_size_1_boundaries() {
    let ids = collect_pages(SortField::Author, SortOrder::Asc, 1);
    assert_eq!(ids, sorted_ids(SortField::Author, SortOrder::Asc, 200));
}

#[test]
fn added_asc_two_pages_no_dups_ordering_holds() {
    let page1 = db()
        .list_books(&ListOptions {
            limit: Some(5),
            sort_by: Some(SortField::Added),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    assert!(page1.next_cursor.is_some());
    let page2 = db()
        .list_books(&ListOptions {
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            sort_by: Some(SortField::Added),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    let all: Vec<_> = page1.items.iter().chain(page2.items.iter()).collect();
    assert_eq!(all.iter().map(|b| b.id).collect::<HashSet<_>>().len(), 10);
    for pair in all.windows(2) {
        assert!(pair[0].timestamp <= pair[1].timestamp);
    }
}

#[test]
fn added_desc_two_pages_no_dups_ordering_holds() {
    let page1 = db()
        .list_books(&ListOptions {
            limit: Some(5),
            sort_by: Some(SortField::Added),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let page2 = db()
        .list_books(&ListOptions {
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            sort_by: Some(SortField::Added),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let all: Vec<_> = page1.items.iter().chain(page2.items.iter()).collect();
    assert_eq!(all.iter().map(|b| b.id).collect::<HashSet<_>>().len(), 10);
    for pair in all.windows(2) {
        assert!(pair[0].timestamp >= pair[1].timestamp);
    }
}

// --- 2. Rating sort -------------------------------------------------------

#[test]
fn rating_asc_two_pages_monotonic_across_boundary() {
    let page1 = db()
        .list_books(&ListOptions {
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    assert!(page1.next_cursor.is_some());
    let page2 = db()
        .list_books(&ListOptions {
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    let all: Vec<_> = page1.items.iter().chain(page2.items.iter()).collect();
    assert_eq!(all.iter().map(|b| b.id).collect::<HashSet<_>>().len(), 10);
    for pair in all.windows(2) {
        assert!(rating_of(pair[0]) <= rating_of(pair[1]));
    }
    assert!(rating_of(page1.items.last().unwrap()) <= rating_of(&page2.items[0]));
}

#[test]
fn rating_desc_two_pages_monotonic_across_boundary() {
    let page1 = db()
        .list_books(&ListOptions {
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    assert!(page1.next_cursor.is_some());
    let page2 = db()
        .list_books(&ListOptions {
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let all: Vec<_> = page1.items.iter().chain(page2.items.iter()).collect();
    assert_eq!(all.iter().map(|b| b.id).collect::<HashSet<_>>().len(), 10);
    for pair in all.windows(2) {
        assert!(rating_of(pair[0]) >= rating_of(pair[1]));
    }
    assert!(rating_of(page1.items.last().unwrap()) >= rating_of(&page2.items[0]));
}

#[test]
fn rating_all_pages_contain_exactly_all_books_no_dups() {
    let mut ids: Vec<i64> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = db()
            .list_books(&ListOptions {
                cursor: cursor.clone(),
                limit: Some(3),
                sort_by: Some(SortField::Rating),
                sort_order: Some(SortOrder::Asc),
                ..opts()
            })
            .unwrap();
        ids.extend(page.items.iter().map(|b| b.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(ids.len(), common::BOOKS.len());
    assert_eq!(
        ids.iter().collect::<HashSet<_>>().len(),
        common::BOOKS.len()
    );
}

#[test]
fn rating_desc_highest_rated_first() {
    let result = db()
        .list_books(&ListOptions {
            limit: Some(10),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let first = &result.items[0];
    assert_eq!(first.id, 1);
    assert_eq!(first.rating, Some(10));
}

#[test]
fn rating_asc_unrated_books_appear_before_rated() {
    // BOOKS ratings: 1=10, 2=8, 3=8, 4=6, 5=6, 8=4, 9=2; unrated (13 books,
    // incl. 11-22) sort as 0 first. TS passes this via min([]) === Infinity;
    // we use a page large enough (15) to contain both groups and assert the
    // same property directly.
    let result = db()
        .list_books(&ListOptions {
            limit: Some(20),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    assert_eq!(result.items.len(), 20);
    let items = &result.items;
    let last_zero = items
        .iter()
        .rposition(|b| rating_of(b) == 0)
        .expect("unrated books in the first 20");
    let first_rated = items
        .iter()
        .position(|b| rating_of(b) > 0)
        .expect("rated books in the first 20");
    assert!(last_zero < first_rated);
    assert_eq!(last_zero, 14, "15 unrated books sort first");
    assert_eq!(first_rated, 15);
    // Unrated books report rating 0 (not null) under the rating projection.
    assert_eq!(items[last_zero].rating, Some(0));
    // The first rated book in ASC order is the 2-star one (book 9).
    assert_eq!(items[first_rated].id, 9);
}

#[test]
fn rating_ties_broken_by_id_no_dups_across_pages() {
    let page1 = db()
        .list_books(&ListOptions {
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let page2 = db()
        .list_books(&ListOptions {
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Desc),
            ..opts()
        })
        .unwrap();
    let all: Vec<_> = page1.items.iter().chain(page2.items.iter()).collect();
    assert_eq!(all.iter().map(|b| b.id).collect::<HashSet<_>>().len(), 10);
    assert_eq!(all.iter().filter(|b| b.rating == Some(8)).count(), 2);
    assert_eq!(all.iter().filter(|b| b.rating == Some(6)).count(), 2);
}

#[test]
fn rating_asc_monotonic_ties_ordered_by_id() {
    let result = db()
        .list_books(&ListOptions {
            limit: Some(10),
            sort_by: Some(SortField::Rating),
            sort_order: Some(SortOrder::Asc),
            ..opts()
        })
        .unwrap();
    assert_eq!(result.items.len(), 10);
    for pair in result.items.windows(2) {
        let (prev, curr) = (pair[0].clone(), pair[1].clone());
        if rating_of(&prev) == rating_of(&curr) {
            assert!(
                prev.id < curr.id,
                "tie {} / {} not id-ordered",
                prev.id,
                curr.id
            );
        } else {
            assert!(rating_of(&prev) < rating_of(&curr));
        }
    }
}

// --- 3. Invalid cursors ---------------------------------------------------

#[test]
fn garbage_cursor_rejected() {
    let err = db()
        .list_books(&ListOptions {
            cursor: Some("not-valid-base64url-json!!!".into()),
            ..opts()
        })
        .unwrap_err();
    assert!(matches!(err, DbError::InvalidCursor), "got: {err:?}");
}

#[test]
fn cursor_decoding_to_non_json_rejected() {
    // base64url("this is not json") without padding.
    let err = db()
        .list_books(&ListOptions {
            cursor: Some("dGhpcyBpcyBub3QganNvbg".into()),
            ..opts()
        })
        .unwrap_err();
    assert!(matches!(err, DbError::InvalidCursor));
}

#[test]
fn garbage_cursor_rejected_for_all_sort_fields() {
    for sort_by in [
        SortField::Title,
        SortField::Author,
        SortField::Added,
        SortField::Rating,
        SortField::SeriesIndex,
    ] {
        let err = db()
            .list_books(&ListOptions {
                cursor: Some("garbage!!!".into()),
                sort_by: Some(sort_by),
                ..opts()
            })
            .unwrap_err();
        assert!(matches!(err, DbError::InvalidCursor), "{sort_by:?}");
    }
}

#[test]
fn garbage_cursor_rejected_from_search() {
    let err = db()
        .search_books(
            &ListOptions {
                cursor: Some("garbage!!!".into()),
                ..opts()
            },
            "Aardvark",
        )
        .unwrap_err();
    assert!(matches!(err, DbError::InvalidCursor));
}

#[test]
fn sort_type_mismatch_rejected() {
    // rating/series_index require a numeric cursor sort; text sorts require a
    // string. Cross-type cursors must 400 (DbError::InvalidCursor).
    let text_cursor =
        caliber_common::encode_book_cursor(1, &caliber_common::CursorSort::Text("abc".into()));
    let num_cursor =
        caliber_common::encode_book_cursor(1, &caliber_common::CursorSort::Number(3.0));
    for sort_by in [SortField::Rating, SortField::SeriesIndex] {
        let err = db()
            .list_books(&ListOptions {
                cursor: Some(text_cursor.clone()),
                sort_by: Some(sort_by),
                ..opts()
            })
            .unwrap_err();
        assert!(matches!(err, DbError::InvalidCursor), "{sort_by:?}");
    }
    for sort_by in [SortField::Title, SortField::Author, SortField::Added] {
        let err = db()
            .list_books(&ListOptions {
                cursor: Some(num_cursor.clone()),
                sort_by: Some(sort_by),
                ..opts()
            })
            .unwrap_err();
        assert!(matches!(err, DbError::InvalidCursor), "{sort_by:?}");
    }
}

// --- 4. FTS search --------------------------------------------------------

#[test]
fn fts_prefix_match_finds_book() {
    assert!(search_ids("Aardv").contains(&1));
}

#[test]
fn fts_full_word_match() {
    let ids = search_ids("Banana");
    assert!(ids.contains(&2));
    assert!(!ids.contains(&1));
}

#[test]
fn fts_multi_word_query_finds_book_matching_all_words() {
    assert!(search_ids("Jungle Book").contains(&10));
}

#[test]
fn fts_double_quotes_do_not_throw() {
    let result = db().search_books(&opts(), "\"Aardvark\"");
    assert!(result.is_ok());
}

#[test]
fn fts_special_characters_do_not_throw() {
    for query in [
        "AND OR",
        "book OR fire",
        "title NOT found",
        "fire*",
        "book AND dragon",
        "\"double \"\"quoted\"\" word\"",
    ] {
        assert!(db().search_books(&opts(), query).is_ok(), "{query}");
    }
}

#[test]
fn fts_empty_query_falls_back_to_full_list() {
    let result = db().search_books(&opts(), "   ").unwrap();
    assert!(!result.items.is_empty());
    assert_eq!(result.items.len(), common::BOOKS.len());
}

#[test]
fn fts_query_matching_nothing_returns_empty() {
    assert_eq!(search_ids("zzznomatch999").len(), 0);
}

#[test]
fn search_by_title_prefix_match() {
    let ids: Vec<i64> = db()
        .search_books_by_title("Honey", 10)
        .iter()
        .map(|b| b.id)
        .collect();
    assert!(ids.contains(&8));
}

#[test]
fn search_by_title_double_quotes_do_not_throw() {
    let results = db().search_books_by_title("\"Cherry\"", 10);
    assert!(!results.iter().any(|b| b.id == 999));
}

#[test]
fn search_by_title_special_chars_do_not_throw() {
    let _ = db().search_books_by_title("book AND fire OR dragon", 10);
}

// --- 5. Tag filter (OR logic) ----------------------------------------------

#[test]
fn list_all_tags_sorted_by_count_then_name() {
    let tags = db().list_all_tags(2000);
    let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["Fiction", "History", "Sci-Fi"]);
    let counts: Vec<i64> = tags.iter().map(|t| t.book_count).collect();
    assert_eq!(counts, [4, 3, 2]);
    assert_eq!(tags[0].id, 1);
    assert_eq!(tags[0].name, "Fiction");
    assert_eq!(tags[0].book_count, 4);
}

#[test]
fn no_tag_filter_returns_all_books() {
    assert_eq!(list_ids(opts()).len(), common::BOOKS.len());
}

#[test]
fn single_tag_filters_to_its_books() {
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![2],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![3],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [5, 6]
    );
}

#[test]
fn multiple_tags_union_without_duplicates() {
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 2],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 3],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn duplicate_nonexistent_invalid_tag_ids_handled() {
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 1, 2, 2],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 9999],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 0, -5],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![9999],
            ..opts()
        })
        .len(),
        0
    );
}

#[test]
fn tag_union_paginates_no_dups_monotonic_title_order() {
    let mut collected: Vec<i64> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = db()
            .list_books(&ListOptions {
                cursor: cursor.clone(),
                tag_ids: vec![1, 2],
                limit: Some(2),
                sort_by: Some(SortField::Title),
                sort_order: Some(SortOrder::Asc),
                ..opts()
            })
            .unwrap();
        collected.extend(page.items.iter().map(|b| b.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(collected, [1, 2, 3, 4, 5]);
    assert_eq!(
        collected.iter().collect::<HashSet<_>>().len(),
        collected.len()
    );
}

#[test]
fn search_composes_with_tag_filter() {
    assert_eq!(
        db().search_books(
            &ListOptions {
                tag_ids: vec![1],
                ..opts()
            },
            "Aardvark"
        )
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(
        db().search_books(
            &ListOptions {
                tag_ids: vec![2],
                ..opts()
            },
            "Aardvark"
        )
        .unwrap()
        .items
        .len(),
        0
    );
    assert_eq!(
        db().search_books(
            &ListOptions {
                tag_ids: vec![1, 3],
                ..opts()
            },
            "Dragon"
        )
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect::<Vec<_>>(),
        [4]
    );
    assert_eq!(
        db().search_books(
            &ListOptions {
                tag_ids: vec![3],
                ..opts()
            },
            "Dragon"
        )
        .unwrap()
        .items
        .len(),
        0
    );
}

// --- 6. Format filter (OR logic) -------------------------------------------

#[test]
fn list_all_formats_sorted_by_count_then_name() {
    let formats = db().list_all_formats();
    let names: Vec<&str> = formats.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["EPUB", "PDF", "MOBI"]);
    let counts: Vec<i64> = formats.iter().map(|f| f.book_count).collect();
    assert_eq!(counts, [4, 3, 2]);
}

#[test]
fn single_format_filters_to_its_books() {
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["PDF".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["MOBI".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [5, 6]
    );
}

#[test]
fn format_matching_case_insensitive() {
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["epub".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["Pdf".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [3, 4, 5]
    );
}

#[test]
fn multiple_formats_union_without_duplicates() {
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["EPUB".into(), "PDF".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["EPUB".into(), "MOBI".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn duplicate_nonexistent_invalid_formats_handled() {
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["EPUB".into(), "EPUB".into(), "PDF".into(), "pdf".into()],
            ..opts()
        }),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["EPUB".into(), "AZW3".into()],
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec![
                "EPUB".into(),
                "".into(),
                "  ".into(),
                "E-PUB".into(),
                "TOOLONGFORMATNAME".into()
            ],
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    assert_eq!(
        list_ids(ListOptions {
            formats: vec!["AZW3".into()],
            ..opts()
        })
        .len(),
        0
    );
}

#[test]
fn search_composes_with_format_filter() {
    assert_eq!(
        db().search_books(
            &ListOptions {
                formats: vec!["EPUB".into()],
                ..opts()
            },
            "Aardvark"
        )
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(
        db().search_books(
            &ListOptions {
                formats: vec!["PDF".into()],
                ..opts()
            },
            "Aardvark"
        )
        .unwrap()
        .items
        .len(),
        0
    );
    assert_eq!(
        db().search_books(
            &ListOptions {
                formats: vec!["EPUB".into(), "MOBI".into()],
                ..opts()
            },
            "Dragon"
        )
        .unwrap()
        .items
        .iter()
        .map(|b| b.id)
        .collect::<Vec<_>>(),
        [4]
    );
}

#[test]
fn tag_and_format_filters_compose() {
    // Fiction ∩ EPUB = {1,2,3,4}
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1],
            formats: vec!["EPUB".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [1, 2, 3, 4]
    );
    // Fiction ∩ MOBI = {}
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1],
            formats: vec!["MOBI".into()],
            ..opts()
        })
        .len(),
        0
    );
    // (Fiction ∪ History) ∩ PDF = {3,4,5}
    assert_eq!(
        list_ids(ListOptions {
            tag_ids: vec![1, 2],
            formats: vec!["PDF".into()],
            sort_by: Some(SortField::Title),
            ..opts()
        }),
        [3, 4, 5]
    );
}

#[test]
fn format_union_paginates_no_dups() {
    let mut collected: Vec<i64> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = db()
            .list_books(&ListOptions {
                cursor: cursor.clone(),
                formats: vec!["EPUB".into(), "PDF".into()],
                limit: Some(2),
                sort_by: Some(SortField::Title),
                sort_order: Some(SortOrder::Asc),
                ..opts()
            })
            .unwrap();
        collected.extend(page.items.iter().map(|b| b.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(collected, [1, 2, 3, 4, 5]);
    assert_eq!(
        collected.iter().collect::<HashSet<_>>().len(),
        collected.len()
    );
}

// --- 7. Series default ordering + totals -----------------------------------

#[test]
fn series_listing_defaults_to_series_index_order() {
    // Series 1 "Cosmos": book 2 (0.5), book 1 (2.0), book 5 (4.25),
    // book 3 (7.5).
    let result = db().list_books_by_series(1, &opts()).unwrap();
    let ids: Vec<i64> = result.items.iter().map(|b| b.id).collect();
    assert_eq!(ids, [2, 1, 5, 3]);
    assert!(result.next_cursor.is_none());

    // Explicit sort_by overrides the default.
    let explicit = db()
        .list_books_by_series(
            1,
            &ListOptions {
                sort_by: Some(SortField::Title),
                ..opts()
            },
        )
        .unwrap();
    let ids: Vec<i64> = explicit.items.iter().map(|b| b.id).collect();
    assert_eq!(ids, [1, 2, 3, 5]);

    // Cursor pagination through the default series order.
    let page1 = db()
        .list_books_by_series(
            1,
            &ListOptions {
                limit: Some(2),
                ..opts()
            },
        )
        .unwrap();
    assert_eq!(page1.items.iter().map(|b| b.id).collect::<Vec<_>>(), [2, 1]);
    let page2 = db()
        .list_books_by_series(
            1,
            &ListOptions {
                cursor: page1.next_cursor.clone(),
                limit: Some(2),
                ..opts()
            },
        )
        .unwrap();
    assert_eq!(page2.items.iter().map(|b| b.id).collect::<Vec<_>>(), [5, 3]);
}

#[test]
fn first_page_total_present_only_on_first_page() {
    let page1 = db()
        .list_books(&ListOptions {
            include_total: true,
            limit: Some(5),
            ..opts()
        })
        .unwrap();
    assert_eq!(page1.total, Some(common::BOOKS.len() as i64));
    let page2 = db()
        .list_books(&ListOptions {
            include_total: true,
            cursor: page1.next_cursor.clone(),
            limit: Some(5),
            ..opts()
        })
        .unwrap();
    assert_eq!(page2.total, None);

    // Total with filters, and through search.
    let tagged = db()
        .list_books(&ListOptions {
            include_total: true,
            tag_ids: vec![1, 2],
            ..opts()
        })
        .unwrap();
    assert_eq!(tagged.total, Some(5));
    let searched = db()
        .search_books(
            &ListOptions {
                include_total: true,
                ..opts()
            },
            "Aardvark",
        )
        .unwrap();
    assert_eq!(searched.total, Some(1));
}

#[test]
fn limit_clamps_one_to_two_hundred() {
    // limit 0 clamps to 1.
    let one = db()
        .list_books(&ListOptions {
            limit: Some(0),
            ..opts()
        })
        .unwrap();
    assert_eq!(one.items.len(), 1);
    // limit above the max clamps to 200 (whole fixture).
    let all = db()
        .list_books(&ListOptions {
            limit: Some(500),
            ..opts()
        })
        .unwrap();
    assert_eq!(all.items.len(), common::BOOKS.len());
    // Default limit is 100.
    let default = db().list_books(&opts()).unwrap();
    assert!(!default.has_more);
}

#[test]
fn detail_query_with_isbn() {
    let book = db().get_book(8).unwrap().expect("book 8 exists");
    assert_eq!(book.title, "Honey Bee");
    assert_eq!(book.isbn, "978-3-16-148410-0");
    assert_eq!(book.rating, Some(4));
    assert_eq!(book.formats.len(), 0); // book 8 has no data rows
    assert_eq!(book.authors.len(), 0);
    assert_eq!(book.pubdate, "2023-01-01 00:00:00+00:00");
    assert_eq!(book.path, "");
    let no_isbn = db().get_book(1).unwrap().expect("book 1 exists");
    assert_eq!(no_isbn.isbn, "");
    assert_eq!(no_isbn.formats, ["EPUB"]);
    assert!(db().get_book(9999).unwrap().is_none());
}
