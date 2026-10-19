//! Snapshot engine tests: generations/revisions, the CALIBER_SNAPSHOT_FAULT
//! hook, deferred refresh via leases, refresh callbacks, prev-generation
//! pruning, source-change detection (status + timer), pool concurrency, and
//! `save_library_config_with_validation`.
//!
//! These tests mutate process env vars, so every test holds `ENV_LOCK` for
//! its duration (tests in one binary share the process).

mod common;

use caliber_common::config::LibrarySelection;
use caliber_db::{save_library_config_with_validation, CaliberDb, DbError};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct TestEnv {
    _guard: MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    library: PathBuf,
    config_dir: PathBuf,
}

fn setup_fixture(book_count: usize) -> TestEnv {
    // Poison-tolerant: one failing test must not cascade PoisonErrors into
    // every other test that shares the env lock.
    let guard = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let library = temp.path().join("library");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::create_dir_all(&config_dir).unwrap();
    let books: Vec<common::BookSpec> = common::BOOKS
        .iter()
        .take(book_count)
        .map(|b| common::BookSpec {
            id: b.id,
            title: b.title,
            sort: b.sort,
            author_sort: b.author_sort,
            timestamp: b.timestamp,
            rating: b.rating,
        })
        .collect();
    let conn = common::build_fixture_db(&library.join("metadata.db"), &books);
    conn.close().unwrap();
    TestEnv {
        _guard: guard,
        _temp: temp,
        library,
        config_dir,
    }
}

fn open_db(env: &TestEnv) -> CaliberDb {
    std::env::set_var("CALIBRE_LIBRARY_PATH", &env.library);
    std::env::remove_var("CALIBER_SNAPSHOT_FAULT");
    std::env::remove_var("CALIBER_DB_REFRESH_INTERVAL_MS");
    let config = caliber_common::Config::load_from(env.config_dir.clone());
    CaliberDb::open(config)
}

fn config_entries_matching(env: &TestEnv, prefix: &str) -> Vec<String> {
    std::fs::read_dir(&env.config_dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(prefix))
        .collect()
}

#[test]
fn init_publishes_generation_one() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(!db.is_ready(), "not ready before init");
    assert!(db.init(), "init succeeds");
    assert!(db.is_ready());

    let status = db.snapshot_status();
    assert_eq!(status.generation, 1);
    assert_eq!(status.revision, 1);
    assert!(!status.stale);
    assert!(!status.refreshing);
    assert!(status.failed.is_none());

    // Published snapshot + sidecar exist; no tmp/prev/lock remnants.
    assert!(env.config_dir.join("metadata.db").exists());
    let sidecar = std::fs::read_to_string(env.config_dir.join("metadata.source.json")).unwrap();
    assert!(sidecar.contains("\"sourcePath\""));
    assert!(sidecar.contains("\"mtimeMs\""));
    assert!(sidecar.ends_with('\n'));
    assert!(config_entries_matching(&env, "metadata.db.gen-").is_empty());
    assert!(config_entries_matching(&env, "metadata.db.prev-").is_empty());
    assert!(!env.config_dir.join("snapshot.lock").exists());

    assert_eq!(db.get_book_count().unwrap(), 6);
    assert_eq!(db.snapshot_revision(), 1);
}

#[test]
fn fault_hook_aborts_first_publish_and_surfaces_failure() {
    let env = setup_fixture(6);
    std::env::set_var("CALIBRE_LIBRARY_PATH", &env.library);
    std::env::set_var("CALIBER_SNAPSHOT_FAULT", "1");
    let config = caliber_common::Config::load_from(env.config_dir.clone());
    let db = CaliberDb::open(config);

    assert!(!db.init(), "faulted init reports not-ready");
    let status = db.snapshot_status();
    assert_eq!(status.revision, 0);
    assert!(!status.refreshing);
    let failed = status.failed.expect("failure surfaced in status");
    assert!(failed.contains("CALIBER_SNAPSHOT_FAULT"), "got: {failed}");

    // Tmp cleaned, nothing published, queries refuse with NotReady.
    assert!(config_entries_matching(&env, "metadata.db.gen-").is_empty());
    assert!(!env.config_dir.join("metadata.db").exists());
    assert!(matches!(
        db.list_books(&Default::default()),
        Err(DbError::NotReady(_))
    ));

    // Clearing the hook lets a later init succeed.
    std::env::remove_var("CALIBER_SNAPSHOT_FAULT");
    assert!(db.init());
    assert_eq!(db.snapshot_status().revision, 1);
}

