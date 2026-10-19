//! `users.db` data layer: users, sessions, and per-user reading progress.
//!
//! Port of `src/lib/user-db.ts`. SQL is ported verbatim (schema, migrations,
//! and the T2/T3/T5 causal-revision upsert protocol), so databases written
//! by the TypeScript app open and keep working unchanged.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use caliber_common::Config;
use rusqlite::{Connection, OptionalExtension, ToSql, Transaction};
use serde::Serialize;

use crate::util::{is_js_regex_ws, js_parse_int, js_slice, js_trim, now_millis};

pub const USERNAME_MAX: usize = 40;

const PROGRESS_COLUMNS: &str = "book_id, library_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id";

// ---------------------------------------------------------------------------
// Public row types (CONTRACT.md section B)
// ---------------------------------------------------------------------------

/// Wire shape of `User` from the TS app (`createdAt` / `lastSeenAt`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserRow {
    pub id: i64,
    pub username: String,
    pub has_password: bool,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserWithCredential {
    pub id: i64,
    pub username: String,
    pub password_hash: Option<String>,
    pub auth_epoch: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRow {
    pub book_id: i64,
    pub library_id: String,
    pub format: String,
    pub location: Option<String>,
    pub percentage: f64,
    pub furthest_percentage: f64,
    pub finished: bool,
    pub started_at: i64,
    pub updated_at: i64,
    pub server_seq: i64,
    pub last_mutation_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProgressInput {
    pub format: String,
    pub location: Option<String>,
    pub percentage: Option<f64>,
    pub finished: bool,
    pub mutation_id: Option<String>,
    pub client_ts: Option<i64>,
    pub base_revision: Option<i64>,
    pub base_deletion_seq: Option<i64>,
    pub force: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct UpsertProgressResult {
    pub progress: Option<ProgressRow>,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ProgressDeletionInfo {
    pub seq: Option<i64>,
    pub at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub token_hash: String,
    pub user_id: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub auth_epoch: i64,
}

// ---------------------------------------------------------------------------
// Names / locations (user-db.ts helpers)
// ---------------------------------------------------------------------------

pub fn normalize_username(raw: &str) -> String {
    let trimmed = js_trim(raw);
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut pending_space = false;
    for c in trimmed.chars() {
        if is_js_regex_ws(c) {
            pending_space = true;
        } else {
            if pending_space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            pending_space = false;
            collapsed.push(c);
        }
    }
    js_slice(&collapsed, USERNAME_MAX).to_string()
}

pub fn is_valid_username(raw: &str) -> bool {
    let name = normalize_username(raw);
    !name.is_empty() && name.chars().count() <= USERNAME_MAX
}

pub fn normalize_library_id(raw: &str) -> String {
    let s = js_trim(raw);
    if s.is_empty() {
        "default".to_string()
    } else {
        js_slice(s, 200).to_string()
    }
}

/// F03: a locator must match the shape produced by its format. EPUB uses
/// CFI strings; paged formats (PDF/CBZ/CBR) use numeric page strings.
pub fn is_valid_location_for_format(format: &str, location: Option<&str>) -> bool {
    let Some(location) = location else {
        return true;
    };
    let fmt = format.to_uppercase();
    if fmt == "EPUB" {
        return location.starts_with("epubcfi(")
            || location.starts_with('/')
            || location.starts_with('[');
    }
    if fmt == "PDF" || fmt == "CBZ" || fmt == "CBR" {
        return match js_parse_int(location) {
            Some(n) => n >= 1 && n.to_string() == js_trim(location),
            None => false,
        };
    }
    true
}

pub fn sanitize_location_for_format(format: &str, location: Option<&str>) -> Option<String> {
    let location = location?;
    let s = js_slice(location, 20000);
    if s.is_empty() {
        return None;
    }
    if is_valid_location_for_format(format, Some(s)) {
        Some(s.to_string())
    } else {
        None
    }
}

/// TS `if (format)` truthiness: `Some("")` behaves like a missing format.
fn normalized_format(format: Option<&str>) -> Option<String> {
    format
        .filter(|f| !f.is_empty())
        .map(|f| js_slice(&f.to_uppercase(), 10).to_string())
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

fn table_pk_names(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.sort_by_key(|(pk, _)| *pk);
    Ok(rows
        .into_iter()
        .filter(|(pk, _)| *pk > 0)
        .map(|(_, name)| name)
        .collect())
}

/// F04/F05/FUP1/R2: bring legacy progress tables forward without losing
/// rows: add `library_id` / `furthest_percentage` / `server_seq` /
/// `last_mutation_id` when missing, and rebuild the PK to
/// `(user_id, library_id, book_id, format)` keeping the most recently
/// updated row on new-PK collisions (`INSERT OR IGNORE` + `ORDER BY
/// updated_at DESC`).
fn migrate_progress_table(conn: &Connection) -> rusqlite::Result<()> {
    let mut cols = table_columns(conn, "progress")?;
    if !cols.iter().any(|c| c == "library_id") {
        conn.execute_batch(
            "ALTER TABLE progress ADD COLUMN library_id TEXT NOT NULL DEFAULT 'default';",
        )?;
        cols = table_columns(conn, "progress")?;
    }
    if !cols.iter().any(|c| c == "furthest_percentage") {
        conn.execute_batch(
            "ALTER TABLE progress ADD COLUMN furthest_percentage REAL NOT NULL DEFAULT 0;",
        )?;
        // Backfill furthest from the old MAX-derived resume percentage.
        let _ = conn.execute_batch(
            "UPDATE progress SET furthest_percentage = percentage WHERE furthest_percentage = 0;",
        );
        cols = table_columns(conn, "progress")?;
    }
    if !cols.iter().any(|c| c == "server_seq") {
        conn.execute_batch(
            "ALTER TABLE progress ADD COLUMN server_seq INTEGER NOT NULL DEFAULT 0;",
        )?;
        cols = table_columns(conn, "progress")?;
    }
    if !cols.iter().any(|c| c == "last_mutation_id") {
        conn.execute_batch("ALTER TABLE progress ADD COLUMN last_mutation_id TEXT;")?;
        cols = table_columns(conn, "progress")?;
    }
    let pk = table_pk_names(conn, "progress")?;
    let pk_ok = pk.len() == 4
        && pk[0] == "user_id"
        && pk[1] == "library_id"
        && pk[2] == "book_id"
        && pk[3] == "format";
    if pk_ok {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS progress_new (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          library_id TEXT NOT NULL DEFAULT 'default',
          book_id INTEGER NOT NULL,
          format TEXT NOT NULL,
          location TEXT,
          percentage REAL NOT NULL DEFAULT 0,
          furthest_percentage REAL NOT NULL DEFAULT 0,
          finished INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          server_seq INTEGER NOT NULL DEFAULT 0,
          last_mutation_id TEXT,
          PRIMARY KEY (user_id, library_id, book_id, format)
        );",
    )?;
    let has_furthest = cols.iter().any(|c| c == "furthest_percentage");
    let has_library = cols.iter().any(|c| c == "library_id");
    let has_seq = cols.iter().any(|c| c == "server_seq");
    let has_mutation = cols.iter().any(|c| c == "last_mutation_id");
    let furthest_expr = if has_furthest {
        "COALESCE(furthest_percentage, percentage, 0)"
    } else {
        "COALESCE(percentage, 0)"
    };
    let library_expr = if has_library {
        "COALESCE(library_id, 'default')"
    } else {
        "'default'"
    };
    let seq_expr = if has_seq {
        "COALESCE(server_seq, 0)"
    } else {
        "0"
    };
    let mutation_expr = if has_mutation {
        "last_mutation_id"
    } else {
        "NULL"
    };
    let insert = format!(
        "INSERT OR IGNORE INTO progress_new
          (user_id, library_id, book_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id)
        SELECT user_id, {library_expr}, book_id, format, location, percentage,
               {furthest_expr}, finished, started_at, updated_at, {seq_expr}, {mutation_expr}
        FROM progress ORDER BY updated_at DESC;"
    );
    conn.execute_batch(&insert)?;
    conn.execute_batch("DROP TABLE progress; ALTER TABLE progress_new RENAME TO progress;")?;
    Ok(())
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          username_lower TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          auth_epoch INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS progress (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          library_id TEXT NOT NULL DEFAULT 'default',
          book_id INTEGER NOT NULL,
          format TEXT NOT NULL,
          location TEXT,
          percentage REAL NOT NULL DEFAULT 0,
          furthest_percentage REAL NOT NULL DEFAULT 0,
          finished INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          server_seq INTEGER NOT NULL DEFAULT 0,
          last_mutation_id TEXT,
          PRIMARY KEY (user_id, library_id, book_id, format)
        );",
    )?;
    migrate_progress_table(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON progress(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_progress_user_library_updated ON progress(user_id, library_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS progress_deletions (
          deleted_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          library_id TEXT NOT NULL DEFAULT 'default',
          book_id INTEGER,
          format TEXT,
          deleted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_progress_user_library_updated ON progress(user_id, library_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS processed_mutations (
          mutation_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          library_id TEXT NOT NULL,
          book_id INTEGER NOT NULL,
          format TEXT NOT NULL,
          server_seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processed_mutations_identity ON processed_mutations(user_id, library_id, book_id, format, created_at DESC);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          auth_epoch INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
    )?;
    // Users created before auth support lack the password columns.
    let user_columns = table_columns(conn, "users")?;
    if !user_columns.iter().any(|c| c == "password_hash") {
        conn.execute_batch("ALTER TABLE users ADD COLUMN password_hash TEXT;")?;
    }
    if !user_columns.iter().any(|c| c == "auth_epoch") {
        conn.execute_batch("ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;")?;
    }
    let session_columns = table_columns(conn, "sessions")?;
    if !session_columns.iter().any(|c| c == "auth_epoch") {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get(0)?,
        username: row.get(1)?,
        created_at: row.get(2)?,
        last_seen_at: row.get(3)?,
    })
}

/// Maps a row of `PROGRESS_COLUMNS` with the TS `rowToProgress` fallbacks.
fn map_progress_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProgressRow> {
    let percentage: f64 = row.get(4)?;
    let library_id: Option<String> = row.get(1)?;
    let furthest: Option<f64> = row.get(5)?;
    let last_mutation_id: Option<String> = row.get(10)?;
    Ok(ProgressRow {
        book_id: row.get(0)?,
        library_id: match library_id {
            Some(s) if !s.is_empty() => s,
            _ => "default".to_string(),
        },
        format: row.get(2)?,
        location: row.get(3)?,
        percentage,
        furthest_percentage: furthest.filter(|f| f.is_finite()).unwrap_or(percentage),
        finished: row.get::<_, i64>(6)? == 1,
        started_at: row.get(7)?,
        updated_at: row.get(8)?,
        server_seq: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
        last_mutation_id: last_mutation_id.filter(|m| !m.is_empty()),
    })
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        token_hash: row.get(0)?,
        user_id: row.get(1)?,
        created_at: row.get(2)?,
        expires_at: row.get(3)?,
        auth_epoch: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
    })
}

// ---------------------------------------------------------------------------
// UserDb
// ---------------------------------------------------------------------------

pub struct UserDb {
    conn: Mutex<Connection>,
}

impl UserDb {
    /// Opens `CALIBER_USER_DB_PATH` or `<config_dir>/users.db`, creating the
    /// schema and running migrations. An existing users.db written by the
    /// TypeScript app opens and keeps working unchanged.
    pub fn open(config: &Config) -> UserDb {
        let resolved = config.resolved();
        let _ = fs::create_dir_all(&resolved.config_dir);
        let path = std::env::var("CALIBER_USER_DB_PATH")
            .ok()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| resolved.config_dir.join("users.db"));
        UserDb::open_at(&path)
    }

    /// Explicit-path variant of [`UserDb::open`] (used by tests and tools
    /// that already resolved the database location).
    pub fn open_at(path: &Path) -> UserDb {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                let _ = fs::create_dir_all(parent);
            }
        }
        let conn = Connection::open(path).expect("caliber-user: unable to open users.db");
        let _mode: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .expect("caliber-user: users.db journal_mode");
        conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
            .expect("caliber-user: users.db pragmas");
        init_schema(&conn).expect("caliber-user: users.db schema migration");
        UserDb {
            conn: Mutex::new(conn),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .expect("caliber-user: users.db mutex poisoned")
    }

    // --- users -----------------------------------------------------------

    pub fn get_or_create_user(&self, raw: &str) -> Option<User> {
        let username = normalize_username(raw);
        if username.is_empty() {
            return None;
        }
        let lower = username.to_lowercase();
        let conn = self.lock();
        let now = now_millis();
        let existing: Option<User> = conn
            .query_row(
                "SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?",
                [&lower],
                map_user,
            )
            .optional()
            .expect("caliber-user: users lookup failed");
        if let Some(mut user) = existing {
            conn.execute(
                "UPDATE users SET last_seen_at = ? WHERE id = ?",
                [now, user.id],
            )
            .expect("caliber-user: users update failed");
            user.last_seen_at = now;
            return Some(user);
        }
        conn.query_row(
            "INSERT INTO users (username, username_lower, created_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             RETURNING id, username, created_at, last_seen_at",
            rusqlite::params![username, lower, now, now],
            map_user,
        )
        .optional()
        .expect("caliber-user: user insert failed")
    }

    pub fn get_user_by_username(&self, raw: &str) -> Option<User> {
        let lower = normalize_username(raw).to_lowercase();
        if lower.is_empty() {
            return None;
        }
        self.lock()
            .query_row(
                "SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?",
                [&lower],
                map_user,
            )
            .optional()
            .expect("caliber-user: users lookup failed")
    }

    pub fn get_user_by_id(&self, id: i64) -> Option<User> {
        self.lock()
            .query_row(
                "SELECT id, username, created_at, last_seen_at FROM users WHERE id = ?",
                [id],
                map_user,
            )
            .optional()
            .expect("caliber-user: users lookup failed")
    }

    pub fn get_credential_by_username(&self, raw: &str) -> Option<UserWithCredential> {
        let lower = normalize_username(raw).to_lowercase();
        if lower.is_empty() {
            return None;
        }
        self.lock()
            .query_row(
                "SELECT id, username, password_hash, auth_epoch FROM users WHERE username_lower = ?",
                [&lower],
                |row| {
                    Ok(UserWithCredential {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        password_hash: row.get(2)?,
                        auth_epoch: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    })
                },
            )
            .optional()
            .expect("caliber-user: credential lookup failed")
    }

    pub fn create_user_with_password(&self, raw: &str, password_hash: &str) -> Option<User> {
        let username = normalize_username(raw);
        if username.is_empty() {
            return None;
        }
        let lower = username.to_lowercase();
        let now = now_millis();
        let conn = self.lock();
        match conn.query_row(
            "INSERT INTO users (username, username_lower, password_hash, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             RETURNING id, username, created_at, last_seen_at",
            rusqlite::params![username, lower, password_hash, now, now],
            map_user,
        ) {
            Ok(user) => Some(user),
            // The TS server pre-checks duplicates; a constraint violation
            // (e.g. a lost race on username_lower) maps to None instead of
            // throwing.
            Err(_) => None,
        }
    }

    /// Credential rotation: update the hash, bump `auth_epoch`, and delete
    /// the user's sessions transactionally so stale sessions and cached
    /// Basic credentials fail cross-process via the DB.
    pub fn set_user_password(&self, user_id: i64, password_hash: Option<&str>) {
        let mut conn = self.lock();
        let tx = conn.transaction().expect("caliber-user: txn begin failed");
        tx.execute(
            "UPDATE users SET password_hash = ?, auth_epoch = auth_epoch + 1 WHERE id = ?",
            rusqlite::params![password_hash, user_id],
        )
        .expect("caliber-user: password update failed");
        tx.execute("DELETE FROM sessions WHERE user_id = ?", [user_id])
            .expect("caliber-user: session revoke failed");
        tx.commit().expect("caliber-user: txn commit failed");
    }

    pub fn delete_sessions_for_user(&self, user_id: i64) -> usize {
        self.lock()
            .execute("DELETE FROM sessions WHERE user_id = ?", [user_id])
            .expect("caliber-user: session revoke failed")
    }

    pub fn get_auth_epoch(&self, user_id: i64) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT auth_epoch FROM users WHERE id = ?",
                [user_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .expect("caliber-user: epoch lookup failed")
            .flatten()
    }

    pub fn count_users_with_password(&self) -> i64 {
        self.lock()
            .query_row(
                "SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("caliber-user: user count failed")
    }

    pub fn list_auth_users(&self) -> Vec<AuthUserRow> {
        self.lock()
            .prepare(
                "SELECT id, username, password_hash IS NOT NULL AS has_password,
                        created_at, last_seen_at
                 FROM users ORDER BY username_lower",
            )
            .expect("caliber-user: user list failed")
            .query_map([], |row| {
                Ok(AuthUserRow {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    has_password: row.get::<_, i64>(2)? == 1,
                    created_at: row.get(3)?,
                    last_seen_at: row.get(4)?,
                })
            })
            .expect("caliber-user: user list failed")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("caliber-user: user list failed")
    }

    pub fn delete_user(&self, raw: &str) -> Option<User> {
        let user = self.get_user_by_username(raw)?;
        self.lock()
            .execute("DELETE FROM users WHERE id = ?", [user.id])
            .expect("caliber-user: user delete failed");
        Some(user)
    }

    // --- sessions ----------------------------------------------------------

    pub fn create_session(&self, token_hash: &str, user_id: i64, expires_at: i64) {
        let now = now_millis();
        let conn = self.lock();
        let epoch = conn
            .query_row(
                "SELECT auth_epoch FROM users WHERE id = ?",
                [user_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .expect("caliber-user: epoch lookup failed")
            .flatten()
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, auth_epoch, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![token_hash, user_id, epoch, now, expires_at],
        )
        .expect("caliber-user: session insert failed");
    }

    pub fn get_session(&self, token_hash: &str) -> Option<SessionRow> {
        self.lock()
            .query_row(
                "SELECT token_hash, user_id, created_at, expires_at, auth_epoch FROM sessions WHERE token_hash = ?",
                [token_hash],
                map_session,
            )
            .optional()
            .expect("caliber-user: session lookup failed")
    }

    pub fn delete_session(&self, token_hash: &str) -> bool {
        self.lock()
            .execute("DELETE FROM sessions WHERE token_hash = ?", [token_hash])
            .expect("caliber-user: session delete failed")
            > 0
    }

    pub fn delete_expired_sessions(&self) -> usize {
        let now = now_millis();
        self.lock()
            .execute("DELETE FROM sessions WHERE expires_at <= ?", [now])
            .expect("caliber-user: expired session sweep failed")
    }

    // --- progress ----------------------------------------------------------

    pub fn get_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        let lib = normalize_library_id(library_id);
        let conn = self.lock();
        get_progress_conn(&conn, user_id, &lib, book_id, format)
    }

    pub fn list_progress_formats(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
    ) -> Vec<ProgressRow> {
        let lib = normalize_library_id(library_id);
        self.lock()
            .prepare(&format!(
                "SELECT {PROGRESS_COLUMNS} FROM progress
                 WHERE user_id = ? AND library_id = ? AND book_id = ? ORDER BY updated_at DESC"
            ))
            .expect("caliber-user: progress query failed")
            .query_map(rusqlite::params![user_id, lib, book_id], map_progress_row)
            .expect("caliber-user: progress query failed")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("caliber-user: progress query failed")
    }

    pub fn list_progress(&self, user_id: i64, library_id: &str, limit: u32) -> Vec<ProgressRow> {
        let lib = normalize_library_id(library_id);
        let capped = limit.clamp(1, 500);
        self.lock()
            .prepare(&format!(
                "SELECT {PROGRESS_COLUMNS} FROM progress
                 WHERE user_id = ? AND library_id = ? ORDER BY updated_at DESC LIMIT ?"
            ))
            .expect("caliber-user: progress query failed")
            .query_map(rusqlite::params![user_id, lib, capped], map_progress_row)
            .expect("caliber-user: progress query failed")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("caliber-user: progress query failed")
    }

    /// T2/T3/T5 causal revision protocol — port of TS `upsertProgress`
    /// (user-db.ts lines 729–926), executed inside one transaction.
    pub fn upsert_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        input: &ProgressInput,
    ) -> UpsertProgressResult {
        let now = now_millis();
        let format = js_slice(&input.format.to_uppercase(), 10).to_string();
        // Format is part of the PK: writes always target one format row.
        if format.is_empty() {
            return UpsertProgressResult {
                progress: None,
                applied: false,
                reason: Some("invalid-format".to_string()),
            };
        }
        let lib = normalize_library_id(library_id);
        // F03: drop locators that cannot belong to this format instead of
        // storing a value readers would mis-restore.
        let raw_location: Option<String> = input
            .location
            .as_deref()
            .map(|l| js_slice(l, 20000).to_string());
        let location: Option<&str> = match &raw_location {
            Some(l) if !is_valid_location_for_format(&format, Some(l)) => None,
            other => other.as_deref(),
        };
        // F05: percentage/location are the resume point (last seen). Furthest
        // is a separate MAX column and resume is never derived from it.
        let resume = input
            .percentage
            .filter(|p| p.is_finite())
            .map(|p| p.clamp(0.0, 100.0))
            .unwrap_or(0.0);
        let finished: i64 = if input.finished { 1 } else { 0 };
        let incoming_mutation: Option<String> = input
            .mutation_id
            .as_deref()
            .filter(|m| !m.is_empty())
            .map(|m| js_slice(m, 128).to_string());
        // ProgressInput carries i64 revisions; the TS Number.isFinite /
        // Math.floor normalization is therefore a no-op here.
        let base_revision = input.base_revision;
        let base_deletion_seq = input.base_deletion_seq;
        let force = input.force;

        // T5 atomic revision: read-check-write in one transaction so a
        // two-connection interleave cannot double-apply.
        let mut conn = self.lock();
        let tx = conn.transaction().expect("caliber-user: txn begin failed");
        let result = upsert_progress_tx(
            &tx,
            user_id,
            &lib,
            book_id,
            &format,
            location,
            resume,
            finished,
            incoming_mutation.as_deref(),
            base_revision,
            base_deletion_seq,
            force,
            now,
        );
        tx.commit().expect("caliber-user: txn commit failed");
        result
    }

    pub fn delete_progress(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> bool {
        let lib = normalize_library_id(library_id);
        let now = now_millis();
        let mut conn = self.lock();
        let tx = conn.transaction().expect("caliber-user: txn begin failed");
        // T5: the DELETE and its deletion-generation row commit atomically.
        let removed = match normalized_format(format) {
            Some(fmt) => {
                let changes = tx
                    .execute(
                        "DELETE FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?",
                        rusqlite::params![user_id, lib, book_id, fmt],
                    )
                    .expect("caliber-user: progress delete failed");
                let removed = changes > 0;
                if removed {
                    tx.execute(
                        "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, ?, ?, ?)",
                        rusqlite::params![user_id, lib, book_id, fmt, now],
                    )
                    .expect("caliber-user: deletion insert failed");
                }
                removed
            }
            None => {
                let changes = tx
                    .execute(
                        "DELETE FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ?",
                        rusqlite::params![user_id, lib, book_id],
                    )
                    .expect("caliber-user: progress delete failed");
                let mut removed = changes > 0;
                if !removed && lib == "default" {
                    // Back-compat (legacy migration path only): legacy rows
                    // without a library scope.
                    let legacy = tx
                        .execute(
                            "DELETE FROM progress WHERE user_id = ? AND book_id = ?",
                            rusqlite::params![user_id, book_id],
                        )
                        .expect("caliber-user: progress delete failed");
                    removed = legacy > 0;
                }
                if removed {
                    // Book-level wildcard (format NULL) covers all formats.
                    tx.execute(
                        "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, ?, NULL, ?)",
                        rusqlite::params![user_id, lib, book_id, now],
                    )
                    .expect("caliber-user: deletion insert failed");
                }
                removed
            }
        };
        tx.commit().expect("caliber-user: txn commit failed");
        removed
    }

    pub fn clear_progress(&self, user_id: i64, library_id: &str) -> usize {
        let lib = normalize_library_id(library_id);
        let now = now_millis();
        let mut conn = self.lock();
        let tx = conn.transaction().expect("caliber-user: txn begin failed");
        // T5: the clear and its library-level deletion rows commit atomically.
        // Back-compat (legacy migration path only): 'default' clears
        // everything, matching the pre-scoping behavior.
        let removed = if lib == "default" {
            let libs: Vec<String> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT DISTINCT library_id AS library_id FROM progress WHERE user_id = ?",
                    )
                    .expect("caliber-user: progress query failed");
                let rows = stmt
                    .query_map([user_id], |row| row.get::<_, String>(0))
                    .expect("caliber-user: progress query failed")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .expect("caliber-user: progress query failed");
                rows
            };
            let changes = tx
                .execute("DELETE FROM progress WHERE user_id = ?", [user_id])
                .expect("caliber-user: progress delete failed");
            if changes > 0 {
                let mut seen: HashSet<String> = HashSet::new();
                for row in libs {
                    let l = normalize_library_id(&row);
                    if !seen.insert(l.clone()) {
                        continue;
                    }
                    tx.execute(
                        "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
                        rusqlite::params![user_id, l, now],
                    )
                    .expect("caliber-user: deletion insert failed");
                }
                if !seen.contains("default") {
                    tx.execute(
                        "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
                        rusqlite::params![user_id, "default", now],
                    )
                    .expect("caliber-user: deletion insert failed");
                }
            }
            changes
        } else {
            let changes = tx
                .execute(
                    "DELETE FROM progress WHERE user_id = ? AND library_id = ?",
                    rusqlite::params![user_id, lib],
                )
                .expect("caliber-user: progress delete failed");
            if changes > 0 {
                tx.execute(
                    "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
                    rusqlite::params![user_id, lib, now],
                )
                .expect("caliber-user: deletion insert failed");
            }
            changes
        };
        tx.commit().expect("caliber-user: txn commit failed");
        removed
    }

    pub fn set_finished(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        finished: bool,
        format: Option<&str>,
    ) -> Option<ProgressRow> {
        let lib = normalize_library_id(library_id);
        let conn = self.lock();
        let existing = get_progress_conn(&conn, user_id, &lib, book_id, format)?;
        let now = now_millis();
        let finished_flag: i64 = if finished { 1 } else { 0 };
        let pct = if finished { 100.0 } else { existing.percentage };
        match normalized_format(format) {
            Some(fmt) => {
                conn.execute(
                    "UPDATE progress SET finished = ?, percentage = ?, furthest_percentage = MAX(furthest_percentage, ?), updated_at = ?
                     WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?",
                    rusqlite::params![finished_flag, pct, pct, now, user_id, lib, book_id, fmt],
                )
                .expect("caliber-user: progress update failed");
            }
            None => {
                conn.execute(
                    "UPDATE progress SET finished = ?, percentage = ?, furthest_percentage = MAX(furthest_percentage, ?), updated_at = ?
                     WHERE user_id = ? AND library_id = ? AND book_id = ?",
                    rusqlite::params![finished_flag, pct, pct, now, user_id, lib, book_id],
                )
                .expect("caliber-user: progress update failed");
            }
        }
        get_progress_conn(&conn, user_id, &lib, book_id, format)
    }

    /// T5: max deletion generation covering an identity. Exact format rows,
    /// book-level wildcards (format NULL), and library-level clears
    /// (book NULL) all cover a format-scoped read. Book-level reads
    /// (format `None`) match library-wide plus any row for that book.
    pub fn progress_deletion(
        &self,
        user_id: i64,
        library_id: &str,
        book_id: i64,
        format: Option<&str>,
    ) -> ProgressDeletionInfo {
        let lib = normalize_library_id(library_id);
        let conn = self.lock();
        let (seq, at): (Option<i64>, Option<i64>) = match normalized_format(format) {
            Some(fmt) => conn
                .query_row(
                    "SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
                     WHERE user_id = ? AND library_id = ?
                       AND (book_id IS NULL OR (book_id = ? AND (format IS NULL OR format = ?)))",
                    rusqlite::params![user_id, lib, book_id, fmt],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("caliber-user: deletion lookup failed"),
            None => conn
                .query_row(
                    "SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
                     WHERE user_id = ? AND library_id = ? AND (book_id IS NULL OR book_id = ?)",
                    rusqlite::params![user_id, lib, book_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("caliber-user: deletion lookup failed"),
        };
        match seq {
            Some(seq) => ProgressDeletionInfo { seq: Some(seq), at },
            None => ProgressDeletionInfo {
                seq: None,
                at: None,
            },
        }
    }

    /// T5: library-level deletion generation (covers `clear_progress`).
    pub fn library_deletion(&self, user_id: i64, library_id: &str) -> ProgressDeletionInfo {
        let lib = normalize_library_id(library_id);
        let (seq, at): (Option<i64>, Option<i64>) = self
            .lock()
            .query_row(
                "SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
                 WHERE user_id = ? AND library_id = ? AND book_id IS NULL",
                rusqlite::params![user_id, lib],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("caliber-user: deletion lookup failed");
        match seq {
            Some(seq) => ProgressDeletionInfo { seq: Some(seq), at },
            None => ProgressDeletionInfo {
                seq: None,
                at: None,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (single-lock variants)
// ---------------------------------------------------------------------------

/// `getProgress` port against an already-held connection, including the
/// legacy-migration fallbacks for the `"default"` library.
fn get_progress_conn(
    conn: &Connection,
    user_id: i64,
    lib: &str,
    book_id: i64,
    format: Option<&str>,
) -> Option<ProgressRow> {
    let select = |sql: String, params: Vec<Box<dyn ToSql>>| -> Option<ProgressRow> {
        let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, refs.as_slice(), map_progress_row)
            .optional()
            .expect("caliber-user: progress query failed")
    };
    match normalized_format(format) {
        Some(fmt) => {
            if let Some(row) = select(
                format!("SELECT {PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?"),
                vec![Box::new(user_id), Box::new(lib.to_string()), Box::new(book_id), Box::new(fmt.clone())],
            ) {
                return Some(row);
            }
            // Back-compat (legacy migration path only): rows written before
            // the library_id migration carry library_id 'default'.
            if lib == "default" {
                select(
                    format!("SELECT {PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND book_id = ? AND format = ? LIMIT 1"),
                    vec![Box::new(user_id), Box::new(book_id), Box::new(fmt)],
                )
            } else {
                None
            }
        }
        None => {
            // Publication-level read: derive status across formats
            // (finished wins, then furthest progress, then most recent).
            if let Some(row) = select(
                format!(
                    "SELECT {PROGRESS_COLUMNS} FROM progress
                         WHERE user_id = ? AND library_id = ? AND book_id = ?
                         ORDER BY finished DESC, furthest_percentage DESC, updated_at DESC LIMIT 1"
                ),
                vec![
                    Box::new(user_id),
                    Box::new(lib.to_string()),
                    Box::new(book_id),
                ],
            ) {
                return Some(row);
            }
            if lib == "default" {
                select(
                    format!("SELECT {PROGRESS_COLUMNS} FROM progress
                             WHERE user_id = ? AND book_id = ?
                             ORDER BY finished DESC, furthest_percentage DESC, updated_at DESC LIMIT 1"),
                    vec![Box::new(user_id), Box::new(book_id)],
                )
            } else {
                None
            }
        }
    }
}

/// Transaction body of [`UserDb::upsert_progress`] (TS user-db.ts
/// lines 729–926). Early returns are committed by the caller.
#[allow(clippy::too_many_arguments)]
fn upsert_progress_tx(
    tx: &Transaction<'_>,
    user_id: i64,
    lib: &str,
    book_id: i64,
    format: &str,
    location: Option<&str>,
    resume: f64,
    finished: i64,
    incoming_mutation: Option<&str>,
    base_revision: Option<i64>,
    base_deletion_seq: Option<i64>,
    force: bool,
    now: i64,
) -> UpsertProgressResult {
    let existing: Option<ProgressRow> = tx
        .query_row(
            &format!("SELECT {PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?"),
            rusqlite::params![user_id, lib, book_id, format],
            map_progress_row,
        )
        .optional()
        .expect("caliber-user: progress query failed");
    if let Some(mutation) = incoming_mutation {
        // T3: consult the full mutation history first. Any match → duplicate
        // (idempotent applied:true, no server_seq bump), even if an
        // intervening write has since advanced the row.
        let seen: Option<i64> = tx
            .query_row(
                "SELECT 1 AS hit FROM processed_mutations WHERE mutation_id = ?",
                [mutation],
                |row| row.get(0),
            )
            .optional()
            .expect("caliber-user: mutation lookup failed");
        if seen.is_some() {
            return UpsertProgressResult {
                progress: existing,
                applied: true,
                reason: Some("duplicate".to_string()),
            };
        }
        // Legacy backfill: rows written before the history table only carry
        // last_mutation_id. Treat a match as duplicate and backfill history
        // so future replays hit the table above.
        if let Some(existing) = &existing {
            if existing.last_mutation_id.as_deref() == Some(mutation) {
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO processed_mutations
                       (mutation_id, user_id, library_id, book_id, format, server_seq, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        mutation,
                        user_id,
                        lib,
                        book_id,
                        format,
                        existing.server_seq,
                        now
                    ],
                );
                return UpsertProgressResult {
                    progress: Some(existing.clone()),
                    applied: true,
                    reason: Some("duplicate".to_string()),
                };
            }
        }
    }
    if existing.is_none() && !force {
        let del_seq: Option<i64> = tx
            .query_row(
                "SELECT MAX(deleted_seq) AS seq FROM progress_deletions
                 WHERE user_id = ? AND library_id = ?
                   AND (book_id IS NULL OR (book_id = ? AND (format IS NULL OR format = ?)))",
                rusqlite::params![user_id, lib, book_id, format],
                |row| row.get(0),
            )
            .expect("caliber-user: deletion lookup failed");
        if let Some(del_seq) = del_seq {
            if base_deletion_seq.is_none() || del_seq > base_deletion_seq.unwrap_or(i64::MIN) {
                return UpsertProgressResult {
                    progress: None,
                    applied: false,
                    reason: Some("deleted".to_string()),
                };
            }
        }
    }
    if let Some(existing) = &existing {
        if let Some(base_rev) = base_revision {
            if base_rev != existing.server_seq {
                // Revision conflict: keep the existing resume point, but
                // still advance furthest/completion monotonically. Conditional
                // on server_seq so a concurrent winner cannot be clobbered.
                tx.execute(
                    "UPDATE progress SET
                       furthest_percentage = MAX(progress.furthest_percentage, ?),
                       finished = MAX(progress.finished, ?)
                     WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ? AND server_seq = ?",
                    rusqlite::params![resume, finished, user_id, lib, book_id, format, existing.server_seq],
                )
                .expect("caliber-user: progress update failed");
                let refreshed: Option<ProgressRow> = tx
                    .query_row(
                        &format!("SELECT {PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?"),
                        rusqlite::params![user_id, lib, book_id, format],
                        map_progress_row,
                    )
                    .optional()
                    .expect("caliber-user: progress query failed");
                return UpsertProgressResult {
                    progress: refreshed.or_else(|| Some(existing.clone())),
                    applied: false,
                    reason: Some("conflict".to_string()),
                };
            }
        }
    }

    tx.execute(
        "INSERT INTO progress (user_id, library_id, book_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, library_id, book_id, format) DO UPDATE SET
         location = excluded.location,
         percentage = excluded.percentage,
         furthest_percentage = MAX(progress.furthest_percentage, excluded.furthest_percentage),
         finished = MAX(progress.finished, excluded.finished),
         updated_at = excluded.updated_at,
         server_seq = progress.server_seq + 1,
         last_mutation_id = excluded.last_mutation_id",
        rusqlite::params![
            user_id,
            lib,
            book_id,
            format,
            location,
            resume,
            resume,
            finished,
            now,
            now,
            incoming_mutation
        ],
    )
    .expect("caliber-user: progress upsert failed");

    let written: Option<ProgressRow> = tx
        .query_row(
            &format!("SELECT {PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?"),
            rusqlite::params![user_id, lib, book_id, format],
            map_progress_row,
        )
        .optional()
        .expect("caliber-user: progress query failed");
    // T3: record every applied mutation in history, then prune to the last 50
    // per user/library/book/format identity.
    if let (Some(written), Some(mutation)) = (&written, incoming_mutation) {
        let _ = tx.execute(
            "INSERT OR IGNORE INTO processed_mutations
               (mutation_id, user_id, library_id, book_id, format, server_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                mutation,
                user_id,
                lib,
                book_id,
                format,
                written.server_seq,
                now
            ],
        );
        let _ = tx.execute(
            "DELETE FROM processed_mutations
             WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?
               AND mutation_id NOT IN (
                 SELECT mutation_id FROM processed_mutations
                 WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?
                 ORDER BY created_at DESC, rowid DESC LIMIT 50
               )",
            rusqlite::params![user_id, lib, book_id, format, user_id, lib, book_id, format],
        );
    }
    UpsertProgressResult {
        progress: written,
        applied: true,
        reason: None,
    }
}
