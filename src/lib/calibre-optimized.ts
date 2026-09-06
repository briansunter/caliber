import { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  CONFIG_DIR_PATH,
  DB_NAME,
  DB_REFRESH_INTERVAL_MS,
  LIBRARY_PATH,
} from "./config";
import {
  type SourceSignature,
  getDatabaseSignature,
  isSameSignature,
} from "./file-signature";

let DB_PATH = join(LIBRARY_PATH, DB_NAME);

// Writable copy in ~/.config/caliber for FTS support
const WORK_DIR = CONFIG_DIR_PATH;
const WRITABLE_DB_PATH = join(WORK_DIR, "metadata.db");
const DB_SOURCE_SIGNATURE_PATH = join(WORK_DIR, "metadata.source.json");
// Cross-process snapshot lock: held (mkdir exclusive) only while publishing a
// new generation so two processes never rename competing snapshots.
const SNAPSHOT_LOCK_DIR = join(WORK_DIR, "snapshot.lock");

// FTS index schema version, stored in caliber_fts_meta. Bump to force a
// rebuild when the FTS definition changes (v3 adds the book_list_projection
// rating materialization + the timestamp/series_index expression indexes).
export const FTS_SCHEMA_VERSION = "3";

// --- Snapshot generations (F15) -------------------------------------------
// Every published snapshot is a generation: { id, path, revision }. New
// generations are built in a tmp file and atomically renamed over
// WRITABLE_DB_PATH, then published by bumping the pointer below. Readers hold
// a lease (refcount) on the generation they started with so a refresh never
// swaps the file under an active export; refresh is deferred while leases or
// pool checkouts are held.
export interface SnapshotGeneration {
  id: number;
  path: string;
  revision: number;
  /** FTS definition version the published snapshot was built with. */
  ftsVersion: string;
}

let generationCounter = 0;
let activeGeneration: SnapshotGeneration = {
  id: 0,
  path: WRITABLE_DB_PATH,
  revision: 0,
  ftsVersion: FTS_SCHEMA_VERSION,
};
const generationLeases = new Map<number, number>();
const snapshotState: { refreshing: boolean; failed: string | null } = {
  refreshing: false,
  failed: null,
};

function activeLeaseCount(): number {
  let total = 0;
  for (const count of generationLeases.values()) total += count;
  return total;
}

