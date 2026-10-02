// Separate internal database for users and per-user reading progress.
// This is intentionally NOT the Calibre metadata DB — it lives in the config
// dir and is fully owned by caliber, so library refreshes never touch it.
//
// Without auth enabled, a "user" is just a remembered username. With auth
// enabled, users carry an argon2id password hash and browser sessions.

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { CONFIG_DIR_PATH } from "./config";

const USER_DB_PATH = process.env.CALIBER_USER_DB_PATH || join(CONFIG_DIR_PATH, "users.db");

export interface User {
  id: number;
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionRow {
  tokenHash: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
  authEpoch: number;
}

export interface ProgressRow {
  bookId: number;
  libraryId: string;
  format: string;
  location: string | null;
  percentage: number;
  furthestPercentage: number;
  finished: boolean;
  startedAt: number;
  updatedAt: number;
  serverSeq: number;
  lastMutationId: string | null;
}

let db: Database | null = null;

// F03: locator shape must match the format that produced it. EPUB uses CFI
// strings; paged formats (PDF/CBZ/CBR) use numeric page strings.
export function isValidLocationForFormat(format: string, location: string | null): boolean {
  if (location == null) return true;
  const fmt = String(format || "").toUpperCase();
  if (fmt === "EPUB") {
    const s = String(location);
    return s.startsWith("epubcfi(") || s.startsWith("/") || s.startsWith("[");
  }
  if (fmt === "PDF" || fmt === "CBZ" || fmt === "CBR") {
    const n = Number.parseInt(String(location), 10);
    return Number.isInteger(n) && n >= 1 && String(n) === String(location).trim();
  }
  return true;
}

export function sanitizeLocationForFormat(format: string, location: string | null): string | null {
  if (location == null) return null;
  const s = String(location).slice(0, 20000);
  if (!s) return null;
  return isValidLocationForFormat(format, s) ? s : null;
}

function progressColumnNames(database: Database): string[] {
  const cols = database.query("PRAGMA table_info(progress)").all() as Array<{
    name: string;
    pk: number;
  }>;
  return cols.map((c) => c.name);
}

function progressPkNames(database: Database): string[] {
  const cols = database.query("PRAGMA table_info(progress)").all() as Array<{
    name: string;
    pk: number;
  }>;
  return cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

// F04/F05/FUP1/R2: bring legacy progress tables forward without losing rows:
// - add library_id (default 'default') and furthest_percentage columns
// - add server_seq + last_mutation_id ordering columns (R2 stale-overwrite guard)
// - rebuild PK to (user_id, library_id, book_id, format) when needed,
//   keeping the most recently updated row on new-PK collisions
function migrateProgressTable(database: Database): void {
  let cols = progressColumnNames(database);
  if (!cols.includes("library_id")) {
    database.exec("ALTER TABLE progress ADD COLUMN library_id TEXT NOT NULL DEFAULT 'default';");
    cols = progressColumnNames(database);
  }
  if (!cols.includes("furthest_percentage")) {
    database.exec("ALTER TABLE progress ADD COLUMN furthest_percentage REAL NOT NULL DEFAULT 0;");
    // Backfill furthest from the old MAX-derived resume percentage.
    try {
      database.exec(
        "UPDATE progress SET furthest_percentage = percentage WHERE furthest_percentage = 0;",
      );
    } catch {}
    cols = progressColumnNames(database);
  }
  if (!cols.includes("server_seq")) {
    database.exec("ALTER TABLE progress ADD COLUMN server_seq INTEGER NOT NULL DEFAULT 0;");
    cols = progressColumnNames(database);
  }
  if (!cols.includes("last_mutation_id")) {
    database.exec("ALTER TABLE progress ADD COLUMN last_mutation_id TEXT;");
    cols = progressColumnNames(database);
  }
  const pk = progressPkNames(database);
  const pkOk =
    pk.length === 4 &&
    pk[0] === "user_id" &&
    pk[1] === "library_id" &&
    pk[2] === "book_id" &&
    pk[3] === "format";
  if (pkOk) return;
  // Rebuild table to include format in the PK, preserving rows. ORDER BY
  // updated_at DESC with INSERT OR IGNORE keeps the most recent row when
  // several legacy rows collapse onto one new PK.
  database.exec(`
    CREATE TABLE IF NOT EXISTS progress_new (
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
    );
  `);
  const hasFurthest = cols.includes("furthest_percentage");
  const hasLibrary = cols.includes("library_id");
  const hasSeq = cols.includes("server_seq");
  const hasMutation = cols.includes("last_mutation_id");
  const furthestExpr = hasFurthest
    ? "COALESCE(furthest_percentage, percentage, 0)"
    : "COALESCE(percentage, 0)";
  const libraryExpr = hasLibrary ? "COALESCE(library_id, 'default')" : "'default'";
  const seqExpr = hasSeq ? "COALESCE(server_seq, 0)" : "0";
  const mutationExpr = hasMutation ? "last_mutation_id" : "NULL";
  database.exec(`
    INSERT OR IGNORE INTO progress_new
      (user_id, library_id, book_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id)
    SELECT user_id, ${libraryExpr}, book_id, format, location, percentage,
           ${furthestExpr}, finished, started_at, updated_at, ${seqExpr}, ${mutationExpr}
    FROM progress ORDER BY updated_at DESC;
  `);
  database.exec("DROP TABLE progress;");
  database.exec("ALTER TABLE progress_new RENAME TO progress;");
}

function getDb(): Database {
  if (db) return db;
  mkdirSync(CONFIG_DIR_PATH, { recursive: true });
  mkdirSync(dirname(USER_DB_PATH), { recursive: true });
  const database = new Database(USER_DB_PATH);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      auth_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);
  database.exec(`
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
    );
  `);
  migrateProgressTable(database);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON progress(user_id, updated_at DESC);`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_progress_user_library_updated ON progress(user_id, library_id, updated_at DESC);`,
  );
  // T5 server-side deletion generation: every deleteProgress/clearProgress
  // appends a tombstone row in the same transaction as the DELETE so a
  // stale queued write can be distinguished from an intentional post-deletion
  // resurrect. book_id NULL = whole-library clear; format NULL = all formats
  // for that book (or all when book_id is NULL). deleted_seq is a global
  // generation counter (AUTOINCREMENT); writers acknowledge it via
  // baseDeletionSeq.
  database.exec(`
    CREATE TABLE IF NOT EXISTS progress_deletions (
      deleted_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL DEFAULT 'default',
      book_id INTEGER,
      format TEXT,
      deleted_at INTEGER NOT NULL
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_progress_user_library_updated ON progress(user_id, library_id, updated_at DESC);`,
  );
  // T3 predecessors + mutation history: replaces the last_mutation_id single
  // slot (which accepted replay-after-intervening-write). Every applied
  // mutation is recorded here; duplicate check consults history (any match
  // → duplicate, no server_seq bump). Pruned to the last 50 per
  // user/library/book/format identity. last_mutation_id on progress is kept
  // for backward compat but is no longer authoritative.
  database.exec(`
    CREATE TABLE IF NOT EXISTS processed_mutations (
      mutation_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      library_id TEXT NOT NULL,
      book_id INTEGER NOT NULL,
      format TEXT NOT NULL,
      server_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_processed_mutations_identity ON processed_mutations(user_id, library_id, book_id, format, created_at DESC);`,
  );
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      auth_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  // Users created before auth support lack the password column.
  const userColumns = database.query("PRAGMA table_info(users)").all() as Array<{
    name: string;
  }>;
  if (!userColumns.some((column) => column.name === "password_hash")) {
    database.exec("ALTER TABLE users ADD COLUMN password_hash TEXT;");
  }
  if (!userColumns.some((column) => column.name === "auth_epoch")) {
    database.exec("ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;");
  }
  const sessionColumns = database.query("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  if (!sessionColumns.some((column) => column.name === "auth_epoch")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;");
  }
  db = database;
  return database;
}