#[test]
fn fault_hook_preserves_published_generation() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(db.init());
    let before = db.list_books(&Default::default()).unwrap().items.clone();

    std::env::set_var("CALIBER_SNAPSHOT_FAULT", "1");
    let err = db.reconfigure_library().unwrap_err();
    match &err {
        DbError::Internal(msg) => assert!(msg.contains("CALIBER_SNAPSHOT_FAULT")),
        other => panic!("expected Internal fault error, got {other:?}"),
    }
    std::env::remove_var("CALIBER_SNAPSHOT_FAULT");

    // Published generation untouched, still queryable.
    assert_eq!(db.snapshot_status().revision, 1);
    let after = db.list_books(&Default::default()).unwrap().items;
    assert_eq!(
        before.iter().map(|b| b.id).collect::<Vec<_>>(),
        after.iter().map(|b| b.id).collect::<Vec<_>>()
    );
    assert!(config_entries_matching(&env, "metadata.db.gen-").is_empty());
    assert!(db.snapshot_status().failed.is_some());
    assert!(!db.snapshot_status().refreshing);
    assert!(!env.config_dir.join("snapshot.lock").exists());
}

#[test]
fn refresh_after_source_change_bumps_revision() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(db.init());

    // Modify the source library (adds a book).
    {
        let conn = Connection::open(env.library.join("metadata.db")).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
             VALUES (500, 'Fresh Add', 'Fresh Add', '2025-05-05 00:00:00+00:00', '2023-01-01 00:00:00+00:00', 1.0, '', '', 1, '', 0, '2025-05-05 00:00:00+00:00')",
            [],
        )
        .unwrap();
        conn.close().unwrap();
    }

    // Status detects the drift, refresh publishes a new generation.
    assert!(db.snapshot_status().stale, "status must report stale");
    db.reconfigure_library().unwrap();
    let status = db.snapshot_status();
    assert_eq!(status.revision, 2);
    assert!(!status.stale, "got: {status:?}");
    assert_eq!(db.get_book_count().unwrap(), 7);
    assert!(db.get_book(500).unwrap().is_some());
    // Superseded generations pruned once no leases/checkouts remain.
    assert!(config_entries_matching(&env, "metadata.db.prev-").is_empty());
}

#[test]
fn lease_defers_refresh_until_last_release() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(db.init());
    assert_eq!(db.snapshot_revision(), 1);

    let lease = db.acquire_snapshot_lease();
    let lease2 = lease.clone();
    assert_eq!(db.snapshot_status().generation, 1);

    // Refresh defers while leases are held.
    db.reconfigure_library().expect("deferral is not an error");
    assert_eq!(db.snapshot_revision(), 1, "deferred: no publish yet");
    assert!(db.snapshot_status().stale);

    drop(lease2);
    assert_eq!(db.snapshot_revision(), 1, "one lease reference remains");

    drop(lease);
    assert_eq!(db.snapshot_revision(), 2, "last release retriggers refresh");
    let status = db.snapshot_status();
    assert!(!status.stale, "status after deferred refresh: {status:?}");
}

#[test]
fn refresh_callback_fires_on_each_publish() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(db.init());

    let fired: &'static AtomicUsize = Box::leak(Box::new(AtomicUsize::new(0)));
    db.register_refresh_callback(Box::new(move || {
        fired.fetch_add(1, Ordering::SeqCst);
    }));

    db.reconfigure_library().unwrap();
    assert_eq!(fired.load(Ordering::SeqCst), 1);
    db.reconfigure_library().unwrap();
    assert_eq!(fired.load(Ordering::SeqCst), 2);
    assert_eq!(db.snapshot_revision(), 3);
}