/** Hold the current generation for the duration of an export/stream. */
export function acquireSnapshotLease(): () => void {
  const id = activeGeneration.id;
  generationLeases.set(id, (generationLeases.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (generationLeases.get(id) ?? 1) - 1;
    if (remaining <= 0) generationLeases.delete(id);
    else generationLeases.set(id, remaining);
    if (remaining <= 0 && activeCheckouts === 0 && refreshPending) {
      refreshPending = false;
      try {
        runRefresh();
      } catch (error) {
        console.error(
          "🔄 Deferred database refresh failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  };
}

/** Monotonic revision of the published snapshot; used for cache keys. */
export function getSnapshotRevision(): number {
  return activeGeneration.revision;
}

/** ISO instant the published snapshot was written. Nav/catalog feeds use this
 * as their updated timestamp so repeated renders of unchanged state produce
 * stable XML; only acquisition feeds use max(last_modified). */
export function getSnapshotUpdated(): string {
  try {
    return statSync(activeGeneration.path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Status surface for the config/health endpoints. */
export function getSnapshotStatus(): {
  generation: number;
  revision: number;
  stale: boolean;
  refreshing: boolean;
  failed: string | null;
} {
  let stale = refreshPending || snapshotState.refreshing;
  try {
    const snapshot = readSnapshotMetadata();
    const sig = getDatabaseSignature(DB_PATH);
    stale =
      stale || !snapshot || snapshot.sourcePath !== resolve(DB_PATH) || !isSameSignature(snapshot.signature, sig);
  } catch {
    // If stat fails we cannot prove freshness; report not-stale.
  }
  return {
    generation: activeGeneration.id,
    revision: activeGeneration.revision,
    stale,
    refreshing: snapshotState.refreshing,
    failed: snapshotState.failed,
  };
}

/** Cross-process lock via exclusive mkdir. Returns true if lock acquired. */
export function acquireSnapshotLock(): boolean {
  try {
    mkdirSync(SNAPSHOT_LOCK_DIR);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function releaseSnapshotLock(): void {
  try {
    rmdirSync(SNAPSHOT_LOCK_DIR);
  } catch {
    // ignore: lock already gone
  }
}

interface SnapshotMetadata {
  sourcePath: string;
  signature: SourceSignature;
}

function readSnapshotMetadata(): SnapshotMetadata | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(DB_SOURCE_SIGNATURE_PATH, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.sourcePath !== "string" || typeof record.signature !== "object") {
      return null;
    }
    return {
      sourcePath: record.sourcePath,
      signature: record.signature as SourceSignature,
    };
  } catch {
    return null;
  }
}

function copyDbToWritable(): void {
  if (resolve(DB_PATH) === resolve(WRITABLE_DB_PATH)) {
    throw new Error("Calibre source database must be outside Caliber's cache directory");
  }
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Calibre database not found at ${DB_PATH}. Set CALIBRE_LIBRARY_PATH (or CALIBER_LIBRARY_PATH) to a library containing ${DB_NAME}.`,
    );
  }

  mkdirSync(WORK_DIR, { recursive: true });

  // Build the new generation in a tmp file: serialize a consistent snapshot
  // of the source, then build indexes/FTS/projection IN THE TMP GENERATION
  // before publishing, so readers only ever see a complete context
  // {db path, revision, fts version} at WRITABLE_DB_PATH.
  const nextId = generationCounter + 1;
  const temporaryPath = `${WRITABLE_DB_PATH}.gen-${nextId}.tmp-${process.pid}`;
  // SQLite can have committed changes in the source WAL. serialize() asks
  // SQLite for a consistent snapshot instead of copying only metadata.db.
  const sourceDb = new Database(DB_PATH, { readonly: true });
  try {
    const tables = new Set(
      (sourceDb.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const missingTables = ["books", "authors", "data", "books_authors_link"].filter(
      (table) => !tables.has(table),
    );
    if (missingTables.length > 0) {
      throw new Error(`Unsupported Calibre database; missing ${missingTables.join(", ")}`);
    }
    writeFileSync(temporaryPath, sourceDb.serialize());
  } finally {
    sourceDb.close();
  }

  try {
    const tmpDb = new Database(temporaryPath);
    try {
      try {
        tmpDb.exec("PRAGMA journal_mode = DELETE;");
      } catch {
        // Ignore if this fails; the pool sets its own pragmas on open.
      }
      setupSnapshotDb(tmpDb);
    } finally {
      tmpDb.close();
    }

    for (const suffix of ["-wal", "-shm"]) {
      const p = WRITABLE_DB_PATH + suffix;
      if (existsSync(p)) unlinkSync(p);
    }

    // Retain the previous generation until leases drain: rename it aside
    // instead of overwriting it, then unlink the superseded file only when
    // no pool checkouts or generation leases can still read it. Refresh is
    // already deferred while leases/checkouts are held, so publish normally
    // finds none; the guard covers cross-process readers.
    if (existsSync(WRITABLE_DB_PATH)) {
      renameSync(WRITABLE_DB_PATH, `${WRITABLE_DB_PATH}.prev-${activeGeneration.id}`);
    }
    try {
      renameSync(temporaryPath, WRITABLE_DB_PATH);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      unlinkSync(WRITABLE_DB_PATH);
      renameSync(temporaryPath, WRITABLE_DB_PATH);
    }
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }

  const signature = getDatabaseSignature(DB_PATH);
  writeFileSync(
    DB_SOURCE_SIGNATURE_PATH,
    `${JSON.stringify({ sourcePath: resolve(DB_PATH), signature })}\n`,
  );
  // Publish: bump the generation pointer only after the rename succeeded.
  generationCounter = nextId;
  activeGeneration = {
    id: nextId,
    path: WRITABLE_DB_PATH,
    revision: activeGeneration.revision + 1,
    ftsVersion: FTS_SCHEMA_VERSION,
  };
  pruneOldGenerations();
  console.error(
    `📋 Copied database snapshot to ${WRITABLE_DB_PATH} (generation ${nextId}, revision ${activeGeneration.revision})`,
  );
}

// Unlink superseded generation files, but never while pool checkouts or
// generation leases (e.g. active exports/streams) might still read them;
// survivors are pruned on the next publish.
function pruneOldGenerations(): void {
  if (activeCheckouts > 0 || activeLeaseCount() > 0) return;
  let entries: string[];
  try {
    entries = readdirSync(WORK_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${DB_NAME}.prev-`)) continue;
    try {
      unlinkSync(join(WORK_DIR, entry));
    } catch {
      // ignore: already gone or locked by another process
    }
  }
}

// Connection pool for concurrent requests
const dbPool: Database[] = [];
const MAX_POOL_SIZE = 5;
let activeCheckouts = 0;
let refreshPending = false;

const dbRefreshCallbacks: Array<() => void> = [];

export function onDbRefresh(cb: () => void): void {
  dbRefreshCallbacks.push(cb);
}

function notifyDbRefreshed(): void {
  for (const cb of dbRefreshCallbacks) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

function swapDatabaseFile(): void {
  if (!acquireSnapshotLock()) {
    // Another process is publishing; mark stale and retry on the next tick.
    refreshPending = true;
    return;
  }
  snapshotState.refreshing = true;
  snapshotState.failed = null;
  try {
    // Indexes/FTS/projection are built in the tmp generation inside
    // copyDbToWritable, before the generation is published — the pool is
    // closed first so no checkout can observe the swap mid-publish.
    closePool();
    copyDbToWritable();
    notifyDbRefreshed();
  } catch (error) {
    snapshotState.failed = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    snapshotState.refreshing = false;
    releaseSnapshotLock();
  }
}

function closePool(): void {
  for (const db of dbPool) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  dbPool.length = 0;
}

function runRefresh(): void {
  // Defer while pool checkouts or generation leases (e.g. active exports)
  // are held; the last release re-triggers the refresh.
  if (activeCheckouts > 0 || activeLeaseCount() > 0) {
    refreshPending = true;
    return;
  }
  swapDatabaseFile();
}

/** Switch to a validated library selection without restarting the server. */
export function reconfigureLibraryDatabase(): void {
  DB_PATH = join(LIBRARY_PATH, DB_NAME);
  if (activeCheckouts > 0 || activeLeaseCount() > 0) {
    refreshPending = true;
    return;
  }
  swapDatabaseFile();
}

// Ensure writable DB exists and is up-to-date with the source Calibre DB.
// Startup path: this process is the single owner of the snapshot at boot (no
// pool checkouts or generation leases exist yet), so the copy runs under the
// cross-process snapshot lock with the pool closed. Index/FTS/projection
// setup runs inside the tmp generation during the copy (see
// copyDbToWritable); initFTS runs runFtsSetup() after the copy to verify the
// published snapshot.
function ensureWritableDb(): void {
  if (!existsSync(WRITABLE_DB_PATH)) {
    if (!acquireSnapshotLock()) {
      throw new Error("Another Caliber process is building the library snapshot; retry shortly");
    }
    try {
      closePool();
      copyDbToWritable();
    } finally {
      releaseSnapshotLock();
    }
    return;
  }

  try {
    const sourceSignature = getDatabaseSignature(DB_PATH);
    const snapshot = readSnapshotMetadata();
    if (
      !snapshot ||
      snapshot.sourcePath !== resolve(DB_PATH) ||
      !isSameSignature(snapshot.signature, sourceSignature)
    ) {
      // Another process may be publishing; let the periodic tick retry rather
      // than contending on the lock here.
      if (!acquireSnapshotLock()) return;
      try {
        closePool();
        copyDbToWritable();
      } finally {
        releaseSnapshotLock();
      }
    }
  } catch {
    // If stat fails, leave existing copy in place
  }
}

// Get database connection from pool or create new one — never touches the filesystem.
// Checkouts are refcounted: pair every getDb() with releaseDb() (try/finally).
function getDb(): Database {
  if (dbPool.length < MAX_POOL_SIZE) {
    const db = new Database(WRITABLE_DB_PATH);
    try {
      db.exec("PRAGMA cache_size = -64000;"); // 64MB cache
      db.exec("PRAGMA temp_store = memory;");
      db.exec("PRAGMA mmap_size = 268435456;"); // 256MB memory map
      db.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // Ignore if these fail
    }
    dbPool.push(db);
    activeCheckouts += 1;
    return db;
  }
  // Round-robin through pool
  const idx = Math.floor(Math.random() * dbPool.length);
  const db = dbPool[idx];
  if (!db) throw new Error("DB pool unexpectedly empty");
  activeCheckouts += 1;
  return db;
}

function releaseDb(): void {
  if (activeCheckouts > 0) activeCheckouts -= 1;
  if (activeCheckouts === 0 && refreshPending) {
    refreshPending = false;
    try {
      runRefresh();
    } catch (error) {
      console.error(
        "🔄 Deferred database refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function setupSnapshotDb(db: Database): void {
  const sourceSignature = getDatabaseSignature(DB_PATH);
  const sourceSignatureValue = JSON.stringify(sourceSignature);

  // Expression indexes for keyset pagination. Each index matches the
  // normalized sort expression in BOOK_SORT_EXPRESSIONS exactly (same
  // function calls, same argument order, modulo alias/whitespace which
  // SQLite normalizes) so SQLite can seek instead of sorting. Aliases
  // (b./p.) are stripped here — expression indexes must reference bare
  // columns of the indexed table.
  //
  // EXPLAIN QUERY PLAN verification (per sort, ASC):
  //   title:        SEARCH b USING INDEX idx_books_sort_key
  //   author:       SEARCH b USING INDEX idx_books_author_sort_key
  //   added:        SEARCH b USING INDEX idx_books_timestamp_matching
  //   rating:       SEARCH b USING INDEX idx_book_list_projection_rating
  //                 (via JOIN book_list_projection p ON p.book = b.id)
  //   series_index: SEARCH b USING INDEX idx_books_series_index_key
  // The explicit `key >= ?` seek bound plus the
  // `(key > ? OR (key = ? AND id > ?))` tie-break both resolve against
  // these indexes; without the bound SQLite falls back to SCAN.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_sort_key ON books(COALESCE(NULLIF(lower(sort), ''), lower(title)), id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_author_sort_key ON books(COALESCE(lower(author_sort), ''), id);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_timestamp_key ON books(timestamp, id);`);
  // Matches BOOK_SORT_EXPRESSIONS.added (`COALESCE(b.timestamp, '')`) with the
  // alias stripped, so the added-sort page query seeks instead of sorting.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_timestamp_matching ON books(COALESCE(timestamp,''), id);`);
  // Matches BOOK_SORT_EXPRESSIONS.series_index (`COALESCE(b.series_index, 1)`)
  // with the alias stripped (covering index: key + rowid tie-break).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_series_index_key ON books(COALESCE(series_index,1), id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_ratings_link_book ON books_ratings_link(book);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ratings_value ON ratings(rating, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_data_format ON data(format);`);

  // Link-table indexes
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_authors_link_book ON books_authors_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_tags_link_book ON books_tags_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_series_link_book ON books_series_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_publishers_link_book ON books_publishers_link(book);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_books_series_link_series ON books_series_link(series);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_tags_link_tag ON books_tags_link(tag);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name);`);

  // Create FTS5 virtual table for full-text search
  db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
        title,
        author_sort,
        content='books',
        content_rowid='id'
      );
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS caliber_fts_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

  const bookCount = db.query("SELECT COUNT(*) as count FROM books").get() as { count: number };
  const ftsCount = db.query("SELECT COUNT(*) as count FROM books_fts").get() as {
    count: number;
  };
  const metaRows = db
    .query("SELECT key, value FROM caliber_fts_meta WHERE key IN ('source_signature', 'fts_schema_version')")
    .all() as Array<{ key: string; value: string }>;
  const metaByKey = new Map(metaRows.map((row) => [row.key, row.value]));
  const schemaVersion = metaByKey.get("fts_schema_version");

  // MATCH probes verify the FTS index actually answers queries, not just
  // that the row COUNT(*) looks right (a corrupt/truncated FTS table can
  // still report a plausible count).
  function ftsProbesPass(): boolean {
    try {
      // Probe 1: an unlikely token must parse and return zero rows. If the
      // FTS table is corrupt this throws ("no such table" /
      // "database disk image is malformed").
      const probe = db
        .query(`SELECT rowid FROM books_fts WHERE books_fts MATCH ? LIMIT 1`)
        .all('"caliber_fts_probe_xyzzy_unlikely"') as unknown[];
      if (probe.length !== 0) return false;
      // Probe 2: a known title token must match at least one row (skipped
      // for empty libraries).
      const titleRow = db.query("SELECT title FROM books LIMIT 1").get() as
        | { title: string }
        | undefined;
      const token = titleRow?.title.toLowerCase().match(/[a-z0-9]{2,}/)?.[0];
      if (token) {
        const escaped = token.replace(/"/g, '""');
        const hits = db
          .query(`SELECT rowid FROM books_fts WHERE books_fts MATCH ? LIMIT 1`)
          .all(`"${escaped}"*`) as unknown[];
        if (hits.length === 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  if (
    schemaVersion !== FTS_SCHEMA_VERSION ||
    metaByKey.get("source_signature") !== sourceSignatureValue ||
    ftsCount.count !== bookCount.count ||
    !ftsProbesPass()
  ) {
    console.error("🔍 Building FTS index...");
    // Publish atomically: rebuild + meta updates in one transaction so a
    // crash never leaves a half-built index advertised as current.
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild');`);
      db.query(
        "INSERT OR REPLACE INTO caliber_fts_meta (key, value) VALUES ('source_signature', ?)",
      ).run(sourceSignatureValue);
      db.query("INSERT OR REPLACE INTO caliber_fts_meta (key, value) VALUES ('fts_schema_version', ?)").run(
        FTS_SCHEMA_VERSION,
      );
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
    if (!ftsProbesPass()) {
      throw new Error("FTS index rebuild failed verification probes");
    }
  }

  // Rating projection: materialized normalized rating (unrated → 0) so the
  // rating page query orders a single indexed column instead of joining
  // books_ratings_link/ratings at page time. Built here — inside the tmp
  // generation before publish on refresh — so every published snapshot
  // carries a complete projection. Rebuilt transactionally whenever the row
  // count drifts from the book count (fresh copies always rebuild).
  db.exec(
    `CREATE TABLE IF NOT EXISTS book_list_projection (book INTEGER PRIMARY KEY, rating INTEGER NOT NULL DEFAULT 0);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_book_list_projection_rating ON book_list_projection(rating, book);`,
  );
  const projectionCount = db.query("SELECT COUNT(*) as count FROM book_list_projection").get() as {
    count: number;
  };
  if (projectionCount.count !== bookCount.count) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`DELETE FROM book_list_projection;`);
      db.exec(`INSERT INTO book_list_projection (book, rating)
        SELECT b.id, COALESCE(r.rating, 0)
        FROM books b
        LEFT JOIN books_ratings_link brl ON b.id = brl.book
        LEFT JOIN ratings r ON brl.rating = r.id;`);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  }

  const total = db.query("SELECT COUNT(*) as count FROM books_fts").get() as { count: number };
  console.error(`🔍 FTS index ready (${total.count} books)`);
}

// Pool-backed wrapper: check out a connection, run the snapshot setup on the
// published snapshot, and release. Used for post-copy verification at startup
// and whenever the published snapshot needs an in-place refresh.
function runFtsSetup(): void {
  const db = getDb();
  try {
    setupSnapshotDb(db);
  } finally {
    releaseDb();
  }
}

// Initialize FTS5 virtual table on writable copy — runs once at startup
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function initFTS(): boolean {
  let ready = false;
  try {
    ensureWritableDb();

    runFtsSetup();

    // Warm up: run initial query to populate mmap/cache
    console.error("🔥 Warming up database...");
    const db = getDb();
    try {
      db.query("SELECT COUNT(*) FROM books").get();
      db.query(`
        SELECT b.id FROM books b
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN books_tags_link btl ON b.id = btl.book
        LEFT JOIN data d ON b.id = d.book
        ORDER BY b.sort ASC LIMIT 1
      `).get();
    } finally {
      releaseDb();
    }
    console.error("🔥 Database warm");
    ready = true;
  } catch (error) {
    console.error("📚 Library is not ready:", error instanceof Error ? error.message : error);
  }

  // Low-frequency freshness check, unref'd so it doesn't block process exit.
  if (refreshTimer) return ready;
  refreshTimer = setInterval(() => {
    try {
      const sig = getDatabaseSignature(DB_PATH);
      const snapshot = readSnapshotMetadata();
      if (
        !snapshot ||
        snapshot.sourcePath !== resolve(DB_PATH) ||
        !isSameSignature(snapshot.signature, sig)
      ) {
        console.error("🔄 Source DB changed — refreshing...");
        runRefresh();
      }
    } catch {
      // If stat fails just skip this tick
    }
  }, DB_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer === "object" && refreshTimer !== null && "unref" in refreshTimer) {
    (refreshTimer as NodeJS.Timeout).unref();
  }
  return ready;
}

export interface BookListItem {
  id: number;
  title: string;
  sort: string | null;
  author_sort: string | null;
  authors: string[];
  series: string | null;
  series_index: number;
  tags: string[];
  formats: string[];
  has_cover: boolean;
  pubdate: string;
  timestamp: string;
  rating: number | null;
  publisher?: string | null;
  comments?: string | null;
  isbn?: string;
  uuid?: string;
  path?: string;
  last_modified?: string | null;
}

export interface BookWithDetails extends BookListItem {
  publisher: string | null;
  comments: string | null;
  isbn: string;
  uuid: string;
  path: string;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export type CatalogKind = "authors" | "series" | "tags" | "formats";

export interface CatalogEntry {
  id: number | string;
  title: string;
  sort: string;
  bookCount: number;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

interface BookRow {
  id: number;
  title: string;
  sort: string | null;
  author_sort: string | null;
  series: string | null;
  series_index: number;
  has_cover: number;
  pubdate: string;
  timestamp: string;
  rating: number | null;
  publisher: string | null;
  comments: string | null;
  isbn: string;
  uuid: string;
  path: string;
  last_modified: string | null;
  authors: string | null;
  tags: string | null;
  formats: string | null;
  cursor_sort?: string | number;
}

function splitAggregatedField(value: string | null): string[] {
  if (!value) return [];

  // Current queries use JSON aggregates so commas in author/tag names remain
  // intact. Keep the comma fallback for older writable snapshots.
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  } catch {
    // Legacy GROUP_CONCAT value; fall through to the compatibility parser.
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Parse book row with aggregated fields
function parseBookRow(row: BookRow): BookListItem {
  return {
    id: row.id,
    title: row.title,
    sort: row.sort,
    author_sort: row.author_sort,
    authors: splitAggregatedField(row.authors),
    series: row.series,
    series_index: row.series_index,
    tags: splitAggregatedField(row.tags),
    formats: splitAggregatedField(row.formats),
    has_cover: Boolean(row.has_cover),
    pubdate: row.pubdate,
    timestamp: row.timestamp,
    rating: row.rating,
    // F21: list queries select uuid so acquisition entries can use urn:uuid.
    uuid: row.uuid || undefined,
    last_modified: row.last_modified ?? null,
  };
}

// Parse book row with full details
function parseBookDetailsRow(row: BookRow): BookWithDetails {
  return {
    ...parseBookRow(row),
    publisher: row.publisher,
    comments: row.comments,
    isbn: row.isbn ?? "",
    uuid: row.uuid,
    path: row.path,
  };
}

// Encode cursor from book data using the SQL-computed cursor_sort key so the
// sort value matches SQLite's lower()/COALESCE semantics (JS toLowerCase() is
// Unicode-aware while Bun's SQLite lower() is ASCII-only).
function encodeCursor(row: BookRow, sortBy: SortField): string {
  const sqlSort = row.cursor_sort;
  let sortVal: string | number;
  if (typeof sqlSort === "string") {
    sortVal = sqlSort;
  } else if (typeof sqlSort === "number" && Number.isFinite(sqlSort)) {
    sortVal = sqlSort;
  } else {
    throw new CursorError(
      `Book ${row.id} has no cursor_sort value for ${sortBy} sort; the query must select cursor_sort`,
    );
  }
  const cursorData = { id: row.id, sort: sortVal };
  return Buffer.from(JSON.stringify(cursorData)).toString("base64url");
}

// Decode cursor to get pagination info
function decodeCursor(cursor: string): { id: number; sort: string | number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString();
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "number" ||
      !Number.isSafeInteger(record.id) ||
      record.id <= 0 ||
      (typeof record.sort !== "string" && typeof record.sort !== "number")
    ) {
      return null;
    }
    if (typeof record.sort === "number" && !Number.isFinite(record.sort)) return null;
    return { id: record.id, sort: record.sort };
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined, fallback = 100, max = 200): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : fallback;
  return Math.min(max, Math.max(1, value));
}

function isSafeLibraryPath(filePath: string): boolean {
  const resolvedLibrary = resolve(LIBRARY_PATH);
  const lexicalPath = resolve(filePath);
  if (!lexicalPath.startsWith(`${resolvedLibrary}${sep}`)) return false;

  // Resolve symlinks when the target exists so a Calibre row cannot point
  // outside the configured library through a linked directory.
  if (existsSync(filePath)) {
    try {
      const realLibrary = realpathSync(resolvedLibrary);
      const realFile = realpathSync(filePath);
      return realFile.startsWith(`${realLibrary}${sep}`);
    } catch {
      return false;
    }
  }

  return true;
}

interface ListOptions {
  cursor?: string;
  limit?: number;
  sortBy?: "title" | "author" | "added" | "rating" | "series_index";
  sortOrder?: "asc" | "desc";
  // Tag IDs to filter by (OR logic: a book matches if it has ANY of these tags).
  // Combined with any search/FTS clause via AND.
  tagIds?: number[];
  // F23: when true, exclude metadata-only books (no rows in data) at the
  // query level. Used by OPDS acquisition feeds.
  requireFormats?: boolean;
}

// Build a `b.id IN (...)` clause for OR-logic tag filtering, or "" if none valid.
// Returns the clause fragment and the deduped, valid IDs to bind.
function buildTagFilterClause(
  tagIds: number[] | undefined,
): { clause: string; ids: number[] } {
  if (!tagIds || tagIds.length === 0) return { clause: "", ids: [] };
  const seen = new Set<number>();
  for (const id of tagIds) {
    if (Number.isFinite(id) && id > 0) seen.add(id);
  }
  const ids = Array.from(seen);
  if (ids.length === 0) return { clause: "", ids: [] };
  const placeholders = ids.map(() => "?").join(",");
  return {
    clause: `b.id IN (SELECT book FROM books_tags_link WHERE tag IN (${placeholders}))`,
    ids,
  };
}

const SORT_FIELDS = ["title", "author", "added", "rating", "series_index"] as const;

type SortField = (typeof SORT_FIELDS)[number];

function normalizeSortBy(sortBy: ListOptions["sortBy"]): SortField {
  if (sortBy && (SORT_FIELDS as readonly string[]).includes(sortBy)) {
    return sortBy;
  }
  return "title";
}

// Normalized sort-key expressions, defined once. buildCursorSortExpression,
// buildBookOrderBy, and appendBookCursorWhere must all use these exact
// strings (plus the matching expression indexes in runFtsSetup) so ORDER BY,
// cursor predicates, and index seeks agree byte-for-byte.
const BOOK_SORT_EXPRESSIONS = {
  title: `COALESCE(NULLIF(lower(b.sort), ''), lower(b.title))`,
  author: `COALESCE(lower(b.author_sort), '')`,
  added: `COALESCE(b.timestamp, '')`,
  // Rating orders the materialized book_list_projection (joined as `p` in the
  // rating page query); unrated books are stored as 0, preserving the old
  // COALESCE(r.rating, 0) semantics. Indexed by idx_book_list_projection_rating.
  rating: `p.rating`,
  series_index: `COALESCE(b.series_index, 1)`,
} as const;

// SQL expression computing the cursor sort key; must match buildBookOrderBy
// and the cursor predicates in appendBookCursorWhere exactly.
function buildCursorSortExpression(sortBy: SortField): string {
  switch (sortBy) {
    case "title":
      return BOOK_SORT_EXPRESSIONS.title;
    case "author":
      return BOOK_SORT_EXPRESSIONS.author;
    case "added":
      return BOOK_SORT_EXPRESSIONS.added;
    case "rating":
      return BOOK_SORT_EXPRESSIONS.rating;
    case "series_index":
      return BOOK_SORT_EXPRESSIONS.series_index;
    default:
      return BOOK_SORT_EXPRESSIONS.title;
  }
}

function buildBookOrderBy(
  sortBy: NonNullable<ListOptions["sortBy"]>,
  sortOrder: NonNullable<ListOptions["sortOrder"]>,
): string {
  const dir = sortOrder.toUpperCase();
  const expr =
    sortBy === "author"
      ? BOOK_SORT_EXPRESSIONS.author
      : sortBy === "added"
        ? BOOK_SORT_EXPRESSIONS.added
        : sortBy === "rating"
          ? BOOK_SORT_EXPRESSIONS.rating
          : sortBy === "series_index"
            ? BOOK_SORT_EXPRESSIONS.series_index
            : BOOK_SORT_EXPRESSIONS.title;
  return `ORDER BY ${expr} ${dir}, b.id ${dir}`;
}

function appendBookCursorWhere(
  bookWhere: string,
  params: (string | number)[],
  options: ListOptions,
): string {
  if (!options.cursor) return bookWhere;

  const cursorData = decodeCursor(options.cursor);
  if (!cursorData) {
    throw new CursorError("Invalid cursor");
  }

  const sortBy = normalizeSortBy(options.sortBy);
  const sortOrder = options.sortOrder || "asc";
  const sortOp = sortOrder === "asc" ? ">" : "<";
  // Explicit seek bound (sargable range edge) paired with the OR tie-break
  // below: `key >= ? AND (key > ? OR (key = ? AND id > ?))` for ASC
  // (`<=`/`<` for DESC). The bound lets SQLite range-seek on the matching
  // expression index; the OR disjunct preserves exact keyset semantics.
  const seekOp = sortOrder === "asc" ? ">=" : "<=";
  const expr = buildCursorSortExpression(sortBy);

  if (sortBy === "rating") {
    if (typeof cursorData.sort !== "number" || !Number.isFinite(cursorData.sort)) {
      throw new CursorError("Cursor sort value does not match rating sort");
    }
    params.push(cursorData.sort, cursorData.sort, cursorData.sort, cursorData.id);
    return `${bookWhere} AND ${expr} ${seekOp} ? AND (${expr} ${sortOp} ? OR (${expr} = ? AND b.id ${sortOp} ?))`;
  }

  if (sortBy === "series_index") {
    if (typeof cursorData.sort !== "number" || !Number.isFinite(cursorData.sort)) {
      throw new CursorError("Cursor sort value does not match series_index sort");
    }
    params.push(cursorData.sort, cursorData.sort, cursorData.sort, cursorData.id);
    return `${bookWhere} AND ${expr} ${seekOp} ? AND (${expr} ${sortOp} ? OR (${expr} = ? AND b.id ${sortOp} ?))`;
  }

  const expectedError =
    sortBy === "author"
      ? "Cursor sort value does not match author sort"
      : sortBy === "added"
        ? "Cursor sort value does not match added sort"
        : "Cursor sort value does not match title sort";
  if (typeof cursorData.sort !== "string") {
    throw new CursorError(expectedError);
  }
  params.push(cursorData.sort, cursorData.sort, cursorData.sort, cursorData.id);
  return `${bookWhere} AND ${expr} ${seekOp} ? AND (${expr} ${sortOp} ? OR (${expr} = ? AND b.id ${sortOp} ?))`;
}

function listBooksWithWhere(
  options: ListOptions = {},
  initialWhere: string = "WHERE 1=1",
  initialParams: (string | number)[] = [],
): CursorPaginatedResult<BookListItem> {
  const db = getDb();
  try {
    const limit = clampLimit(options.limit);
    const sortBy = normalizeSortBy(options.sortBy);
    const sortOrder = options.sortOrder || "asc";
    const dir = sortOrder.toUpperCase();
    const params = [...initialParams];
    const needsRatingInCte = sortBy === "rating";
    // OR-logic tag filter is part of the base predicate (inside the page
    // query's WHERE), so it composes with search/FTS via AND and is covered
    // by idx_books_tags_link_tag.
    const tagFilter = buildTagFilterClause(options.tagIds);
    const baseWhere =
      tagFilter.clause.length > 0 ? `${initialWhere} AND ${tagFilter.clause}` : initialWhere;
    if (tagFilter.ids.length > 0) params.push(...tagFilter.ids);
    // F23: exclude metadata-only books (no formats) at the query level.
    const formatsWhere = options.requireFormats
      ? `${baseWhere} AND EXISTS (SELECT 1 FROM data d WHERE d.book = b.id)`
      : baseWhere;
    const bookWhere = appendBookCursorWhere(formatsWhere, params, options);
    const bookOrderBy = buildBookOrderBy(sortBy, sortOrder);

    // Phase 1: fetch just the page of IDs (+ cursor sort keys). No fan-out
    // joins here, so the keyset seek stays O(log n) regardless of how many
    // authors/tags/formats each book has.
    interface PageRow {
      id: number;
      cursor_sort: string | number;
      rating_val?: number | null;
    }
    let pageQuery: string;
    if (needsRatingInCte) {
      // Rating orders the materialized projection (unrated = 0): the JOIN
      // against book_list_projection AS p seeks idx_book_list_projection_rating
      // for both the ORDER BY and the cursor predicate (BOOK_SORT_EXPRESSIONS.rating
      // is `p.rating`, matching the index key exactly).
      pageQuery = `
        SELECT b.id, p.rating AS rating_val,
               p.rating AS cursor_sort
        FROM books b
        JOIN book_list_projection p ON p.book = b.id
        ${bookWhere}
        ORDER BY p.rating ${dir}, b.id ${dir}
        LIMIT ${limit + 1}
      `;
    } else {
      pageQuery = `
        SELECT b.id, ${buildCursorSortExpression(sortBy)} AS cursor_sort
        FROM books b
        ${bookWhere}
        ${bookOrderBy}
        LIMIT ${limit + 1}
      `;
    }

    const pageRows = db.query(pageQuery).all(...params) as PageRow[];
    const hasMore = pageRows.length > limit;
    const page = pageRows.slice(0, limit);
    if (page.length === 0) {
      return { items: [], nextCursor: null, hasMore };
    }
    const ids = page.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");

    // Phase 2: base columns + series/rating for exactly this page.
    interface BaseRow {
      id: number;
      title: string;
      sort: string | null;
      author_sort: string | null;
      series_index: number;
      has_cover: number;
      pubdate: string;
      timestamp: string;
      last_modified: string | null;
      uuid: string;
      series: string | null;
      rating: number | null;
    }
    const baseRows = db
      .query(
        `SELECT b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover,
                b.pubdate, b.timestamp, b.last_modified, b.uuid, s.name as series, r.rating
         FROM books b
         LEFT JOIN books_series_link bsl ON b.id = bsl.book
         LEFT JOIN series s ON bsl.series = s.id
         LEFT JOIN books_ratings_link brl ON b.id = brl.book
         LEFT JOIN ratings r ON brl.rating = r.id
         WHERE b.id IN (${placeholders})`,
      )
      .all(...ids) as BaseRow[];
    const baseById = new Map<number, BaseRow>();
    for (const row of baseRows) baseById.set(row.id, row);

    // Phase 3: one aggregate query per multi-valued facet (authors, tags,
    // formats) over the page's IDs — avoids the fan-out of joining all link
    // tables in a single GROUP BY.
    function loadFacet(sql: string): Map<number, string[]> {
      const rows = db.query(sql).all(...ids) as Array<{ book: number; name: string }>;
      const byId = new Map<number, string[]>();
      for (const row of rows) {
        if (row.name == null) continue;
        const label = String(row.name).trim();
        if (!label) continue;
        const list = byId.get(row.book);
        if (list) {
          if (!list.includes(label)) list.push(label);
        } else {
          byId.set(row.book, [label]);
        }
      }
      return byId;
    }
    const authorsById = loadFacet(
      `SELECT bal.book as book, a.name as name FROM books_authors_link bal JOIN authors a ON bal.author = a.id WHERE bal.book IN (${placeholders})`,
    );
    const tagsById = loadFacet(
      `SELECT btl.book as book, t.name as name FROM books_tags_link btl JOIN tags t ON btl.tag = t.id WHERE btl.book IN (${placeholders})`,
    );
    const formatsById = loadFacet(
      `SELECT d.book as book, d.format as name FROM data d WHERE d.book IN (${placeholders})`,
    );

    const ratingById = new Map<number, number | null>();
    for (const row of page) {
      if (typeof row.rating_val === "number") ratingById.set(row.id, row.rating_val);
    }

    const items: BookListItem[] = [];
    for (const row of page) {
      const base = baseById.get(row.id);
      if (!base) continue;
      items.push({
        id: base.id,
        title: base.title,
        sort: base.sort,
        author_sort: base.author_sort,
        authors: authorsById.get(base.id) ?? [],
        series: base.series,
        series_index: base.series_index,
        tags: tagsById.get(base.id) ?? [],
        formats: formatsById.get(base.id) ?? [],
        has_cover: Boolean(base.has_cover),
        pubdate: base.pubdate,
        timestamp: base.timestamp,
        rating: ratingById.get(base.id) ?? base.rating,
        uuid: base.uuid || undefined,
        last_modified: base.last_modified ?? null,
      });
    }

    const lastPageRow = hasMore ? page[page.length - 1] : undefined;
    const nextCursor =
      lastPageRow && items.length > 0
        ? encodeCursor(
            { ...baseById.get(lastPageRow.id), id: lastPageRow.id, cursor_sort: lastPageRow.cursor_sort } as BookRow,
            sortBy,
          )
        : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
  } finally {
    releaseDb();
  }
}

// Cursor-based paginated list with CTE for O(1) performance
export function listBooksCursor(options: ListOptions = {}): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(options);
}

interface SearchOptions extends ListOptions {
  query: string;
}

// FTS-powered search with cursor pagination
export function searchBooksCursor(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const searchQuery = options.query.trim();

  if (!searchQuery) {
    return listBooksCursor(options);
  }

  // Use FTS5 for fast full-text search
  return ftsSearch(options);
}

// FTS5-powered search
function ftsSearch(options: SearchOptions): CursorPaginatedResult<BookListItem> {
  const limit = clampLimit(options.limit);

  // Build FTS query: quote each word and join with AND
  const words = options.query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    return listBooksCursor({ ...options, limit });
  }

  // Escape double quotes and wrap each word as a prefix search
  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");
  return listBooksWithWhere(
    { ...options, limit },
    `WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)`,
    [ftsQuery],
  );
}

export function listBooksByAuthorCursor(
  authorId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM books_authors_link WHERE author = ?)",
    [authorId],
  );
}

export function listBooksBySeriesCursor(
  seriesId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  // F25: series feeds default to series_index order (ORDER BY series_index, id).
  return listBooksWithWhere(
    { sortOrder: "asc", ...options, sortBy: options.sortBy ?? "series_index" },
    "WHERE b.id IN (SELECT book FROM books_series_link WHERE series = ?)",
    [seriesId],
  );
}

export function listBooksByTagCursor(
  tagId: number,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM books_tags_link WHERE tag = ?)",
    [tagId],
  );
}