const USERNAME_MAX = 40;

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, USERNAME_MAX);
}

export function isValidUsername(raw: string): boolean {
  const name = normalizeUsername(raw);
  return name.length >= 1 && name.length <= USERNAME_MAX;
}

function rowToUser(row: {
  id: number;
  username: string;
  created_at: number;
  last_seen_at: number;
}): User {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function getOrCreateUser(rawUsername: string): User | null {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;
  const lower = username.toLowerCase();
  const database = getDb();
  const now = Date.now();

  const existing = database
    .query<{ id: number; username: string; created_at: number; last_seen_at: number }, [string]>(
      "SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?",
    )
    .get(lower);

  if (existing) {
    database.query("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, existing.id);
    return rowToUser({ ...existing, last_seen_at: now });
  }

  const inserted = database
    .query<
      { id: number; username: string; created_at: number; last_seen_at: number },
      [string, string, number, number]
    >(
      `INSERT INTO users (username, username_lower, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       RETURNING id, username, created_at, last_seen_at`,
    )
    .get(username, lower, now, now);

  return inserted ? rowToUser(inserted) : null;
}

export function getUserByUsername(rawUsername: string): User | null {
  const lower = normalizeUsername(rawUsername).toLowerCase();
  if (!lower) return null;
  const row = getDb()
    .query<{ id: number; username: string; created_at: number; last_seen_at: number }, [string]>(
      "SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?",
    )
    .get(lower);
  return row ? rowToUser(row) : null;
}

export function getUserById(id: number): User | null {
  const row = getDb()
    .query<{ id: number; username: string; created_at: number; last_seen_at: number }, [number]>(
      "SELECT id, username, created_at, last_seen_at FROM users WHERE id = ?",
    )
    .get(id);
  return row ? rowToUser(row) : null;
}

export interface UserWithCredential {
  id: number;
  username: string;
  passwordHash: string | null;
  authEpoch: number;
}

export function getCredentialByUsername(rawUsername: string): UserWithCredential | null {
  const lower = normalizeUsername(rawUsername).toLowerCase();
  if (!lower) return null;
  const row = getDb()
    .query<
      { id: number; username: string; password_hash: string | null; auth_epoch: number | null },
      [string]
    >("SELECT id, username, password_hash, auth_epoch FROM users WHERE username_lower = ?")
    .get(lower);
  return row
    ? {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        authEpoch: row.auth_epoch ?? 0,
      }
    : null;
}

export function getAuthEpoch(userId: number): number | null {
  const row = getDb()
    .query<{ auth_epoch: number | null }, [number]>("SELECT auth_epoch FROM users WHERE id = ?")
    .get(userId);
  if (!row) return null;
  return row.auth_epoch ?? 0;
}

export function setUserPassword(userId: number, passwordHash: string | null): void {
  // Credential rotation: bump the epoch and revoke sessions transactionally
  // so stale Basic cache entries and sessions fail cross-process via the DB.
  const database = getDb();
  const txn = database.transaction(() => {
    database
      .query("UPDATE users SET password_hash = ?, auth_epoch = auth_epoch + 1 WHERE id = ?")
      .run(passwordHash, userId);
    database.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  });
  txn();
}

export function deleteSessionsForUser(userId: number): number {
  const result = getDb().query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return result.changes;
}

export function createUserWithPassword(rawUsername: string, passwordHash: string): User | null {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;
  const lower = username.toLowerCase();
  const now = Date.now();
  const inserted = getDb()
    .query<
      { id: number; username: string; created_at: number; last_seen_at: number },
      [string, string, string, number, number]
    >(
      `INSERT INTO users (username, username_lower, password_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, username, created_at, last_seen_at`,
    )
    .get(username, lower, passwordHash, now, now);
  return inserted ? rowToUser(inserted) : null;
}

export function countUsers(): number {
  const row = getDb().query("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

export function countUsersWithPassword(): number {
  const row = getDb()
    .query("SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL")
    .get() as { count: number };
  return row.count;
}

export interface AuthUserRow {
  id: number;
  username: string;
  hasPassword: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export function listAuthUsers(): AuthUserRow[] {
  const rows = getDb()
    .query(
      `SELECT id, username, password_hash IS NOT NULL AS has_password,
              created_at, last_seen_at
       FROM users ORDER BY username_lower`,
    )
    .all() as Array<{
    id: number;
    username: string;
    has_password: number;
    created_at: number;
    last_seen_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    hasPassword: row.has_password === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function deleteUser(rawUsername: string): User | null {
  const user = getUserByUsername(rawUsername);
  if (!user) return null;
  getDb().query("DELETE FROM users WHERE id = ?").run(user.id);
  return user;
}

export function createSession(
  tokenHash: string,
  userId: number,
  expiresAt: number,
  expectedAuthEpoch?: number,
): boolean {
  const now = Date.now();
  // Select and stamp the epoch in the same statement. A password change
  // between verification and session creation must not grant a fresh session
  // to a request that proved only the old credentials.
  const result = getDb()
    .query(
      `INSERT INTO sessions (token_hash, user_id, auth_epoch, created_at, expires_at)
       SELECT ?, id, COALESCE(auth_epoch, 0), ?, ? FROM users
       WHERE id = ? AND (? IS NULL OR COALESCE(auth_epoch, 0) = ?)`,
    )
    .run(tokenHash, now, expiresAt, userId, expectedAuthEpoch ?? null, expectedAuthEpoch ?? null);
  return result.changes > 0;
}

export function getSession(tokenHash: string): SessionRow | null {
  const row = getDb()
    .query(
      "SELECT token_hash, user_id, auth_epoch, created_at, expires_at FROM sessions WHERE token_hash = ?",
    )
    .get(tokenHash) as {
    token_hash: string;
    user_id: number;
    auth_epoch: number | null;
    created_at: number;
    expires_at: number;
  } | null;
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    authEpoch: row.auth_epoch ?? 0,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function deleteSession(tokenHash: string): boolean {
  const result = getDb().query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  return result.changes > 0;
}

export function deleteExpiredSessions(): number {
  const result = getDb().query("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return result.changes;
}

function rowToProgress(row: {
  book_id: number;
  library_id?: string | null;
  format: string;
  location: string | null;
  percentage: number;
  furthest_percentage?: number | null;
  finished: number;
  started_at: number;
  updated_at: number;
  server_seq?: number | null;
  last_mutation_id?: string | null;
}): ProgressRow {
  return {
    bookId: row.book_id,
    libraryId: typeof row.library_id === "string" && row.library_id ? row.library_id : "default",
    format: row.format,
    location: row.location,
    percentage: row.percentage,
    furthestPercentage:
      typeof row.furthest_percentage === "number" && Number.isFinite(row.furthest_percentage)
        ? row.furthest_percentage
        : row.percentage,
    finished: row.finished === 1,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    serverSeq:
      typeof row.server_seq === "number" && Number.isFinite(row.server_seq) ? row.server_seq : 0,
    lastMutationId:
      typeof row.last_mutation_id === "string" && row.last_mutation_id
        ? row.last_mutation_id
        : null,
  };
}

const PROGRESS_COLUMNS =
  "book_id, library_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id";

export function normalizeLibraryId(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? s.slice(0, 200) : "default";
}

export function getProgress(
  userId: number,
  libraryId: string,
  bookId: number,
  format?: string,
): ProgressRow | null {
  const lib = normalizeLibraryId(libraryId);
  const database = getDb();
  type Row = Parameters<typeof rowToProgress>[0];
  if (format) {
    const fmt = String(format).toUpperCase().slice(0, 10);
    const row = database
      .query(
        `SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?`,
      )
      .get(userId, lib, bookId, fmt) as Row | null;
    if (row) return rowToProgress(row);
    // Back-compat (legacy migration path only): rows written before the
    // library_id migration carry library_id 'default'.
    if (lib === "default") {
      const legacy = database
        .query(
          `SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND book_id = ? AND format = ? LIMIT 1`,
        )
        .get(userId, bookId, fmt) as Row | null;
      return legacy ? rowToProgress(legacy) : null;
    }
    return null;
  }
  // Publication-level read: derive status across formats (finished wins,
  // then furthest progress, then most recent) so shelf and reader resume agree.
  const row = database
    .query(
      `SELECT ${PROGRESS_COLUMNS} FROM progress
       WHERE user_id = ? AND library_id = ? AND book_id = ?
       ORDER BY finished DESC, furthest_percentage DESC, updated_at DESC LIMIT 1`,
    )
    .get(userId, lib, bookId) as Row | null;
  if (row) return rowToProgress(row);
  // Back-compat (legacy migration path only).
  if (lib === "default") {
    const legacy = database
      .query(
        `SELECT ${PROGRESS_COLUMNS} FROM progress
         WHERE user_id = ? AND book_id = ?
         ORDER BY finished DESC, furthest_percentage DESC, updated_at DESC LIMIT 1`,
      )
      .get(userId, bookId) as Row | null;
    return legacy ? rowToProgress(legacy) : null;
  }
  return null;
}

export function listProgressFormats(
  userId: number,
  libraryId: string,
  bookId: number,
): ProgressRow[] {
  const lib = normalizeLibraryId(libraryId);
  const rows = getDb()
    .query(
      `SELECT ${PROGRESS_COLUMNS} FROM progress
       WHERE user_id = ? AND library_id = ? AND book_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId, lib, bookId) as Parameters<typeof rowToProgress>[0][];
  return rows.map(rowToProgress);
}

export function listProgress(userId: number, libraryId: string, limit = 500): ProgressRow[] {
  const lib = normalizeLibraryId(libraryId);
  const cappedLimit = Math.min(500, Math.max(1, Math.floor(limit) || 1));
  const rows = getDb()
    .query(
      `SELECT ${PROGRESS_COLUMNS} FROM progress
       WHERE user_id = ? AND library_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, lib, cappedLimit) as Parameters<typeof rowToProgress>[0][];
  return rows.map(rowToProgress);
}

export interface ProgressInput {
  format: string;
  location?: string | null;
  percentage?: number;
  finished?: boolean;
  mutationId?: string | null;
  clientTs?: number | null;
  baseRevision?: number | null;
  baseDeletionSeq?: number | null;
  force?: boolean | null;
}

export interface UpsertProgressResult {
  progress: ProgressRow | null;
  applied: boolean;
  reason?: string;
}

export interface ProgressDeletionInfo {
  seq: number | null;
  at: number | null;
}

// T5: max deletion generation covering an identity. Exact format rows,
// book-level wildcards (format NULL), and library-level clears (book NULL)
// all cover a format-scoped write. Book-level reads (format undefined) match
// library-wide plus any row for that book.
export function getProgressDeletion(
  userId: number,
  libraryId: string,
  bookId: number,
  format?: string,
): ProgressDeletionInfo {
  const lib = normalizeLibraryId(libraryId);
  const database = getDb();
  let row: { seq: number | null; at: number | null } | null = null;
  if (format) {
    const fmt = String(format).toUpperCase().slice(0, 10);
    row = database
      .query(
        `SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
         WHERE user_id = ? AND library_id = ?
           AND (book_id IS NULL OR (book_id = ? AND (format IS NULL OR format = ?)))`,
      )
      .get(userId, lib, bookId, fmt) as { seq: number | null; at: number | null } | null;
  } else {
    row = database
      .query(
        `SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
         WHERE user_id = ? AND library_id = ? AND (book_id IS NULL OR book_id = ?)`,
      )
      .get(userId, lib, bookId) as { seq: number | null; at: number | null } | null;
  }
  if (!row || row.seq == null) return { seq: null, at: null };
  return {
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? Math.floor(row.seq) : null,
    at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null,
  };
}

export function getProgressDeletionSeq(
  userId: number,
  libraryId: string,
  bookId: number,
  format?: string,
): number | null {
  return getProgressDeletion(userId, libraryId, bookId, format).seq;
}

// T5: library-level deletion generation (covers clearProgress).
export function getLibraryDeletion(userId: number, libraryId: string): ProgressDeletionInfo {
  const lib = normalizeLibraryId(libraryId);
  const row = getDb()
    .query(
      `SELECT MAX(deleted_seq) AS seq, MAX(deleted_at) AS at FROM progress_deletions
       WHERE user_id = ? AND library_id = ? AND book_id IS NULL`,
    )
    .get(userId, lib) as { seq: number | null; at: number | null } | null;
  if (!row || row.seq == null) return { seq: null, at: null };
  return {
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? Math.floor(row.seq) : null,
    at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null,
  };
}

export function upsertProgress(
  userId: number,
  libraryId: string,
  bookId: number,
  input: ProgressInput,
): UpsertProgressResult {
  const now = Date.now();
  const format = String(input.format || "")
    .toUpperCase()
    .slice(0, 10);
  // Format is part of the PK: writes always target one format row. Callers
  // must pass the reader's format explicitly.
  if (!format) return { progress: null, applied: false, reason: "invalid-format" };
  const lib = normalizeLibraryId(libraryId);
  // F03: drop locators that cannot belong to this format instead of storing
  // a value readers would mis-restore (e.g. a page number as an EPUB CFI).
  const rawLocation = input.location == null ? null : String(input.location).slice(0, 20000);
  const location =
    rawLocation != null && !isValidLocationForFormat(format, rawLocation) ? null : rawLocation;
  // F05: percentage/location are the resume point (last seen). Furthest is a
  // separate MAX column and resume is never derived from it.
  const resume = Number.isFinite(input.percentage)
    ? Math.min(100, Math.max(0, Number(input.percentage)))
    : 0;
  const finished = input.finished ? 1 : 0;
  // T2 causal revision protocol (no wall-clock ordering anywhere):
  // - baseRevision = caller's last known server_seq. Null-base means expected
  //   revision 0: a first write with no known seq sends baseRevision 0
  //   explicitly (not null); baseRevision 0 on a missing row is a valid
  //   initial. baseRevision null (legacy) is an unconditional blind write
  //   ONLY for backward compat, deprecated.
  // - T3 duplicate: mutationId is checked against the processed_mutations
  //   history table (any match → duplicate, applied:true, no server_seq
  //   bump). The last_mutation_id single slot is legacy/backfill only and
  //   prevents replay-after-intervening-write acceptance that the single slot
  //   allowed.
  // - baseRevision mismatch (non-null, != existing.server_seq, different
  //   mutation) -> conflict: keep location/percentage/updated_at, advance only
  //   furthest_percentage/finished monotonically, no server_seq bump.
  //   Returns applied:false reason:"conflict".
  //   incomingTs (clientTs) is diagnostics-only and never affects ordering.
  // T5 deletion generation:
  // - baseDeletionSeq = caller's last known deletion generation (null = none).
  // - Row missing + covering deletion with seq > baseDeletionSeq (or any
  //   deletion when baseDeletionSeq is null) -> applied:false reason:"deleted".
  // - A fresh baseDeletionSeq (from GET deletion info) or force:true (explicit
  //   user-confirmed re-read) resurrects.
  const incomingMutation =
    typeof input.mutationId === "string" && input.mutationId
      ? input.mutationId.slice(0, 128)
      : null;
  const baseRevision =
    typeof input.baseRevision === "number" && Number.isFinite(input.baseRevision)
      ? Math.floor(input.baseRevision)
      : null;
  const baseDeletionSeq =
    typeof input.baseDeletionSeq === "number" && Number.isFinite(input.baseDeletionSeq)
      ? Math.floor(input.baseDeletionSeq)
      : null;
  const force = input.force === true;

  // T5 atomic revision: the read-check-write runs inside one Bun SQLite
  // transaction so a two-connection interleave cannot double-apply (both
  // check the same server_seq / deletion generation atomically with the
  // write). All statements are synchronous — no awaits inside.
  const database = getDb();
  const txn = database.transaction((): UpsertProgressResult => {
    const existingRow = database
      .query(
        `SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?`,
      )
      .get(userId, lib, bookId, format) as Parameters<typeof rowToProgress>[0] | null;
    const existing = existingRow ? rowToProgress(existingRow) : null;
    if (incomingMutation) {
      // T3: consult the full mutation history first. Any match → duplicate
      // (idempotent applied:true, no server_seq bump), even if an intervening
      // write has since advanced the row (prevents replay acceptance).
      const seen = database
        .query("SELECT 1 AS hit FROM processed_mutations WHERE mutation_id = ?")
        .get(incomingMutation) as { hit: number } | null;
      if (seen) {
        return { progress: existing, applied: true, reason: "duplicate" };
      }
      // Legacy backfill: rows written before the history table only carry
      // last_mutation_id. Treat a match as duplicate and backfill history so
      // future replays hit the table above.
      if (existing && incomingMutation === existing.lastMutationId) {
        try {
          database
            .query(
              `INSERT OR IGNORE INTO processed_mutations
                 (mutation_id, user_id, library_id, book_id, format, server_seq, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(incomingMutation, userId, lib, bookId, format, existing.serverSeq, now);
        } catch {}
        return { progress: existing, applied: true, reason: "duplicate" };
      }
    }
    if (!existing && !force) {
      const del = database
        .query(
          `SELECT MAX(deleted_seq) AS seq FROM progress_deletions
           WHERE user_id = ? AND library_id = ?
             AND (book_id IS NULL OR (book_id = ? AND (format IS NULL OR format = ?)))`,
        )
        .get(userId, lib, bookId, format) as { seq: number | null } | null;
      const delSeq =
        del && typeof del.seq === "number" && Number.isFinite(del.seq) ? Math.floor(del.seq) : null;
      if (delSeq !== null && (baseDeletionSeq === null || delSeq > baseDeletionSeq)) {
        return { progress: null, applied: false, reason: "deleted" };
      }
    }
    if (existing && baseRevision !== null && baseRevision !== existing.serverSeq) {
      // Revision conflict: keep the existing resume point, but still advance
      // furthest/completion monotonically so forward progress is never lost.
      // Conditional on server_seq so a concurrent winner cannot be clobbered.
      database
        .query(
          `UPDATE progress SET
             furthest_percentage = MAX(progress.furthest_percentage, ?),
             finished = MAX(progress.finished, ?)
           WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ? AND server_seq = ?`,
        )
        .run(resume, finished, userId, lib, bookId, format, existing.serverSeq);
      const refreshed = database
        .query(
          `SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?`,
        )
        .get(userId, lib, bookId, format) as Parameters<typeof rowToProgress>[0] | null;
      return {
        progress: refreshed ? rowToProgress(refreshed) : existing,
        applied: false,
        reason: "conflict",
      };
    }

    database
      .query(
        `INSERT INTO progress (user_id, library_id, book_id, format, location, percentage, furthest_percentage, finished, started_at, updated_at, server_seq, last_mutation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, library_id, book_id, format) DO UPDATE SET
         location = excluded.location,
         percentage = excluded.percentage,
         furthest_percentage = MAX(progress.furthest_percentage, excluded.furthest_percentage),
         finished = MAX(progress.finished, excluded.finished),
         updated_at = excluded.updated_at,
         server_seq = progress.server_seq + 1,
         last_mutation_id = excluded.last_mutation_id`,
      )
      .run(
        userId,
        lib,
        bookId,
        format,
        location,
        resume,
        resume,
        finished,
        now,
        now,
        incomingMutation,
      );

    const written = database
      .query(
        `SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?`,
      )
      .get(userId, lib, bookId, format) as Parameters<typeof rowToProgress>[0] | null;
    // T3: record every applied mutation in history, then prune to the last 50
    // per user/library/book/format identity.
    if (written && incomingMutation) {
      const writtenRow = rowToProgress(written);
      try {
        database
          .query(
            `INSERT OR IGNORE INTO processed_mutations
               (mutation_id, user_id, library_id, book_id, format, server_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(incomingMutation, userId, lib, bookId, format, writtenRow.serverSeq, now);
        database
          .query(
            `DELETE FROM processed_mutations
             WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?
               AND mutation_id NOT IN (
                 SELECT mutation_id FROM processed_mutations
                 WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?
                 ORDER BY created_at DESC, rowid DESC LIMIT 50
               )`,
          )
          .run(userId, lib, bookId, format, userId, lib, bookId, format);
      } catch {}
    }
    return { progress: written ? rowToProgress(written) : null, applied: true };
  });
  return txn();
}

export function deleteProgress(
  userId: number,
  libraryId: string,
  bookId: number,
  format?: string,
): boolean {
  const lib = normalizeLibraryId(libraryId);
  const database = getDb();
  const now = Date.now();
  // T5: the DELETE and its deletion-generation row commit atomically.
  const txn = database.transaction((): boolean => {
    let removed = false;
    if (format) {
      const fmt = String(format).toUpperCase().slice(0, 10);
      const result = database
        .query(
          "DELETE FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?",
        )
        .run(userId, lib, bookId, fmt);
      removed = result.changes > 0;
      if (removed) {
        database
          .query(
            "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(userId, lib, bookId, fmt, now);
      }
      return removed;
    }
    const result = database
      .query("DELETE FROM progress WHERE user_id = ? AND library_id = ? AND book_id = ?")
      .run(userId, lib, bookId);
    removed = result.changes > 0;
    if (!removed && lib === "default") {
      // Back-compat (legacy migration path only): legacy rows without a library scope.
      const legacy = database
        .query("DELETE FROM progress WHERE user_id = ? AND book_id = ?")
        .run(userId, bookId);
      removed = legacy.changes > 0;
    }
    if (removed) {
      // Book-level wildcard (format NULL) covers all formats for the book.
      database
        .query(
          "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, ?, NULL, ?)",
        )
        .run(userId, lib, bookId, now);
    }
    return removed;
  });
  return txn();
}

export function clearProgress(userId: number, libraryId: string): number {
  const lib = normalizeLibraryId(libraryId);
  const database = getDb();
  const now = Date.now();
  // T5: the clear and its library-level deletion row commit atomically.
  // Back-compat (legacy migration path only): 'default' clears everything,
  // matching the pre-scoping behavior. Real library scopes delete only rows
  // in that library.
  const txn = database.transaction((): number => {
    if (lib === "default") {
      const libs = database
        .query("SELECT DISTINCT library_id AS library_id FROM progress WHERE user_id = ?")
        .all(userId) as Array<{ library_id: string }>;
      const result = database.query("DELETE FROM progress WHERE user_id = ?").run(userId);
      if (result.changes > 0) {
        const seen = new Set<string>();
        for (const row of libs) {
          const l = normalizeLibraryId(row.library_id);
          if (seen.has(l)) continue;
          seen.add(l);
          database
            .query(
              "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
            )
            .run(userId, l, now);
        }
        if (!seen.has("default")) {
          database
            .query(
              "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
            )
            .run(userId, "default", now);
        }
      }
      return result.changes;
    }
    const result = database
      .query("DELETE FROM progress WHERE user_id = ? AND library_id = ?")
      .run(userId, lib);
    if (result.changes > 0) {
      database
        .query(
          "INSERT INTO progress_deletions (user_id, library_id, book_id, format, deleted_at) VALUES (?, ?, NULL, NULL, ?)",
        )
        .run(userId, lib, now);
    }
    return result.changes;
  });
  return txn();
}

export function setFinished(
  userId: number,
  libraryId: string,
  bookId: number,
  finished: boolean,
  format?: string,
): ProgressRow | null {
  const lib = normalizeLibraryId(libraryId);
  const existing = getProgress(userId, lib, bookId, format);
  if (!existing) return null;
  const now = Date.now();
  const database = getDb();
  if (format) {
    const fmt = String(format).toUpperCase().slice(0, 10);
    database
      .query(
        `UPDATE progress SET finished = ?, percentage = ?, furthest_percentage = MAX(furthest_percentage, ?), updated_at = ?
         WHERE user_id = ? AND library_id = ? AND book_id = ? AND format = ?`,
      )
      .run(
        finished ? 1 : 0,
        finished ? 100 : existing.percentage,
        finished ? 100 : existing.percentage,
        now,
        userId,
        lib,
        bookId,
        fmt,
      );
  } else {
    database
      .query(
        `UPDATE progress SET finished = ?, percentage = ?, furthest_percentage = MAX(furthest_percentage, ?), updated_at = ?
         WHERE user_id = ? AND library_id = ? AND book_id = ?`,
      )
      .run(
        finished ? 1 : 0,
        finished ? 100 : existing.percentage,
        finished ? 100 : existing.percentage,
        now,
        userId,
        lib,
        bookId,
      );
  }
  return getProgress(userId, lib, bookId, format);
}
