//! Integration tests for `UserDb` — ported from the TS behavior in
//! `src/lib/user-db.ts` plus the contract's required suites: the
//! upsert_progress causal-revision protocol, location validation, and the
//! legacy users.db migration. All fixtures live in tempdirs.

use caliber_user::{
    is_valid_location_for_format, is_valid_username, normalize_library_id, normalize_username,
    sanitize_location_for_format, ProgressInput, UserDb,
};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::TempDir;

fn temp_db_path() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("users.db");
    (dir, path)
}

fn input(format: &str) -> ProgressInput {
    ProgressInput {
        format: format.to_string(),
        ..ProgressInput::default()
    }
}

fn user(db: &UserDb, name: &str) -> caliber_user::User {
    db.get_or_create_user(name).expect("user")
}

fn write(
    db: &UserDb,
    user_id: i64,
    lib: &str,
    book: i64,
    mut input: ProgressInput,
) -> caliber_user::UpsertProgressResult {
    if input.format.is_empty() {
        input.format = "EPUB".to_string();
    }
    db.upsert_progress(user_id, lib, book, &input)
}

fn raw_count(path: &Path, sql: &str) -> i64 {
    let conn = Connection::open(path).expect("open fixture");
    conn.query_row(sql, [], |r| r.get(0)).expect("count")
}

// --- schema / open ---------------------------------------------------------

#[test]
fn open_creates_schema_wal_and_reopens() {
    let (dir, path) = temp_db_path();
    {
        let db = UserDb::open_at(&path);
        let alice = user(&db, "alice");
        assert!(alice.id > 0);
    }
    let mode: String = {
        let conn = Connection::open(&path).unwrap();
        conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(mode, "wal");
    // Reopen: same DB, user preserved, migration is a no-op.
    let db = UserDb::open_at(&path);
    let found = db
        .get_user_by_username("Alice")
        .expect("user survives reopen");
    assert_eq!(found.username, "alice");
    assert_eq!(raw_count(&path, "SELECT COUNT(*) FROM users"), 1);
    drop(db);
    dir.close().ok();
}

static ENV_MUTEX: Mutex<()> = Mutex::new(());

#[test]
fn open_respects_config_dir_and_env_override() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let config_dir = dir.path().join("config");
    let config = caliber_common::Config::load_from(config_dir.clone());
    std::env::remove_var("CALIBER_USER_DB_PATH");
    let db = UserDb::open(&config);
    user(&db, "config-dir-user");
    assert!(config_dir.join("users.db").exists());

    let other = dir.path().join("elsewhere").join("users.db");
    std::env::set_var("CALIBER_USER_DB_PATH", &other);
    let db2 = UserDb::open(&config);
    user(&db2, "env-user");
    assert!(other.exists());
    std::env::remove_var("CALIBER_USER_DB_PATH");
}

// --- users -------------------------------------------------------------------

#[test]
fn usernames_normalize_and_lookup_case_insensitively() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    assert_eq!(normalize_username("  Grace \t Hopper  "), "Grace Hopper");
    assert_eq!(normalize_username("   "), "");
    assert!(!is_valid_username("   "));
    assert!(is_valid_username("grace"));
    let created = db
        .get_or_create_user("  Grace \t Hopper  ")
        .expect("create");
    assert_eq!(created.username, "Grace Hopper");
    let found = db
        .get_user_by_username("grace hopper")
        .expect("case-insensitive");
    assert_eq!(found.id, created.id);
    assert_eq!(db.get_user_by_id(created.id).unwrap().id, created.id);
    assert!(db.get_user_by_username("nobody").is_none());
    assert!(db.get_or_create_user("   ").is_none());
    // last_seen_at bumps on later get_or_create (>= created timestamp).
    let again = db.get_or_create_user("Grace Hopper").unwrap();
    assert!(again.last_seen_at >= created.last_seen_at);
    // delete
    assert!(db.delete_user("GRACE HOPPER").is_some());
    assert!(db.get_user_by_username("grace hopper").is_none());
    assert!(db.delete_user("grace hopper").is_none());
}