export function listBooksByFormatCursor(
  format: string,
  options: ListOptions = {},
): CursorPaginatedResult<BookListItem> {
  return listBooksWithWhere(
    options,
    "WHERE b.id IN (SELECT book FROM data WHERE format = ?)",
    [format.toUpperCase()],
  );
}

// Get book details by ID
export function getBookByIdOptimized(id: number): BookWithDetails | null {
  const db = getDb();

  try {
    const query = `
      WITH book_page AS (
        SELECT
          b.id,
          b.title,
          b.sort,
          b.author_sort,
          b.series_index,
          b.has_cover,
          b.pubdate,
          b.timestamp,
          b.last_modified,
          isbn_identifier.val as isbn,
          b.uuid,
          b.path
        FROM books b
        LEFT JOIN identifiers isbn_identifier
          ON b.id = isbn_identifier.book
          AND isbn_identifier.type = 'isbn'
        WHERE b.id = ?
      )
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        b.last_modified,
        b.isbn,
        b.uuid,
        b.path,
        s.name as series,
        r.rating,
        p.name as publisher,
        c.text as comments,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM book_page b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
      LEFT JOIN publishers p ON bpl.publisher = p.id
      LEFT JOIN comments c ON b.id = c.book
      GROUP BY b.id
    `;

    const row = db.query(query).get(id) as BookRow | undefined;

    if (!row) return null;

    return parseBookDetailsRow(row);
  } finally {
    releaseDb();
  }
}

