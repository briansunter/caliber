// Separate internal database for users and per-user reading progress.
// This is intentionally NOT the Calibre metadata DB — it lives in the config
// dir and is fully owned by caliber, so library refreshes never touch it.
//
// No real auth yet: a "user" is just a remembered username. The HTTP layer
// stores the username in a cookie and resolves it to a row here.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CONFIG_DIR_PATH } from "./config";

const USER_DB_PATH = process.env.CALIBER_USER_DB_PATH || join(CONFIG_DIR_PATH, "users.db");

export interface User {
  id: number;
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ProgressRow {
  bookId: number;
  format: string;
  location: string | null;
  percentage: number;
  finished: boolean;
  startedAt: number;
  updatedAt: number;
}

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  mkdirSync(CONFIG_DIR_PATH, { recursive: true });
  const database = new Database(USER_DB_PATH);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL,
      format TEXT NOT NULL,
      location TEXT,
      percentage REAL NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON progress(user_id, updated_at DESC);`,
  );
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
    .query<
      { id: number; username: string; created_at: number; last_seen_at: number },
      [string]
    >("SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?")
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
    .query<
      { id: number; username: string; created_at: number; last_seen_at: number },
      [string]
    >("SELECT id, username, created_at, last_seen_at FROM users WHERE username_lower = ?")
    .get(lower);
  return row ? rowToUser(row) : null;
}

function rowToProgress(row: {
  book_id: number;
  format: string;
  location: string | null;
  percentage: number;
  finished: number;
  started_at: number;
  updated_at: number;
}): ProgressRow {
  return {
    bookId: row.book_id,
    format: row.format,
    location: row.location,
    percentage: row.percentage,
    finished: row.finished === 1,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

const PROGRESS_COLUMNS =
  "book_id, format, location, percentage, finished, started_at, updated_at";

export function getProgress(userId: number, bookId: number): ProgressRow | null {
  const row = getDb()
    .query(`SELECT ${PROGRESS_COLUMNS} FROM progress WHERE user_id = ? AND book_id = ?`)
    .get(userId, bookId) as Parameters<typeof rowToProgress>[0] | null;
  return row ? rowToProgress(row) : null;
}

export function listProgress(userId: number, limit = 500): ProgressRow[] {
  const rows = getDb()
    .query(
      `SELECT ${PROGRESS_COLUMNS} FROM progress
       WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as Parameters<typeof rowToProgress>[0][];
  return rows.map(rowToProgress);
}

export interface ProgressInput {
  format: string;
  location?: string | null;
  percentage?: number;
  finished?: boolean;
}

export function upsertProgress(
  userId: number,
  bookId: number,
  input: ProgressInput,
): ProgressRow | null {
  const now = Date.now();
  const format = String(input.format || "").toUpperCase().slice(0, 10);
  const location = input.location == null ? null : String(input.location).slice(0, 20000);
  const percentage = Number.isFinite(input.percentage)
    ? Math.min(100, Math.max(0, Number(input.percentage)))
    : 0;
  const finished = input.finished ? 1 : 0;

  getDb()
    .query(
      `INSERT INTO progress (user_id, book_id, format, location, percentage, finished, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         format = excluded.format,
         location = excluded.location,
         percentage = MAX(progress.percentage, excluded.percentage),
         finished = MAX(progress.finished, excluded.finished),
         updated_at = excluded.updated_at`,
    )
    .run(userId, bookId, format, location, percentage, finished, now, now);

  return getProgress(userId, bookId);
}

export function deleteProgress(userId: number, bookId: number): boolean {
  const result = getDb()
    .query("DELETE FROM progress WHERE user_id = ? AND book_id = ?")
    .run(userId, bookId);
  return result.changes > 0;
}

export function setFinished(userId: number, bookId: number, finished: boolean): ProgressRow | null {
  const existing = getProgress(userId, bookId);
  if (!existing) return null;
  const now = Date.now();
  getDb()
    .query(
      `UPDATE progress SET finished = ?, percentage = ?, updated_at = ?
       WHERE user_id = ? AND book_id = ?`,
    )
    .run(finished ? 1 : 0, finished ? 100 : existing.percentage, now, userId, bookId);
  return getProgress(userId, bookId);
}