#[test]
fn credentials_counts_and_listing() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    user(&db, "profile-only");
    assert_eq!(db.count_users_with_password(), 0);
    assert!(db
        .get_credential_by_username("profile-only")
        .expect("credential row")
        .password_hash
        .is_none());
    let created = db
        .create_user_with_password("admin", "not-a-real-hash")
        .expect("create with password");
    // Duplicate username maps to None (server pre-checks and returns 409).
    assert!(db.create_user_with_password("Admin", "x").is_none());
    let credential = db.get_credential_by_username("ADMIN").unwrap();
    assert_eq!(credential.id, created.id);
    assert_eq!(credential.password_hash.as_deref(), Some("not-a-real-hash"));
    assert_eq!(credential.auth_epoch, 0);
    assert_eq!(db.count_users_with_password(), 1);
    let users = db.list_auth_users();
    let admin = users.iter().find(|u| u.username == "admin").unwrap();
    assert!(admin.has_password);
    assert!(
        users
            .iter()
            .find(|u| u.username == "profile-only")
            .unwrap()
            .has_password
            == false
    );
    // ordered by username_lower
    let names: Vec<&str> = users.iter().map(|u| u.username.as_str()).collect();
    assert_eq!(names, ["admin", "profile-only"]);
    // rotation bumps epoch and revokes sessions
    db.create_session("hash-1", created.id, i64::MAX);
    db.set_user_password(created.id, Some("new-hash"));
    assert_eq!(db.get_auth_epoch(created.id), Some(1));
    assert_eq!(
        db.get_credential_by_username("admin")
            .unwrap()
            .password_hash
            .as_deref(),
        Some("new-hash")
    );
    assert_eq!(
        db.get_session("hash-1"),
        None,
        "rotation must revoke sessions"
    );
    assert_eq!(db.delete_sessions_for_user(created.id), 0);
    // clearing the password keeps the row, bumps the epoch again
    db.set_user_password(created.id, None);
    assert_eq!(db.count_users_with_password(), 0);
    assert_eq!(db.get_auth_epoch(created.id), Some(2));
    assert_eq!(db.get_auth_epoch(9999), None);
}

// --- upsert_progress protocol -------------------------------------------------

#[test]
fn initial_write_gets_server_seq_1() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    let result = db.upsert_progress(
        alice.id,
        "lib-1",
        7,
        &ProgressInput {
            format: "epub".into(),
            location: Some("epubcfi(/6/4)".into()),
            percentage: Some(12.5),
            base_revision: Some(0),
            ..ProgressInput::default()
        },
    );
    assert!(result.applied);
    assert_eq!(result.reason, None);
    let p = result.progress.expect("progress returned");
    assert_eq!(p.book_id, 7);
    assert_eq!(p.library_id, "lib-1");
    assert_eq!(p.format, "EPUB");
    assert_eq!(p.location.as_deref(), Some("epubcfi(/6/4)"));
    assert_eq!(p.percentage, 12.5);
    assert_eq!(p.furthest_percentage, 12.5);
    assert!(!p.finished);
    assert_eq!(p.server_seq, 1);
    assert_eq!(p.last_mutation_id, None);
    assert!(p.started_at > 0 && p.updated_at >= p.started_at);
    // Read it back through get_progress.
    let read = db
        .get_progress(alice.id, "lib-1", 7, Some("EPUB"))
        .expect("stored");
    assert_eq!(read.server_seq, 1);
    // Empty format is rejected before any write happens.
    let bad = db.upsert_progress(alice.id, "lib-1", 7, &input(""));
    assert!(!bad.applied);
    assert_eq!(bad.reason.as_deref(), Some("invalid-format"));
    assert!(bad.progress.is_none());
}