// Batched book-details lookup: single WHERE id IN (...) base query plus one
// aggregate query per multi-valued facet, instead of one getBookByIdOptimized
// round-trip per row. Returns a map of found books by id.
export function getBooksByIdsOptimized(ids: number[]): Map<number, BookWithDetails> {
  const seen = new Set<number>();
  for (const id of ids) {
    if (Number.isSafeInteger(id) && id > 0) seen.add(id);
    if (seen.size >= 500) break;
  }
  const unique = Array.from(seen);
  const found = new Map<number, BookWithDetails>();
  if (unique.length === 0) return found;

  const db = getDb();
  try {
    const placeholders = unique.map(() => "?").join(",");
    const baseRows = db
      .query(
        `SELECT
           b.id, b.title, b.sort, b.author_sort, b.series_index, b.has_cover,
           b.pubdate, b.timestamp, b.last_modified,
           isbn_identifier.val as isbn, b.uuid, b.path,
           s.name as series, r.rating, p.name as publisher, c.text as comments
         FROM books b
         LEFT JOIN identifiers isbn_identifier
           ON b.id = isbn_identifier.book
           AND isbn_identifier.type = 'isbn'
         LEFT JOIN books_series_link bsl ON b.id = bsl.book
         LEFT JOIN series s ON bsl.series = s.id
         LEFT JOIN books_ratings_link brl ON b.id = brl.book
         LEFT JOIN ratings r ON brl.rating = r.id
         LEFT JOIN books_publishers_link bpl ON b.id = bpl.book
         LEFT JOIN publishers p ON bpl.publisher = p.id
         LEFT JOIN comments c ON b.id = c.book
         WHERE b.id IN (${placeholders})`,
      )
      .all(...unique) as BookRow[];

    const facet = (sql: string): Map<number, string[]> => {
      const rows = db.query(sql).all(...unique) as Array<{ book: number; name: string }>;
      const byId = new Map<number, string[]>();
      for (const row of rows) {
        if (row.name == null) continue;
        const label = String(row.name).trim();
        if (!label) continue;
        const list = byId.get(row.book);
        if (list) {
          if (!list.includes(label)) list.push(label);
        } else {
          byId.set(row.book, [label]);
        }
      }
      return byId;
    };
    const authorsById = facet(
      `SELECT bal.book as book, a.name as name FROM books_authors_link bal JOIN authors a ON bal.author = a.id WHERE bal.book IN (${placeholders})`,
    );
    const tagsById = facet(
      `SELECT btl.book as book, t.name as name FROM books_tags_link btl JOIN tags t ON btl.tag = t.id WHERE btl.book IN (${placeholders})`,
    );
    const formatsById = facet(
      `SELECT d.book as book, d.format as name FROM data d WHERE d.book IN (${placeholders})`,
    );

    for (const row of baseRows) {
      found.set(
        row.id,
        parseBookDetailsRow({
          ...row,
          authors: JSON.stringify(authorsById.get(row.id) ?? []),
          tags: JSON.stringify(tagsById.get(row.id) ?? []),
          formats: JSON.stringify(formatsById.get(row.id) ?? []),
        }),
      );
    }
    return found;
  } finally {
    releaseDb();
  }
}