#[test]
fn concurrent_readers_share_the_pool() {
    // Static fixture: created once under the env lock, then read from many
    // threads. The temp dirs are intentionally leaked so the snapshot files
    // outlive the guard scope (no lock is leaked).
    static DB: OnceLock<CaliberDb> = OnceLock::new();
    {
        let guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        DB.get_or_init(|| {
            let temp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
            let library = temp.path().join("library");
            std::fs::create_dir_all(&library).unwrap();
            let conn = common::build_fixture_db(&library.join("metadata.db"), common::BOOKS);
            conn.close().unwrap();
            std::env::set_var("CALIBRE_LIBRARY_PATH", &library);
            std::env::remove_var("CALIBER_SNAPSHOT_FAULT");
            std::env::remove_var("CALIBER_DB_REFRESH_INTERVAL_MS");
            let config = caliber_common::Config::load_from(temp.path().join("config"));
            let db = CaliberDb::open(config);
            assert!(db.init());
            db
        });
        drop(guard);
    }
    let db = DB.get().expect("initialized");
    let mut handles = Vec::new();
    for _ in 0..8 {
        handles.push(std::thread::spawn(move || {
            for _ in 0..20 {
                let page = db.list_books(&Default::default()).unwrap();
                assert_eq!(page.items.len(), 22);
            }
        }));
    }
    for handle in handles {
        handle.join().expect("no panics under concurrency");
    }
}

#[test]
fn snapshot_updated_iso_is_wellformed() {
    let env = setup_fixture(6);
    let db = open_db(&env);
    assert!(db.init());
    let iso = db.snapshot_updated_iso();
    let bytes = iso.as_bytes();
    assert_eq!(bytes.len(), 24, "got {iso}");
    assert_eq!(&iso[4..5], "-");
    assert_eq!(&iso[7..8], "-");
    assert_eq!(&iso[10..11], "T");
    assert_eq!(&iso[13..14], ":");
    assert_eq!(&iso[16..17], ":");
    assert_eq!(&iso[19..20], ".");
    assert_eq!(&iso[23..24], "Z");
    assert!(iso.starts_with("20") || iso.starts_with("1970"));
}

#[test]
fn refresh_timer_picks_up_source_change() {
    let env = setup_fixture(6);
    std::env::set_var("CALIBRE_LIBRARY_PATH", &env.library);
    std::env::set_var("CALIBER_DB_REFRESH_INTERVAL_MS", "5000"); // clamp minimum
    let config = caliber_common::Config::load_from(env.config_dir.clone());
    let db = CaliberDb::open(config);
    assert!(db.init());
    assert_eq!(db.snapshot_revision(), 1);

    {
        let conn = Connection::open(env.library.join("metadata.db")).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
             VALUES (501, 'Timer Add', 'Timer Add', '2025-06-06 00:00:00+00:00', '2023-01-01 00:00:00+00:00', 1.0, '', '', 1, '', 0, '2025-06-06 00:00:00+00:00')",
            [],
        )
        .unwrap();
        conn.close().unwrap();
    }

    std::thread::sleep(Duration::from_secs(7));
    assert!(
        db.snapshot_revision() >= 2,
        "timer should have refreshed (revision {})",
        db.snapshot_revision()
    );
    assert_eq!(db.get_book_count().unwrap(), 7);
}

#[test]
fn unsupported_source_schema_fails_init_with_clear_error() {
    let guard = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let temp = tempfile::tempdir().unwrap();
    let library = temp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let conn = Connection::open(library.join("metadata.db")).unwrap();
    conn.execute("CREATE TABLE unrelated (a)", []).unwrap();
    conn.close().unwrap();

    std::env::set_var("CALIBRE_LIBRARY_PATH", &library);
    std::env::remove_var("CALIBER_SNAPSHOT_FAULT");
    let config = caliber_common::Config::load_from(temp.path().join("config"));
    let db = CaliberDb::open(config);
    assert!(!db.init());
    let failed = db.snapshot_status().failed.expect("failure recorded");
    assert!(
        failed.contains("Unsupported Calibre database"),
        "got: {failed}"
    );
    assert!(failed.contains("books"));
    drop(guard);
}