#[test]
fn fresh_writes_advance_server_seq() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    let mut r = write(
        &db,
        alice.id,
        "lib-1",
        1,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().server_seq, 1);
    r = write(
        &db,
        alice.id,
        "lib-1",
        1,
        ProgressInput {
            percentage: Some(20.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().server_seq, 2);
    // Null baseRevision (legacy) is an unconditional blind write.
    r = write(
        &db,
        alice.id,
        "lib-1",
        1,
        ProgressInput {
            percentage: Some(30.0),
            ..input("EPUB")
        },
    );
    let p = r.progress.unwrap();
    assert!(r.applied);
    assert_eq!(p.server_seq, 3);
    assert_eq!(p.percentage, 30.0);
    // Format-scoped: a second format starts its own row at seq 1.
    r = write(
        &db,
        alice.id,
        "lib-1",
        1,
        ProgressInput {
            percentage: Some(5.0),
            base_revision: Some(0),
            ..input("pdf")
        },
    );
    let p = r.progress.unwrap();
    assert_eq!(p.format, "PDF");
    assert_eq!(p.server_seq, 1);
}

#[test]
fn duplicate_mutation_id_is_idempotent_across_intervening_writes() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    let r1 = write(
        &db,
        alice.id,
        "lib-1",
        3,
        ProgressInput {
            mutation_id: Some("m-1".into()),
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r1.progress.as_ref().unwrap().server_seq, 1);
    let r2 = write(
        &db,
        alice.id,
        "lib-1",
        3,
        ProgressInput {
            mutation_id: Some("m-2".into()),
            percentage: Some(20.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert_eq!(r2.progress.as_ref().unwrap().server_seq, 2);
    // Replay of m-1 after an intervening write: duplicate, no seq bump, and
    // the current (m-2) row is returned untouched.
    let replay = write(
        &db,
        alice.id,
        "lib-1",
        3,
        ProgressInput {
            mutation_id: Some("m-1".into()),
            percentage: Some(99.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(replay.applied);
    assert_eq!(replay.reason.as_deref(), Some("duplicate"));
    let p = replay.progress.unwrap();
    assert_eq!(p.server_seq, 2);
    assert_eq!(p.percentage, 20.0);
    assert_eq!(p.last_mutation_id.as_deref(), Some("m-2"));
    // A duplicate replay after deletion returns duplicate with progress:null
    // (the duplicate check runs before the deletion guard).
    assert!(db.delete_progress(alice.id, "lib-1", 3, Some("EPUB")));
    let replay2 = write(
        &db,
        alice.id,
        "lib-1",
        3,
        ProgressInput {
            mutation_id: Some("m-1".into()),
            percentage: Some(1.0),
            ..input("EPUB")
        },
    );
    assert!(replay2.applied);
    assert_eq!(replay2.reason.as_deref(), Some("duplicate"));
    assert!(replay2.progress.is_none());
}

#[test]
fn legacy_last_mutation_slot_backfills_history() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        4,
        ProgressInput {
            mutation_id: Some("legacy-1".into()),
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    // Simulate a row written before the history table existed: wipe history,
    // leave only the single-slot last_mutation_id.
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute("DELETE FROM processed_mutations", []).unwrap();
    }
    let replay = write(
        &db,
        alice.id,
        "lib-1",
        4,
        ProgressInput {
            mutation_id: Some("legacy-1".into()),
            percentage: Some(50.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(replay.applied);
    assert_eq!(replay.reason.as_deref(), Some("duplicate"));
    assert_eq!(replay.progress.unwrap().percentage, 10.0);
    // The backfill inserted the mutation so future replays hit the table.
    assert_eq!(
        raw_count(&path, "SELECT COUNT(*) FROM processed_mutations"),
        1
    );
    // A *different* mutation id still applies normally.
    let next = write(
        &db,
        alice.id,
        "lib-1",
        4,
        ProgressInput {
            mutation_id: Some("legacy-2".into()),
            percentage: Some(15.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(next.applied);
    assert_eq!(next.progress.unwrap().server_seq, 2);
}

#[test]
fn base_revision_conflict_merges_monotonically() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            location: Some("epubcfi(/6/4)".into()),
            percentage: Some(50.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            location: Some("epubcfi(/6/8)".into()),
            percentage: Some(60.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );

    // Stale base (1) against current seq 2: conflict, resume point kept.
    let conflict = write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            location: Some("epubcfi(/stale)".into()),
            percentage: Some(40.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(!conflict.applied);
    assert_eq!(conflict.reason.as_deref(), Some("conflict"));
    let p = conflict.progress.unwrap();
    assert_eq!(p.server_seq, 2, "conflict must not bump server_seq");
    assert_eq!(p.percentage, 60.0, "resume point kept");
    assert_eq!(
        p.location.as_deref(),
        Some("epubcfi(/6/8)"),
        "location kept"
    );
    assert_eq!(p.furthest_percentage, 60.0);

    // Regressive furthest does not lower the high-water mark...
    let regressive = write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(!regressive.applied);
    assert_eq!(regressive.progress.unwrap().furthest_percentage, 60.0);
    // ...but forward progress and finished still advance monotonically.
    let forward = write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            percentage: Some(80.0),
            finished: true,
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(!forward.applied);
    assert_eq!(forward.reason.as_deref(), Some("conflict"));
    let p = forward.progress.unwrap();
    assert_eq!(p.furthest_percentage, 80.0);
    assert!(p.finished);
    assert_eq!(p.percentage, 60.0, "resume point still kept");
    assert_eq!(p.server_seq, 2);

    // A write with the correct base applies again.
    let ok = write(
        &db,
        alice.id,
        "lib-1",
        5,
        ProgressInput {
            percentage: Some(70.0),
            base_revision: Some(2),
            ..input("EPUB")
        },
    );
    assert!(ok.applied);
    assert_eq!(ok.progress.unwrap().server_seq, 3);
    // The ON CONFLICT branch keeps furthest monotonic too.
    let p = db.get_progress(alice.id, "lib-1", 5, Some("EPUB")).unwrap();
    assert_eq!(p.furthest_percentage, 80.0);
    assert_eq!(p.percentage, 70.0);
}

#[test]
fn deletion_generation_guards_resurrect() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        6,
        ProgressInput {
            percentage: Some(30.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert!(db.delete_progress(alice.id, "lib-1", 6, Some("EPUB")));
    assert!(db
        .get_progress(alice.id, "lib-1", 6, Some("EPUB"))
        .is_none());
    let info = db.progress_deletion(alice.id, "lib-1", 6, Some("EPUB"));
    let seq = info.seq.expect("tombstone exists");
    assert!(info.at.is_some());

    // Null baseDeletionSeq + covering deletion -> rejected.
    let rejected = write(
        &db,
        alice.id,
        "lib-1",
        6,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert!(!rejected.applied);
    assert_eq!(rejected.reason.as_deref(), Some("deleted"));
    assert!(rejected.progress.is_none());
    // Stale baseDeletionSeq (older than the tombstone) -> rejected.
    let stale = write(
        &db,
        alice.id,
        "lib-1",
        6,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(1),
            base_deletion_seq: Some(seq - 1),
            ..input("EPUB")
        },
    );
    assert!(!stale.applied);
    assert_eq!(stale.reason.as_deref(), Some("deleted"));
    // Fresh baseDeletionSeq resurrects (row restarts at server_seq 1).
    let resurrect = write(
        &db,
        alice.id,
        "lib-1",
        6,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(1),
            base_deletion_seq: Some(seq),
            ..input("EPUB")
        },
    );
    assert!(resurrect.applied);
    assert_eq!(resurrect.progress.unwrap().server_seq, 1);
    // force:true resurrects even without acknowledging the deletion.
    assert!(db.delete_progress(alice.id, "lib-1", 6, Some("EPUB")));
    let forced = write(
        &db,
        alice.id,
        "lib-1",
        6,
        ProgressInput {
            percentage: Some(20.0),
            force: true,
            ..input("EPUB")
        },
    );
    assert!(forced.applied);
    assert_eq!(forced.progress.unwrap().server_seq, 1);
}

#[test]
fn book_level_delete_tombstone_covers_all_formats() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        8,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-1",
        8,
        ProgressInput {
            percentage: Some(20.0),
            base_revision: Some(0),
            ..input("PDF")
        },
    );
    // No-format delete: book-level wildcard tombstone.
    assert!(db.delete_progress(alice.id, "lib-1", 8, None));
    assert_eq!(db.list_progress_formats(alice.id, "lib-1", 8).len(), 0);
    assert!(db
        .progress_deletion(alice.id, "lib-1", 8, Some("EPUB"))
        .seq
        .is_some());
    assert!(db
        .progress_deletion(alice.id, "lib-1", 8, Some("PDF"))
        .seq
        .is_some());
    assert!(db
        .progress_deletion(alice.id, "lib-1", 8, None)
        .seq
        .is_some());
    // Both formats blocked until acknowledged.
    for fmt in ["EPUB", "PDF"] {
        let rejected = write(
            &db,
            alice.id,
            "lib-1",
            8,
            ProgressInput {
                percentage: Some(5.0),
                base_revision: Some(1),
                ..input(fmt)
            },
        );
        assert!(!rejected.applied, "{fmt} should be blocked");
        assert_eq!(rejected.reason.as_deref(), Some("deleted"));
    }
    // Deleting nothing reports false without a tombstone.
    assert!(!db.delete_progress(alice.id, "lib-1", 999, None));
    assert!(db
        .progress_deletion(alice.id, "lib-1", 999, None)
        .seq
        .is_none());
    // ...and progress_deletion with no tombstones is all-null.
    let info = db.progress_deletion(alice.id, "lib-1", 12345, None);
    assert_eq!((info.seq, info.at), (None, None));
}

#[test]
fn clear_progress_tombstones_every_library_for_default() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "default",
        1,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-x",
        2,
        ProgressInput {
            percentage: Some(20.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-y",
        3,
        ProgressInput {
            percentage: Some(30.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(db.list_progress(alice.id, "lib-x", 500).len(), 1);

    // Clearing "default" removes every library (legacy pre-scoping behavior)
    // and writes a library-level tombstone per library plus "default".
    let removed = db.clear_progress(alice.id, "default");
    assert_eq!(removed, 3);
    assert_eq!(db.list_progress(alice.id, "lib-x", 500).len(), 0);
    assert_eq!(db.list_progress(alice.id, "lib-y", 500).len(), 0);
    for lib in ["default", "lib-x", "lib-y"] {
        assert!(
            db.library_deletion(alice.id, lib).seq.is_some(),
            "tombstone for {lib}"
        );
        let blocked = write(
            &db,
            alice.id,
            lib,
            9,
            ProgressInput {
                percentage: Some(1.0),
                base_revision: Some(0),
                ..input("EPUB")
            },
        );
        assert!(!blocked.applied, "{lib} writes blocked after clear");
        assert_eq!(blocked.reason.as_deref(), Some("deleted"));
    }
    // A fresh library deletion seq lets the write through again.
    let fresh = db.library_deletion(alice.id, "lib-x").seq.unwrap();
    let ok = write(
        &db,
        alice.id,
        "lib-x",
        9,
        ProgressInput {
            percentage: Some(1.0),
            base_revision: Some(0),
            base_deletion_seq: Some(fresh),
            ..input("EPUB")
        },
    );
    assert!(ok.applied);

    // Scoped clears only touch their own library.
    write(
        &db,
        alice.id,
        "lib-a",
        1,
        ProgressInput {
            percentage: Some(5.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-b",
        1,
        ProgressInput {
            percentage: Some(6.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(db.clear_progress(alice.id, "lib-a"), 1);
    assert!(db
        .get_progress(alice.id, "lib-b", 1, Some("EPUB"))
        .is_some());
    assert!(db.library_deletion(alice.id, "lib-a").seq.is_some());
    assert!(db.library_deletion(alice.id, "lib-b").seq.is_none());
    // Clearing with nothing to remove writes no tombstone.
    assert_eq!(db.clear_progress(alice.id, "lib-zzz"), 0);
    assert!(db.library_deletion(alice.id, "lib-zzz").seq.is_none());
}

#[test]
fn mutation_history_prunes_to_last_50() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    for i in 0..60 {
        let r = write(
            &db,
            alice.id,
            "lib-1",
            2,
            ProgressInput {
                mutation_id: Some(format!("m-{i}")),
                percentage: Some(i as f64),
                base_revision: Some(i),
                ..input("EPUB")
            },
        );
        assert!(r.applied);
    }
    assert_eq!(
        raw_count(&path, "SELECT COUNT(*) FROM processed_mutations"),
        50
    );
    // The newest 50 survive; the oldest were pruned.
    assert_eq!(
        raw_count(
            &path,
            "SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = 'm-0'"
        ),
        0
    );
    assert_eq!(
        raw_count(
            &path,
            "SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = 'm-59'"
        ),
        1
    );
}

// --- reads -------------------------------------------------------------------

#[test]
fn publication_level_read_prefers_finished_then_furthest() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        9,
        ProgressInput {
            percentage: Some(50.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-1",
        9,
        ProgressInput {
            percentage: Some(80.0),
            base_revision: Some(0),
            ..input("PDF")
        },
    );
    let best = db.get_progress(alice.id, "lib-1", 9, None).expect("row");
    assert_eq!(best.format, "PDF", "furthest wins");
    write(
        &db,
        alice.id,
        "lib-1",
        9,
        ProgressInput {
            percentage: Some(10.0),
            finished: true,
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    let best = db.get_progress(alice.id, "lib-1", 9, None).expect("row");
    assert_eq!(best.format, "EPUB", "finished wins");
    assert_eq!(db.list_progress_formats(alice.id, "lib-1", 9).len(), 2);
    assert!(db.get_progress(alice.id, "lib-1", 10, None).is_none());
    // Legacy back-compat: a "default" read falls back to rows in any library.
    write(
        &db,
        alice.id,
        "lib-other",
        11,
        ProgressInput {
            percentage: Some(5.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    let legacy = db
        .get_progress(alice.id, "default", 11, Some("EPUB"))
        .expect("legacy fallback");
    assert_eq!(legacy.library_id, "lib-other");
}

#[test]
fn list_progress_clamps_limit() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    for book in 1..=5 {
        write(
            &db,
            alice.id,
            "lib-1",
            book,
            ProgressInput {
                percentage: Some(book as f64),
                base_revision: Some(0),
                ..input("EPUB")
            },
        );
    }
    assert_eq!(
        db.list_progress(alice.id, "lib-1", 0).len(),
        1,
        "0 clamps to 1"
    );
    assert_eq!(db.list_progress(alice.id, "lib-1", 3).len(), 3);
    assert_eq!(db.list_progress(alice.id, "lib-1", 500).len(), 5);
    // Other libraries are not included.
    assert_eq!(db.list_progress(alice.id, "nope", 500).len(), 0);
}

#[test]
fn set_finished_semantics() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        12,
        ProgressInput {
            percentage: Some(40.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    let finished = db
        .set_finished(alice.id, "lib-1", 12, true, Some("EPUB"))
        .expect("row");
    assert!(finished.finished);
    assert_eq!(finished.percentage, 100.0);
    assert_eq!(finished.furthest_percentage, 100.0);
    assert_eq!(
        finished.server_seq, 1,
        "setFinished does not bump server_seq"
    );
    let unfinished = db
        .set_finished(alice.id, "lib-1", 12, false, Some("EPUB"))
        .expect("row");
    assert!(!unfinished.finished);
    // Resume percentage is unchanged by un-finishing.
    assert_eq!(unfinished.percentage, 100.0);
    assert_eq!(unfinished.furthest_percentage, 100.0);
    // Unknown row -> None; publication-level variant updates all formats.
    assert!(db
        .set_finished(alice.id, "lib-1", 999, true, None)
        .is_none());
    write(
        &db,
        alice.id,
        "lib-1",
        13,
        ProgressInput {
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    write(
        &db,
        alice.id,
        "lib-1",
        13,
        ProgressInput {
            percentage: Some(20.0),
            base_revision: Some(0),
            ..input("PDF")
        },
    );
    let all = db
        .set_finished(alice.id, "lib-1", 13, true, None)
        .expect("row");
    assert!(all.finished);
    assert_eq!(
        db.list_progress_formats(alice.id, "lib-1", 13)
            .iter()
            .filter(|p| p.finished)
            .count(),
        2
    );
}

// --- sanitization --------------------------------------------------------------

#[test]
fn upsert_sanitizes_location_format_percentage() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    // EPUB must not store a numeric page locator.
    let r = write(
        &db,
        alice.id,
        "lib-1",
        20,
        ProgressInput {
            location: Some("12".into()),
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().location, None);
    // PDF rejects a CFI locator.
    let r = write(
        &db,
        alice.id,
        "lib-1",
        21,
        ProgressInput {
            location: Some("epubcfi(/6/4)".into()),
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("PDF")
        },
    );
    assert_eq!(r.progress.unwrap().location, None);
    // A valid padded page number is stored verbatim (" 42 " -> valid, kept).
    let r = write(
        &db,
        alice.id,
        "lib-1",
        22,
        ProgressInput {
            location: Some(" 42 ".into()),
            percentage: Some(10.0),
            base_revision: Some(0),
            ..input("CBZ")
        },
    );
    assert_eq!(r.progress.unwrap().location.as_deref(), Some(" 42 "));
    // Percentages clamp to 0..=100; non-finite becomes 0.
    let r = write(
        &db,
        alice.id,
        "lib-1",
        23,
        ProgressInput {
            percentage: Some(-5.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().percentage, 0.0);
    let r = write(
        &db,
        alice.id,
        "lib-1",
        23,
        ProgressInput {
            percentage: Some(150.0),
            base_revision: Some(1),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().percentage, 100.0);
    let r = write(
        &db,
        alice.id,
        "lib-1",
        24,
        ProgressInput {
            percentage: Some(f64::NAN),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().percentage, 0.0);
    let r = write(
        &db,
        alice.id,
        "lib-1",
        25,
        ProgressInput {
            percentage: Some(1.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().percentage, 1.0);
    // Format is uppercased and truncated to 10 chars.
    let r = write(
        &db,
        alice.id,
        "lib-1",
        26,
        ProgressInput {
            percentage: Some(1.0),
            base_revision: Some(0),
            ..input("abcdefghijklmnop")
        },
    );
    assert_eq!(r.progress.unwrap().format, "ABCDEFGHIJ");
    // Library id normalizes ("" -> "default", trimmed, capped at 200).
    let r = write(
        &db,
        alice.id,
        "  ",
        27,
        ProgressInput {
            percentage: Some(1.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert_eq!(r.progress.unwrap().library_id, "default");
}

#[test]
fn location_validation_matrix() {
    // EPUB CFI shapes.
    assert!(is_valid_location_for_format("EPUB", None));
    assert!(is_valid_location_for_format(
        "EPUB",
        Some("epubcfi(/6/4!/4/10)")
    ));
    assert!(is_valid_location_for_format("EPUB", Some("/6/4")));
    assert!(is_valid_location_for_format("EPUB", Some("[loc]")));
    assert!(!is_valid_location_for_format("EPUB", Some("12")));
    assert!(!is_valid_location_for_format("EPUB", Some("page 12")));
    assert!(!is_valid_location_for_format("EPUB", Some("")));
    // Paged formats.
    for fmt in ["PDF", "CBZ", "CBR"] {
        assert!(is_valid_location_for_format(fmt, Some("1")));
        assert!(is_valid_location_for_format(fmt, Some(" 42 ")));
        assert!(is_valid_location_for_format(fmt, Some("144")));
        assert!(!is_valid_location_for_format(fmt, Some("0")));
        assert!(!is_valid_location_for_format(fmt, Some("-1")));
        assert!(!is_valid_location_for_format(fmt, Some("12abc")));
        assert!(!is_valid_location_for_format(fmt, Some("1e2")));
        assert!(!is_valid_location_for_format(fmt, Some("epubcfi(/6/4)")));
        assert!(!is_valid_location_for_format(fmt, Some("")));
        assert!(!is_valid_location_for_format(fmt, Some("12.0")));
    }
    // Unknown formats accept anything (mirrors TS).
    assert!(is_valid_location_for_format("MOBI", Some("anything")));
    assert!(is_valid_location_for_format("", Some("12")));
    // sanitizeLocationForFormat: null passthrough, empty -> null, cap 20000.
    assert_eq!(sanitize_location_for_format("EPUB", None), None);
    assert_eq!(sanitize_location_for_format("EPUB", Some("")), None);
    assert_eq!(
        sanitize_location_for_format("EPUB", Some("/6/4")),
        Some("/6/4".to_string())
    );
    assert_eq!(sanitize_location_for_format("EPUB", Some("5")), None);
    assert_eq!(
        sanitize_location_for_format("PDF", Some("5")),
        Some("5".to_string())
    );
    let long = "a".repeat(20_000);
    let valid_epub = format!("epubcfi({long})"); // 20009 chars -> capped at 20000
    let capped = sanitize_location_for_format("EPUB", Some(&valid_epub)).unwrap();
    assert_eq!(capped.len(), 20_000);
    assert!(capped.starts_with("epubcfi("));
}

// --- legacy migration -----------------------------------------------------------

fn create_legacy_user_db(path: &Path, progress_pk: &str) {
    let conn = Connection::open(path).expect("legacy fixture");
    conn.execute_batch(&format!(
        "CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          username_lower TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE progress (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          book_id INTEGER NOT NULL,
          format TEXT NOT NULL,
          location TEXT,
          percentage REAL NOT NULL DEFAULT 0,
          finished INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY {progress_pk}
        );"
    ))
    .expect("legacy schema");
    conn.execute(
        "INSERT INTO users (username, username_lower, created_at, last_seen_at) VALUES ('legacy', 'legacy', 0, 0)",
        [],
    )
    .expect("legacy user");
}

#[test]
fn legacy_users_db_migrates_in_place() {
    let (dir, path) = temp_db_path();
    create_legacy_user_db(&path, "(user_id, book_id)");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO progress (user_id, book_id, format, location, percentage, finished, started_at, updated_at)
             VALUES (1, 10, 'EPUB', '/6/4', 40.0, 0, 100, 2000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO progress (user_id, book_id, format, location, percentage, finished, started_at, updated_at)
             VALUES (1, 11, 'PDF', '5', 55.0, 1, 100, 3000)",
            [],
        )
        .unwrap();
    }

    let db = UserDb::open_at(&path);
    let legacy = db.get_user_by_username("legacy").expect("user preserved");
    // Rows preserved with the migration defaults.
    let epub = db
        .get_progress(legacy.id, "default", 10, Some("EPUB"))
        .expect("epub row");
    assert_eq!(epub.library_id, "default");
    assert_eq!(epub.percentage, 40.0);
    assert_eq!(
        epub.furthest_percentage, 40.0,
        "furthest backfilled from percentage"
    );
    assert_eq!(epub.server_seq, 0);
    assert_eq!(epub.location.as_deref(), Some("/6/4"));
    let pdf = db
        .get_progress(legacy.id, "default", 11, Some("PDF"))
        .expect("pdf row");
    assert!(pdf.finished);
    // PK rebuilt to the 4-column identity.
    {
        let conn = Connection::open(&path).unwrap();
        let pk: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('progress') WHERE pk > 0 ORDER BY pk")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(pk, vec!["user_id", "library_id", "book_id", "format"]);
        let user_cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('users')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(user_cols.contains(&"password_hash".to_string()));
        assert!(user_cols.contains(&"auth_epoch".to_string()));
    }
    // Pre-auth profile can be upgraded with a password (CLI `user passwd`).
    let credential = db.get_credential_by_username("legacy").unwrap();
    assert_eq!(credential.password_hash, None);
    assert_eq!(credential.auth_epoch, 0);
    // Reopening is stable (no rebuild, rows intact).
    drop(db);
    let db = UserDb::open_at(&path);
    assert!(db
        .get_progress(legacy.id, "default", 10, Some("EPUB"))
        .is_some());
    assert_eq!(raw_count(&path, "SELECT COUNT(*) FROM progress"), 2);
    // Writes against migrated rows work (blind write bumps seq from 0 to 1).
    let r = db.upsert_progress(
        legacy.id,
        "default",
        10,
        &ProgressInput {
            format: "EPUB".into(),
            percentage: Some(45.0),
            ..ProgressInput::default()
        },
    );
    assert!(r.applied);
    assert_eq!(r.progress.unwrap().server_seq, 1);
    drop(db);
    dir.close().ok();
}

#[test]
fn legacy_migration_keeps_most_recent_on_pk_collision() {
    let (dir, path) = temp_db_path();
    // A PK that allows two rows with the same (user, book, format) identity:
    // the rebuild must keep the most recently updated row.
    create_legacy_user_db(&path, "(user_id, updated_at)");
    {
        let conn = Connection::open(&path).unwrap();
        for (pct, updated) in [(25.0, 1000), (80.0, 2000)] {
            conn.execute(
                "INSERT INTO progress (user_id, book_id, format, location, percentage, finished, started_at, updated_at)
                 VALUES (1, 10, 'EPUB', NULL, ?, 0, 100, ?)",
                rusqlite::params![pct, updated],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO progress (user_id, book_id, format, location, percentage, finished, started_at, updated_at)
             VALUES (1, 12, 'PDF', '2', 60.0, 0, 100, 1500)",
            [],
        )
        .unwrap();
    }
    let db = UserDb::open_at(&path);
    assert_eq!(
        raw_count(&path, "SELECT COUNT(*) FROM progress"),
        2,
        "collision collapsed"
    );
    let kept = db
        .get_progress(1, "default", 10, Some("EPUB"))
        .expect("kept row");
    assert_eq!(kept.percentage, 80.0, "most recently updated row wins");
    assert!(db.get_progress(1, "default", 12, Some("PDF")).is_some());
    drop(db);
    dir.close().ok();
}

#[test]
fn user_deletion_cascades_progress_and_sessions() {
    let (_dir, path) = temp_db_path();
    let db = UserDb::open_at(&path);
    let alice = user(&db, "alice");
    write(
        &db,
        alice.id,
        "lib-1",
        1,
        ProgressInput {
            mutation_id: Some("m-cascade".into()),
            percentage: Some(1.0),
            base_revision: Some(0),
            ..input("EPUB")
        },
    );
    assert!(db.delete_progress(alice.id, "lib-1", 1, Some("EPUB")));
    db.create_session("hash-a", alice.id, i64::MAX);
    assert!(db.delete_user("alice").is_some());
    assert_eq!(raw_count(&path, "SELECT COUNT(*) FROM progress"), 0);
    assert_eq!(raw_count(&path, "SELECT COUNT(*) FROM sessions"), 0);
    assert_eq!(
        raw_count(&path, "SELECT COUNT(*) FROM progress_deletions"),
        0,
        "user-scoped tombstones cascade"
    );
    // processed_mutations has no FK in the TS schema: rows orphan, by design.
    assert_eq!(
        raw_count(&path, "SELECT COUNT(*) FROM processed_mutations"),
        1
    );
}

#[test]
fn library_id_normalization() {
    assert_eq!(normalize_library_id("  lib-1  "), "lib-1");
    assert_eq!(normalize_library_id(""), "default");
    assert_eq!(normalize_library_id("   "), "default");
    assert_eq!(normalize_library_id("a").len(), 1);
    assert_eq!(normalize_library_id(&"x".repeat(300)).len(), 200);
}