// Get total book count
export function getBookCount(): number {
  const db = getDb();
  try {
    const result = db.query("SELECT COUNT(*) as count FROM books").get() as { count: number };
    return result.count;
  } finally {
    releaseDb();
  }
}

// Get library stats
export function getLibraryStats(): {
  totalBooks: number;
  totalAuthors: number;
  totalSeries: number;
  totalTags: number;
} {
  const db = getDb();

  try {
    const stats = db
      .query(
        `SELECT
          (SELECT COUNT(*) FROM books) as totalBooks,
          (SELECT COUNT(*) FROM authors) as totalAuthors,
          (SELECT COUNT(*) FROM series) as totalSeries,
          (SELECT COUNT(*) FROM tags) as totalTags`,
      )
      .get() as { totalBooks: number; totalAuthors: number; totalSeries: number; totalTags: number };

    return stats;
  } finally {
    releaseDb();
  }
}

interface CatalogOptions {
  cursor?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
}

function encodeCatalogCursor(entry: CatalogEntry): string {
  return Buffer.from(JSON.stringify({ id: entry.id, sort: entry.sort })).toString("base64url");
}

function decodeCatalogCursor(cursor: string): { id: number | string; sort: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString();
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const { id, sort } = record;
    const validId =
      (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" && id.length > 0);
    if (!validId || typeof sort !== "string") return null;
    return { id, sort };
  } catch {
    return null;
  }
}