#[test]
fn save_library_config_validation_paths() {
    let guard = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let temp = tempfile::tempdir().unwrap();
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();

    // (a) env override refuses selection.
    std::env::set_var("CALIBRE_LIBRARY_PATH", "/tmp/whatever");
    let config = caliber_common::Config::load_from(config_dir.clone());
    let err = save_library_config_with_validation(
        &config,
        LibrarySelection {
            database_path: Some("/tmp/whatever/metadata.db".into()),
            library_path: None,
            db_name: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("controlled by"), "got: {err}");

    // (b) garbage file is unreadable.
    std::env::remove_var("CALIBRE_LIBRARY_PATH");
    std::env::remove_var("CALIBRE_DB_NAME");
    let garbage = temp.path().join("garbage.db");
    std::fs::write(&garbage, b"this is definitely not a sqlite database").unwrap();
    let config = caliber_common::Config::load_from(config_dir.clone());
    let err = save_library_config_with_validation(
        &config,
        LibrarySelection {
            database_path: Some(garbage.to_string_lossy().to_string()),
            library_path: None,
            db_name: None,
        },
    )
    .unwrap_err();
    assert!(
        err.to_string()
            .starts_with("Could not read the Calibre database:"),
        "got: {err}"
    );

    // (c) a sqlite db without the Calibre tables names the missing tables.
    let partial = temp.path().join("partial.db");
    Connection::open(&partial)
        .unwrap()
        .execute("CREATE TABLE x (a)", [])
        .unwrap();
    let err = save_library_config_with_validation(
        &config,
        LibrarySelection {
            database_path: Some(partial.to_string_lossy().to_string()),
            library_path: None,
            db_name: None,
        },
    )
    .unwrap_err();
    assert!(
        err.to_string()
            .starts_with("This file is not a supported Calibre database; missing "),
        "got: {err}"
    );

    // (d) valid selection applies and the engine can serve it.
    let library = temp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let conn = common::build_fixture_db(&library.join("metadata.db"), &common::BOOKS[..3]);
    conn.close().unwrap();
    let status = save_library_config_with_validation(
        &config,
        LibrarySelection {
            database_path: Some(library.join("metadata.db").to_string_lossy().to_string()),
            library_path: None,
            db_name: None,
        },
    )
    .expect("valid library applies");
    assert_eq!(status.db_name, "metadata.db");
    // The engine canonicalizes the library path (macOS: /var -> /private/var),
    // so compare against the canonicalized location.
    let canonical_library = std::fs::canonicalize(&library).expect("library dir canonicalizes");
    assert_eq!(
        status.database_path,
        canonical_library
            .join("metadata.db")
            .to_string_lossy()
            .to_string()
    );
    assert!(!status.environment_override);

    let db = CaliberDb::open(config);
    assert!(db.init());
    assert_eq!(db.get_book_count().unwrap(), 3);

    // (e) selecting the snapshot inside the config cache is refused.
    let err = save_library_config_with_validation(
        &caliber_common::Config::load_from(config_dir.clone()),
        LibrarySelection {
            database_path: Some(config_dir.join("metadata.db").to_string_lossy().to_string()),
            library_path: None,
            db_name: None,
        },
    )
    .unwrap_err();
    assert!(
        err.to_string()
            .contains("must be outside Caliber's cache directory"),
        "got: {err}"
    );
    drop(db);
    drop(guard);
}

#[test]
fn ratings_fixture_projection_facts() {
    // Sanity check on the rating fixture the cursor tests rely on: exactly
    // the TS rating distribution among books 1-10.
    let env = setup_fixture(10);
    let db = open_db(&env);
    assert!(db.init());
    let conn = Connection::open(env.config_dir.join("metadata.db")).unwrap();
    let projection: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_list_projection WHERE rating = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // Books 6, 7, 10 are unrated in the TS fixture.
    assert_eq!(projection, 3);
    let fts_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM books_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fts_rows, 10);
    let version: String = conn
        .query_row(
            "SELECT value FROM caliber_fts_meta WHERE key = 'fts_schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, "3");
}

#[test]
fn books_by_ids_covers_rating_link_shape() {
    let env = setup_fixture(10);
    let db = open_db(&env);
    assert!(db.init());
    let map = db.get_books_by_ids(&[1, 2, 3, 4, 5]);
    assert_eq!(map.len(), 5);
    assert_eq!(map[&1].rating, Some(10));
    assert_eq!(map[&2].rating, Some(8));
    assert_eq!(map[&3].rating, Some(8));
    assert_eq!(map[&4].rating, Some(6));
    assert_eq!(map[&5].rating, Some(6));
    assert_eq!(map[&1].tags, ["Fiction"]);
    let mut formats = map[&3].formats.clone();
    formats.sort();
    assert_eq!(formats, ["EPUB", "PDF"]);
}