function listCatalogEntries(
  kind: CatalogKind,
  options: CatalogOptions = {},
): CursorPaginatedResult<CatalogEntry> {
  const db = getDb();
  try {
    const limit = clampLimit(options.limit);
    const sortOrder = options.sortOrder || "asc";
    const dir = sortOrder.toUpperCase();
    const sortOp = sortOrder === "asc" ? ">" : "<";

    const cursorData = options.cursor ? decodeCatalogCursor(options.cursor) : null;
    if (options.cursor && !cursorData) {
      throw new CursorError("Invalid cursor");
    }
    const cursorWhere = cursorData
      ? `WHERE (sort ${sortOp} ? OR (sort = ? AND id ${sortOp} ?))`
      : "";
    const cursorParams = cursorData ? [cursorData.sort, cursorData.sort, cursorData.id] : [];

    let catalogCte: string;
    switch (kind) {
      case "authors":
        catalogCte = `
          SELECT
            a.id,
            a.name AS title,
            LOWER(COALESCE(a.sort, a.name)) AS sort,
            COUNT(DISTINCT bal.book) AS bookCount
          FROM authors a
          JOIN books_authors_link bal ON a.id = bal.author
          GROUP BY a.id
        `;
        break;
      case "series":
        catalogCte = `
          SELECT
            s.id,
            s.name AS title,
            LOWER(COALESCE(s.sort, s.name)) AS sort,
            COUNT(DISTINCT bsl.book) AS bookCount
          FROM series s
          JOIN books_series_link bsl ON s.id = bsl.series
          GROUP BY s.id
        `;
        break;
      case "tags":
        catalogCte = `
          SELECT
            t.id,
            t.name AS title,
            LOWER(t.name) AS sort,
            COUNT(DISTINCT btl.book) AS bookCount
          FROM tags t
          JOIN books_tags_link btl ON t.id = btl.tag
          GROUP BY t.id
        `;
        break;
      case "formats":
        catalogCte = `
          SELECT
            UPPER(d.format) AS id,
            UPPER(d.format) AS title,
            LOWER(d.format) AS sort,
            COUNT(DISTINCT d.book) AS bookCount
          FROM data d
          GROUP BY UPPER(d.format)
        `;
        break;
    }

    const query = `
      WITH catalog AS (${catalogCte})
      SELECT id, title, sort, bookCount
      FROM catalog
      ${cursorWhere}
      ORDER BY sort ${dir}, id ${dir}
      LIMIT ${limit + 1}
    `;

    const rows = db.query(query).all(...cursorParams) as CatalogEntry[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCatalogCursor(lastItem) : null;

    return { items, nextCursor, hasMore };
  } finally {
    releaseDb();
  }
}

export function listAuthorsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("authors", options);
}

export function listSeriesCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("series", options);
}

export function listTagsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("tags", options);
}

export function listFormatsCursor(options: CatalogOptions = {}): CursorPaginatedResult<CatalogEntry> {
  return listCatalogEntries("formats", options);
}

// All tags with book counts, most-popular-first — drives the tag filter UI.
export interface TagSummary {
  id: number;
  name: string;
  bookCount: number;
}

export function listAllTags(limit: number = 2000): TagSummary[] {
  const db = getDb();
  try {
    const capped = Math.min(Math.max(Math.floor(limit) || 1, 1), 5000);
    const rows = db
      .query(
        `SELECT
          t.id AS id,
          t.name AS name,
          COUNT(DISTINCT btl.book) AS bookCount
        FROM tags t
        JOIN books_tags_link btl ON t.id = btl.tag
        GROUP BY t.id
        ORDER BY bookCount DESC, t.name COLLATE NOCASE ASC
        LIMIT ?`,
      )
      .all(capped) as TagSummary[];
    return rows;
  } finally {
    releaseDb();
  }
}

export function getCatalogEntry(kind: CatalogKind, id: number | string): CatalogEntry | null {
  const db = getDb();
  try {
    if (kind === "formats") {
      const format = String(id).toUpperCase();
      const row = db
        .query(`
          SELECT
            UPPER(d.format) AS id,
            UPPER(d.format) AS title,
            LOWER(d.format) AS sort,
            COUNT(DISTINCT d.book) AS bookCount
          FROM data d
          WHERE d.format = ?
          GROUP BY UPPER(d.format)
        `)
        .get(format) as CatalogEntry | null;
      return row ?? null;
    }

    const numericId = typeof id === "number" ? id : Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId)) return null;

    const catalogQueries: Record<Exclude<CatalogKind, "formats">, string> = {
      authors: `
        SELECT
          a.id,
          a.name AS title,
          LOWER(COALESCE(a.sort, a.name)) AS sort,
          COUNT(DISTINCT bal.book) AS bookCount
        FROM authors a
        JOIN books_authors_link bal ON a.id = bal.author
        WHERE a.id = ?
        GROUP BY a.id
      `,
      series: `
        SELECT
          s.id,
          s.name AS title,
          LOWER(COALESCE(s.sort, s.name)) AS sort,
          COUNT(DISTINCT bsl.book) AS bookCount
        FROM series s
        JOIN books_series_link bsl ON s.id = bsl.series
        WHERE s.id = ?
        GROUP BY s.id
      `,
      tags: `
        SELECT
          t.id,
          t.name AS title,
          LOWER(t.name) AS sort,
          COUNT(DISTINCT btl.book) AS bookCount
        FROM tags t
        JOIN books_tags_link btl ON t.id = btl.tag
        WHERE t.id = ?
        GROUP BY t.id
      `,
    };

    const row = db.query(catalogQueries[kind]).get(numericId) as CatalogEntry | null;
    return row ?? null;
  } finally {
    releaseDb();
  }
}

// Search books by title — uses FTS5 prefix MATCH for O(log n) performance
export function searchBooksByTitle(title: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const cappedLimit = clampLimit(limit, 10, 200);

  try {
    const words = title
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length === 0) return [];

    const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");

    const query = `
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        s.name as series,
        r.rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      WHERE b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)
      GROUP BY b.id
      ORDER BY b.sort ASC
      LIMIT ?
    `;

    const results = db.query(query).all(ftsQuery, cappedLimit) as BookRow[];

    return results.map(parseBookRow);
  } finally {
    releaseDb();
  }
}

// Search books by author name
export function searchBooksByAuthor(authorName: string, limit: number = 10): BookListItem[] {
  const db = getDb();
  const cappedLimit = clampLimit(limit, 10, 200);
  const searchTerm = `%${authorName.trim()}%`;

  try {
    const query = `
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        s.name as series,
        r.rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM books b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      WHERE b.id IN (
        SELECT bal2.book
        FROM books_authors_link bal2
        JOIN authors a2 ON bal2.author = a2.id
        WHERE a2.name LIKE ? OR a2.sort LIKE ?
      )
      GROUP BY b.id
      ORDER BY b.sort ASC
      LIMIT ?
    `;

    const results = db.query(query).all(searchTerm, searchTerm, cappedLimit) as BookRow[];

    return results.map(parseBookRow);
  } finally {
    releaseDb();
  }
}

// Get author info by name
export function getAuthorByName(authorName: string): { name: string; bookCount: number } | null {
  const db = getDb();
  const searchTerm = `%${authorName.trim()}%`;

  try {
    const query = `
      SELECT a.name, COUNT(bal.book) as book_count
      FROM authors a
      LEFT JOIN books_authors_link bal ON a.id = bal.author
      WHERE a.name LIKE ? OR a.sort LIKE ?
      GROUP BY a.id
      ORDER BY book_count DESC
      LIMIT 1
    `;

    const result = db.query(query).get(searchTerm, searchTerm) as {
      name: string;
      book_count: number;
    } | null;

    if (!result) return null;

    return {
      name: result.name,
      bookCount: result.book_count,
    };
  } finally {
    releaseDb();
  }
}

// Stream books in chunks for massive exports
export async function* streamBooks(
  batchSize: number = 1000,
): AsyncGenerator<BookListItem[], void, unknown> {
  const effectiveBatchSize = clampLimit(batchSize, 1000, 5000);
  let lastId = 0;
  while (true) {
    const db = getDb();
    let rows: BookRow[];
    try {
      const query = `
      WITH book_page AS (
        SELECT
          b.id,
          b.title,
          b.sort,
          b.author_sort,
          b.series_index,
          b.has_cover,
          b.pubdate,
          b.timestamp
        FROM books b
        WHERE b.id > ?
        ORDER BY b.id ASC
        LIMIT ?
      )
      SELECT
        b.id,
        b.title,
        b.sort,
        b.author_sort,
        b.series_index,
        b.has_cover,
        b.pubdate,
        b.timestamp,
        s.name as series,
        r.rating,
        json_group_array(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as authors,
        json_group_array(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as tags,
        json_group_array(DISTINCT d.format) FILTER (WHERE d.format IS NOT NULL) as formats
      FROM book_page b
      LEFT JOIN books_authors_link bal ON b.id = bal.book
      LEFT JOIN authors a ON bal.author = a.id
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON bsl.series = s.id
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON btl.tag = t.id
      LEFT JOIN data d ON b.id = d.book
      LEFT JOIN books_ratings_link brl ON b.id = brl.book
      LEFT JOIN ratings r ON brl.rating = r.id
      GROUP BY b.id
      ORDER BY b.id ASC
    `;

      rows = db.query(query).all(lastId, effectiveBatchSize) as BookRow[];
    } finally {
      releaseDb();
    }

    if (rows.length === 0) break;

    const items = rows.map(parseBookRow);
    const lastItem = items[items.length - 1];
    if (!lastItem) break;
    lastId = lastItem.id;

    yield items;

    if (rows.length < effectiveBatchSize) break;
  }
}

// Get file paths for downloads
export function getLibraryPath(): string {
  return LIBRARY_PATH;
}

export function getBookTitle(id: number): string | null {
  const db = getDb();
  try {
    const row = db.query("SELECT title FROM books WHERE id = ?").get(id) as
      | { title: string }
      | undefined;
    return row?.title ?? null;
  } finally {
    releaseDb();
  }
}

export function getBookFormatPath(bookId: number, format: string): string | null {
  const db = getDb();

  try {
    const row = db
      .query(`
      SELECT b.path, d.name
      FROM books b
      JOIN data d ON b.id = d.book
      WHERE b.id = ? AND d.format = ?
    `)
      .get(bookId, format.toUpperCase()) as { path: string; name: string } | undefined;

    if (!row) return null;

    const ext = format.toLowerCase();
    const filePath = join(LIBRARY_PATH, row.path, `${row.name}.${ext}`);
    if (!isSafeLibraryPath(filePath)) return null;
    return filePath;
  } finally {
    releaseDb();
  }
}

export function getBookCoverPath(bookId: number): string | null {
  const db = getDb();

  try {
    const row = db.query("SELECT path, has_cover FROM books WHERE id = ?").get(bookId) as
      | { path: string; has_cover: number }
      | undefined;

    if (!row || !row.has_cover) return null;

    const filePath = join(LIBRARY_PATH, row.path, "cover.jpg");
    if (!isSafeLibraryPath(filePath)) return null;
    return filePath;
  } finally {
    releaseDb();
  }
}
