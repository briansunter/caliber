# Caliber Rust Backend — Master Contract

This document is the binding contract between the three implementation crates.
The TypeScript implementation under `src/` is the behavioral reference — read
it before implementing. The React frontend is preserved unchanged; every JSON
payload, header, and status code below is a wire contract.

- Shared types live in `crates/caliber-common` (already implemented — read its
  source: `types.rs`, `cursor.rs`, `wyhash.rs`, `signature.rs`, `config.rs`).
- Rust edition 2021, no `unsafe`, `cargo fmt` clean, `cargo test -p <crate>` green.
- Never edit files outside your crate. Never edit TS files. Never commit.
- Fixture databases in tests only (tempfile). Never touch a real Calibre
  library or a real `users.db`/`config.json`.
- Where full parity is impractical, degrade explicitly (correct status code +
  clear error) and record it in `crates/<crate>/PARITY.md`. Never fake success.

Error → HTTP mapping (server crate owns the mapping, others expose typed errors):

| Source | HTTP | Body |
|---|---|---|
| Invalid/corrupt cursor, sort-type mismatch | 400 | `{"error":"Invalid cursor"}` |
| Library selection invalid (`ConfigError::Library`) | 400 | `{"error": msg}` |
| Auth config rejected (`ConfigError::Auth`) | 400 | `{"error": msg}` |
| Password invalid (`PasswordError`) | 400 | `{"error": msg}` |
| Book/format/author/etc. not found | 404 | `{"error":"..."}` per TS |
| EpubCacheError | status carried | `{"error": msg, "code": code}` |
| PageStreamingError | status carried | `{"error": msg}` |
| Host header not allowed | 421 | `{"error":"Request host is not allowed"}` |
| everything else | 500 | route-specific `{"error":"Failed to ..."}` |

---

## A. `caliber-db` — data layer (reference: `src/lib/calibre-optimized.ts`, `src/lib/config.ts`, `src/lib/file-signature.ts`)

### Public API (exact signatures)

```rust
pub struct CaliberDb { /* pool, generations, leases, refresh thread */ }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus { pub generation: u64, pub revision: u64, pub stale: bool,
    pub refreshing: bool, pub failed: Option<String> }

#[derive(Debug)]
pub enum DbError { InvalidCursor, NotReady(String), Io(String), Internal(String) }

impl CaliberDb {
    pub fn open(config: caliber_common::Config) -> CaliberDb;
    /// initFTS(): build/verify snapshot + FTS, warm up, start refresh timer.
    /// Returns readiness; false leaves the server up for Settings-driven
    /// library selection (mirrors TS `initFTS()`).
    pub fn init(&self) -> bool;
    pub fn is_ready(&self) -> bool;
    pub fn snapshot_revision(&self) -> u64;          // cache-key component
    pub fn snapshot_updated_iso(&self) -> String;    // snapshot file mtime ISO-8601; epoch on error
    pub fn snapshot_status(&self) -> SnapshotStatus;
    /// Pins the current generation; refresh defers until all leases and pool
    /// checkouts release. Clone-able RAII guard.
    pub fn acquire_snapshot_lease(&self) -> SnapshotLease;
    /// Re-point at Config's (new) library and rebuild snapshot. Defers while
    /// leases/checkouts are held (mirrors reconfigureLibraryDatabase).
    pub fn reconfigure_library(&self) -> Result<(), DbError>;
    pub fn register_refresh_callback(&self, cb: Box<dyn Fn() + Send + Sync>);

    pub fn list_books(&self, opts: &ListOptions) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    /// FTS5 search; empty/whitespace query delegates to list_books.
    pub fn search_books(&self, opts: &ListOptions, query: &str) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    pub fn list_books_by_author(&self, author_id: i64, opts: &ListOptions) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    /// Defaults sortBy=series_index when opts.sort_by is None (TS F25).
    pub fn list_books_by_series(&self, series_id: i64, opts: &ListOptions) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    pub fn list_books_by_tag(&self, tag_id: i64, opts: &ListOptions) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    pub fn list_books_by_format(&self, format: &str, opts: &ListOptions) -> Result<CursorPaginatedResult<BookListItem>, DbError>;
    pub fn get_book(&self, id: i64) -> Result<Option<BookWithDetails>, DbError>;
    /// Batched details lookup; dedups, caps at 500 ids (TS getBooksByIdsOptimized).
    pub fn get_books_by_ids(&self, ids: &[i64]) -> HashMap<i64, BookWithDetails>;
    pub fn get_book_count(&self) -> Result<i64, DbError>;
    pub fn get_library_stats(&self) -> Result<LibraryStats, DbError>;

    pub fn list_authors(&self, opts: &CatalogOptions) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    pub fn list_series(&self, opts: &CatalogOptions) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    pub fn list_tags(&self, opts: &CatalogOptions) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    pub fn list_formats(&self, opts: &CatalogOptions) -> Result<CursorPaginatedResult<CatalogEntry>, DbError>;
    pub fn get_catalog_entry(&self, kind: CatalogKind, id: &CatalogId) -> Option<CatalogEntry>;
    pub fn list_all_tags(&self, limit: u32) -> Vec<TagSummary>;       // clamp 1..=5000, default 2000
    pub fn list_all_formats(&self) -> Vec<FormatSummary>;
    pub fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem>;  // clamp default 10 max 200
    pub fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem>;
    pub fn get_author_by_name(&self, name: &str) -> Option<AuthorInfo>;

    /// One id-ordered batch for /api/books/stream and CLI stream.
    /// `WHERE b.id > last_id ORDER BY b.id ASC LIMIT batch` (clamped 1..=5000,
    /// default 1000) with the TS stream column set (no uuid/last_modified —
    /// the TS stream query omits them; keep rows identical to TS).
    pub fn stream_books_batch(&self, last_id: i64, batch_size: u32) -> Result<Vec<BookListItem>, DbError>;

    pub fn library_path(&self) -> PathBuf;                          // live from Config
    pub fn book_title(&self, id: i64) -> Option<String>;
    /// join(library, b.path, "{d.name}.{format.to_lowercase()}") + containment check.
    pub fn book_format_path(&self, book_id: i64, format: &str) -> Option<PathBuf>;
    /// join(library, b.path, "cover.jpg") when has_cover; + containment check.
    pub fn book_cover_path(&self, book_id: i64) -> Option<PathBuf>;
}

/// PUT /api/config/library backend: prepare (path validation via Config) →
/// Calibre schema validation (books/authors/data/books_authors_link tables) →
/// apply. Mirrors TS saveLibraryConfig including its error strings.
pub fn save_library_config_with_validation(
    config: &caliber_common::Config,
    selection: caliber_common::config::LibrarySelection,
) -> Result<caliber_common::LibraryConfigStatus, caliber_common::ConfigError>;
```

### Required internal behavior (port from TS, byte-identical SQL where noted)

1. **Snapshot engine** (`copyDbToWritable`/`ensureWritableDb`/`swapDatabaseFile`):
   - Snapshot path `<config_dir>/metadata.db`; signature sidecar
     `<config_dir>/metadata.source.json` = `{"sourcePath": <abs>, "signature": <SourceSignature>}` (camelCase, trailing newline like TS).
   - Build in `metadata.db.gen-{n}.tmp-{pid}` using a SQLite **backup** from the
     read-only source (equivalent of TS `db.serialize()`), then fsync, then run
     `setup_snapshot_db` inside the tmp file, then rename-publish (EEXIST/EPERM
     → unlink + rename), fsync file + dir best-effort, retain previous
     generation as `metadata.db.prev-{id}`, prune when no checkouts/leases.
   - Cross-process lock: `create_dir(<config_dir>/snapshot.lock)`; on
     EEXIST defer (refresh_pending). Test hook: `CALIBER_SNAPSHOT_FAULT=1`
     aborts after tmp build, before rename; tmp must be cleaned, published gen
     untouched, error surfaced in `SnapshotStatus.failed`.
   - Generations: monotonic id + revision; revision bumps on publish.
   - Refresh thread at `config.db_refresh_interval_ms` comparing
     `database_signature(source)` to the sidecar (path + signature must match).
   - Pool of 5 connections with pragmas `cache_size=-64000`,
     `temp_store=memory`, `mmap_size=268435456`, `journal_mode=WAL`; checkouts
     refcounted; refresh deferred while checkouts or leases exist, retriggered
     on last release.
2. **`setup_snapshot_db`**: create every index from TS (expression indexes
   must match `book_sort_expression()` exactly, aliases stripped), FTS5
   `books_fts(title, author_sort, content='books', content_rowid='id')`,
   `caliber_fts_meta` with `fts_schema_version='3'` + `source_signature`,
   rebuild verification probes, `book_list_projection` + rating index + count
   rebuild. Use the TS SQL verbatim (see file lines ~509–696).
3. **Listing engine** (`listBooksWithWhere`): two-phase page query (ids +
   `cursor_sort` computed **in SQL** — never recompute sort keys in Rust),
   then base-row + per-facet `IN (...)` queries (authors/tags/formats).
   Rating sort joins `book_list_projection p` with `ORDER BY p.rating, p.book`
   and cursor tie-break on `p.book`. Cursor predicate:
   `expr {>=|<=} ? AND (expr {>|<} ? OR (expr = ? AND id {>|<} ?))`.
   `includeTotal` counts with base filters on the first page only.
   Tag filter `b.id IN (SELECT book FROM books_tags_link WHERE tag IN (...))`
   (dedup, >0); format filter `b.id IN (SELECT book FROM data WHERE
   UPPER(format) IN (...))`; `require_formats` adds `EXISTS (SELECT 1 FROM
   data d WHERE d.book = b.id)`. Limit clamp 1..=200 default 100.
4. **Cursor validation**: decode via `caliber_common::cursor`; rating and
   series_index require `CursorSort::Number`, others `CursorSort::Text`;
   mismatch → `DbError::InvalidCursor`.
5. **FTS query build**: split on whitespace, escape `"` → `""`, wrap each
   word `"word"*`, join with ` AND `; empty → plain list.
6. **Detail query** (`getBookByIdOptimized`) SQL ported verbatim incl. isbn
   join and `json_group_array(...) FILTER` — parse aggregates leniently
   (JSON array, comma fallback).
7. **Path containment** (`isSafeLibraryPath`): lexical resolve under
   `library_path` prefix + `fs::canonicalize` containment when the file exists.
8. Query functions must open/checkout from the pool per call and release in
   all paths (drop guards). All rusqlite work is synchronous; the server
   wraps calls in `spawn_blocking` — do NOT add tokio to this crate.

### Tests (port `tests/cursor-pagination.test.ts`)

Build a fixture Calibre DB with rusqlite in a tempfile (schema like
`tests/auth.test.ts` `createFixtureLibrary`), point `Config` at it
(`Config::load_from(tempdir)` + CALIBRE_* env), and port the TS suites:
cursor round-trips per sort (title/author/added/rating), invalid cursor →
`DbError::InvalidCursor`, rating correctness (unrated=0), FTS prefix search,
tag OR-filter, format OR-filter, series default ordering, first-page total.

---

## B. `caliber-user` — users.db + auth + progress (reference: `src/lib/user-db.ts`, `src/lib/auth.ts`)

### Public API (exact signatures)

```rust
pub struct UserDb; // opens CALIBER_USER_DB_PATH || <config_dir>/users.db; WAL, busy_timeout 5000, foreign_keys ON

#[derive(Debug, Clone, Serialize)]
pub struct User { pub id: i64, pub username: String,
    #[serde(rename="createdAt")] pub created_at: i64,
    #[serde(rename="lastSeenAt")] pub last_seen_at: i64 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserRow { pub id: i64, pub username: String, pub has_password: bool,
    pub created_at: i64, pub last_seen_at: i64 }

#[derive(Debug, Clone)]
pub struct UserWithCredential { pub id: i64, pub username: String,
    pub password_hash: Option<String>, pub auth_epoch: i64 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRow { pub book_id: i64, pub library_id: String, pub format: String,
    pub location: Option<String>, pub percentage: f64, pub furthest_percentage: f64,
    pub finished: bool, pub started_at: i64, pub updated_at: i64, pub server_seq: i64,
    pub last_mutation_id: Option<String> }

#[derive(Debug, Clone, Default)]
pub struct ProgressInput { pub format: String, pub location: Option<String>,
    pub percentage: Option<f64>, pub finished: bool, pub mutation_id: Option<String>,
    pub client_ts: Option<i64>, pub base_revision: Option<i64>,
    pub base_deletion_seq: Option<i64>, pub force: bool }

#[derive(Debug, Serialize)]
pub struct UpsertProgressResult { pub progress: Option<ProgressRow>, pub applied: bool,
    #[serde(skip_serializing_if="Option::is_none")] pub reason: Option<String> }

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProgressDeletionInfo { pub seq: Option<i64>, pub at: Option<i64> }

impl UserDb {
    pub fn open(config: &caliber_common::Config) -> UserDb; // creates schema + runs migrations
    pub fn get_or_create_user(&self, raw: &str) -> Option<User>;
    pub fn get_user_by_username(&self, raw: &str) -> Option<User>;
    pub fn get_user_by_id(&self, id: i64) -> Option<User>;
    pub fn get_credential_by_username(&self, raw: &str) -> Option<UserWithCredential>;
    pub fn create_user_with_password(&self, raw: &str, password_hash: &str) -> Option<User>;
    /// Txn: update hash + bump auth_epoch + delete sessions.
    pub fn set_user_password(&self, user_id: i64, password_hash: Option<&str>);
    pub fn delete_sessions_for_user(&self, user_id: i64) -> usize;
    pub fn get_auth_epoch(&self, user_id: i64) -> Option<i64>;
    pub fn count_users_with_password(&self) -> i64;
    pub fn list_auth_users(&self) -> Vec<AuthUserRow>;
    pub fn delete_user(&self, raw: &str) -> Option<User>;
    pub fn create_session(&self, token_hash: &str, user_id: i64, expires_at: i64);
    pub fn get_session(&self, token_hash: &str) -> Option<SessionRow>;
    pub fn delete_session(&self, token_hash: &str) -> bool;
    pub fn delete_expired_sessions(&self) -> usize;

    pub fn get_progress(&self, user_id: i64, library_id: &str, book_id: i64, format: Option<&str>) -> Option<ProgressRow>;
    pub fn list_progress_formats(&self, user_id: i64, library_id: &str, book_id: i64) -> Vec<ProgressRow>;
    pub fn list_progress(&self, user_id: i64, library_id: &str, limit: u32) -> Vec<ProgressRow>; // clamp 1..=500
    pub fn upsert_progress(&self, user_id: i64, library_id: &str, book_id: i64, input: &ProgressInput) -> UpsertProgressResult;
    pub fn delete_progress(&self, user_id: i64, library_id: &str, book_id: i64, format: Option<&str>) -> bool;
    pub fn clear_progress(&self, user_id: i64, library_id: &str) -> usize;
    pub fn set_finished(&self, user_id: i64, library_id: &str, book_id: i64, finished: bool, format: Option<&str>) -> Option<ProgressRow>;
    pub fn progress_deletion(&self, user_id: i64, library_id: &str, book_id: i64, format: Option<&str>) -> ProgressDeletionInfo;
    pub fn library_deletion(&self, user_id: i64, library_id: &str) -> ProgressDeletionInfo;
}

pub struct SessionRow { pub token_hash: String, pub user_id: i64, pub created_at: i64,
    pub expires_at: i64, pub auth_epoch: i64 }

// --- auth.rs ---
pub const SESSION_COOKIE: &str = "caliber-session";
pub const SESSION_TTL_MS: i64 = 30*24*60*60*1000;
pub const MIN_PASSWORD_LENGTH: usize = 8;

pub struct PasswordError(pub String);

pub struct Auth { /* wraps Arc<UserDb>, throttle map, basic cache, hash semaphore (max 4) */ }
impl Auth {
    pub fn new(user_db: std::sync::Arc<UserDb>) -> Auth;
    pub fn user_db(&self) -> &UserDb;
    pub fn hash_password(&self, password: &str) -> String;          // argon2id, PHC string (Bun-compatible)
    pub fn verify_password(&self, password: &str, hash: &str) -> bool; // verifies Bun.password PHC hashes
    pub fn is_valid_password(&self, password: &str) -> bool;          // 8..=512
    pub fn needs_initial_setup(&self, auth_enabled: bool) -> bool;
    /// 32 random bytes -> base64url no-pad; DB stores sha256 hex.
    pub fn create_session_token(&self, user_id: i64) -> SessionToken;
    pub fn resolve_session_token(&self, token: Option<&str>) -> Option<User>; // expiry + epoch recheck
    pub fn revoke_session_token(&self, token: Option<&str>);
    pub fn purge_expired_sessions(&self);
    pub fn session_cookie_header(&self, token: Option<&str>) -> String;
    pub fn login_rate_limited(&self, client_key: &str) -> bool;      // 10 fails / 15 min
    pub fn authenticate_with_password(&self, client_key: &str, username: &str, password: &str) -> Option<User>;
    pub fn parse_basic_auth(header: &str) -> Option<(String, String)>;
    pub fn authenticate_basic(&self, client_key: &str, header: &str) -> Option<User>; // 5min/10k cache + epoch recheck
    pub fn set_password_for_user(&self, username: &str, password: &str) -> Result<User, PasswordError>;
}
pub struct SessionToken { pub token: String, pub expires_at: i64 }

// --- names/locations (user-db.ts helpers) ---
pub fn normalize_username(raw: &str) -> String;   // trim, collapse ws, max 40
pub fn is_valid_username(raw: &str) -> bool;
pub fn normalize_library_id(raw: &str) -> String; // trim, max 200, "" -> "default"
pub fn is_valid_location_for_format(format: &str, location: Option<&str>) -> bool;
pub fn sanitize_location_for_format(format: &str, location: Option<&str>) -> Option<String>; // 20000 cap
```

### Required behavior

- **Schema + migrations exactly as TS** (`users`, `progress` incl. legacy
  rebuild to PK `(user_id, library_id, book_id, format)` keeping most-recent
  on collisions, `progress_deletions`, `processed_mutations` + indexes,
  `sessions`; additive `password_hash`/`auth_epoch` columns). An existing
  users.db written by the TS app must open and keep working.
- **`upsert_progress` port verbatim** (TS lines 729–926) inside one
  transaction: mutation-history duplicate check (any match → `applied:true,
  reason:"duplicate"` + legacy single-slot backfill), deletion-generation
  resurrect guard (`reason:"deleted"`), baseRevision conflict (monotonic
  furthest/finished merge, `reason:"conflict"`, no server_seq bump),
  `ON CONFLICT ... server_seq = progress.server_seq + 1`, history insert +
  prune to last 50 per identity. Location sanitize + percentage clamp 0..100,
  format uppercased max 10.
- **Password hashing**: argon2id PHC. Must *verify* hashes produced by
  `Bun.password.hash` (same PHC format) and produce hashes Bun can verify.
  Default params (argon2 crate defaults are fine; Bun uses its own — PHC
  carries the params so verification is interop-safe).
- Throttle: failures keyed `"{ip}|{username.to_lowercase()}"`, 10 within 15
  min → limited; cleared on success; prune when map > 10k.
- Session token: 32 random bytes, base64url no-pad, `+`/`/` mapped (use
  `base64::URL_SAFE_NO_PAD`); DB key sha256-hex.
- Cookie: `caliber-session=<token>; Path=/; HttpOnly; SameSite=Lax[; Secure]; Max-Age=2592000`
  (Secure when `config.cookie_secure`); clearing adds `Max-Age=0`.
- No tokio in this crate; interior mutability via `Mutex`/`RwLock` is fine.

### Tests

Port from TS: session create/resolve/revoke + epoch invalidation after
password change; throttle (10 failures then limited, success clears);
`upsert_progress` protocol (first write, duplicate mutationId, baseRevision
conflict, deleted-rejection, fresh-baseDeletionSeq/force resurrect, monotonic
furthest on conflict); location validation per format; legacy users.db
migration (create an old-shape progress table, open, verify rows kept);
last-account guard is a server concern (not here).

---

## C. `caliber-server` — HTTP server (reference: `src/index.ts`, `src/lib/opds.ts`, `src/lib/book-files.ts`, `src/lib/epub-cache.ts`, `src/lib/page-streaming.ts`)

### Structure

```
src/main.rs      — thin entry: Config::load, CaliberDb::open+init, UserDb/Auth, spawn server
src/lib.rs       — pub async fn run(state) / pub fn build_router(state: AppState) -> Router
src/state.rs     — AppState { config, db: Arc<CaliberDb>, users: Arc<UserDb>, auth: Arc<Auth>,
                    cache: ApiCache, ready: AtomicBool, static_dir: PathBuf, ... }
```

Expose `build_router` + `AppState` publicly (integration bins reuse them).
Put MCP JSON-RPC dispatch in `src/mcp.rs` as
`pub async fn handle_jsonrpc(body: serde_json::Value) -> Option<serde_json::Value>`
implementing `initialize`, `tools/list`, `tools/call` for tools
`search_book_title`, `search_author`, `search_library` with the TS text
output format (`formatBook` in `src/lib/mcp-utils.ts`).

### Route table (all of it; methods, params, status codes, headers match TS)

JSON API: `/api/health` GET; `/api/config/library` GET|PUT;
`/api/config/auth` GET|PUT; `/api/stats`, `/api/tags`, `/api/formats`,
`/api/books/count` GET; `/api/books` GET (cursor/limit 1..100 d50/sortBy/
sortOrder/repeated `tag` ≤50/repeated `format` ≤20/includeTotal);
`/api/books/search` GET (never cached); `/api/books/:id` GET;
`/api/books/:id/download/:format` + `/file/:format` GET|HEAD;
`/api/books/:id/epub` GET|HEAD → 308 to `epub/`; `/api/books/:id/epub/**`
GET|HEAD (default `META-INF/container.xml`, optional
`META-INF/com.apple.ibooks.display-options.xml` → default XML body);
`/api/books/:id/pages/:format/manifest` + `/:page` GET|HEAD;
`/api/books/:id/cover`, `/thumb` GET; `/api/books/stream` GET (chunked JSON
array, `batchSize` 1..5000 d1000, snapshot lease held, abort stops);
`/api/user/me`, `/api/user/login`, `/api/user/logout`, `/api/auth/setup`,
`/api/user/reading` GET|DELETE, `/api/user/progress/:bookId`
GET|PUT|POST|DELETE; `/api/auth/users` POST,
`/api/auth/users/:username` DELETE, `/api/auth/users/:username/password` POST.

OPDS (XML): `/opds`, `/opds/search.xml`, `/opds/books`, `/opds/recent`,
`/opds/authors`, `/opds/authors/:id/books`, `/opds/series`,
`/opds/series/:id/books`, `/opds/tags`, `/opds/tags/:id/books`,
`/opds/formats`, `/opds/formats/:format/books`, `/opds/search`, `/opds/book/:id`,
`/opds/book/:id/feed`, `/opds/book/:id/complete`,
`/opds/book/:id/download/:format` GET|HEAD, `/opds/book/:id/file/:format`
GET|HEAD, `/opds/book/:id/cover`, `/opds/book/:id/thumb`.

Other: `/mcp` POST (404 disabled; batch; 202 notifications; 1MB cap; codes
-32700/-32600/-32601/-32602/-32603); `/pdfjs/pdf.worker.min.mjs` GET (from
static dir — copy at build; see PARITY if absent); `/*` SPA fallback to
`index.html` from static dir.

Axum note: register `/api/books/search`, `/api/books/count`,
`/api/books/stream` BEFORE `/api/books/:id`; use distinct paths so no
ambiguity; wildcard fallback last.

### Guards (order: host validation → auth guard)

- **Host validation**: allowlist {127.0.0.1, ::1, localhost} ∪
  {config.host} ∪ {base_url host}; permissive (allow any) only when no
  base_url AND host is non-loopback; with `trust_proxy`, any
  `X-Forwarded-Host` passes. Reject 421 `{"error":"Request host is not
  allowed"}` + `Cache-Control: no-store`. IPv6 bracket + port stripping per
  TS `normalizedHostName`.
- **Auth guard**: applies to patterns `/api`, `/api/*`, `/mcp`, `/opds*`,
  `/pdfjs*` when `config.auth_enabled` (read live); public paths
  `/api/health`, `/api/user/me`, `/api/user/login`, `/api/user/logout`,
  `/api/auth/setup`; 401 `{"error":"Authentication required"}` +
  `WWW-Authenticate: Basic realm="Caliber", charset="UTF-8"` **only** for
  `/opds*`; Basic credentials via `Auth::authenticate_basic` else session
  cookie; authenticated identity available to handlers (like TS
  `setRequestUser` — e.g. per-request extension or a typed extractor).
  Client key for auth = first `X-Forwarded-For` value when `trust_proxy`,
  else `"local"`.

### Caching (LRU + ETag) — port exactly

- LRU: max 100 entries, max 50MB payload, TTL 60s; key
  `shared:rev{revision}:{base}` or `auth-private:rev{revision}:{base}` when
  the request carries `Authorization` or a `caliber-session`/`caliber-user`
  cookie; `If-None-Match` match → 304 with same Cache-Control; ETag =
  quoted base36 of `bun_hash(body)`.
- Cache-Control: per-user endpoints `private, no-store`; other authenticated
  requests `private, max-age=60`; anonymous `public, max-age=60`; anonymous
  covers `public, max-age=300, must-revalidate`; search + OPDS search
  `no-store`; 404 responses never cached (producer short-circuit).
- Cached routes: `/api/stats` (key `stats`), `/api/tags`, `/api/formats`,
  `/api/books/count`, `/api/books` (key
  `books:{cursor|first}:{limit}:{sortBy}:{sortOrder}:tags:{csv}:formats:{csv}:total:{0|1}`),
  empty-query `/api/books/search` reuses the books key, book detail
  `book:{id}`, OPDS feeds keyed `opds:*:{baseUrl}:{pathPrefix}:{selfPath}`.
- DB refresh callback clears the cache and sets ready=true.

### File serving (port `serveLocalFile` + `serveBookFile` + covers/thumbs)

- ETag `"{size}-{mtimeMs}"`, Last-Modified, 304 on exact If-None-Match,
  single-range only (`bytes=`), suffix ranges, 416 with `Content-Range:
  bytes */{size}`, If-Range (exact etag or date ≥ mtime), HEAD without body,
  `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`,
  `Content-Disposition` with both `filename="..."` (quotes/escaped) and
  `filename*=UTF-8''<pct-encoded>`; inline→attachment downgrade for
  non-browser-readable formats (EPUB/PDF/CBZ/CBR readable).
- `getSafeBookFilename` port (NFKC, filter control/slashes, replace
  `?%*:|"<>` → `-`, collapse spaces → `_`, strip leading dots, 160 cap,
  fallback `book`, lowercase extension).
- Covers: full-size JPEG + ETag/304. Thumbs: `?size=small|medium` (256/512),
  disk cache `<config>/thumbs/{id}-{size}-{sig}.jpg` where
  `sig = bun_hash36("{libraryPath}:{size}:{mtimeMs}")`-style revision key
  (TS: `Bun.hash(`${LIBRARY_PATH}:${fileStat.size}:${mtimeMs}`)` — use size
  + mtime), ETag `"t{size}-{sig}"`, FIFO queue max 2 jobs, resize with the
  `image` crate (`CALIBER_THUMB_DISABLE_RESIZE=1` forces degraded), on
  resize failure serve original + `X-Thumbnail-Degraded:
  resize-unavailable`, 501 when no bytes at all.
- SPA static: files from `CALIBER_STATIC_DIR` (default `./dist`), index.html
  fallback for unmatched non-API paths, `Cache-Control: no-cache`, correct
  Content-Type by extension; missing dir → keep API working, log warning.

### User/progress routes — port handler logic exactly

- `/api/user/me` → `{user, authRequired, needsSetup}` no-store; user from
  session/Basic when auth on, else `caliber-user` cookie → `get_user_by_username`.
- login: auth on → throttle(429 `Too many failed attempts; try again later`),
  verify, purge expired, set-cookie session; auth off → `get_or_create_user`
  + `caliber-user` cookie (1y, HttpOnly, SameSite=Lax, Secure?, URL-encoded
  username; clear form `caliber-user=; attrs; Max-Age=0`).
- setup: only when auth_enabled && no password users; serialize concurrent
  setups (mutex), recheck after await (double-check), create + session.
- logout: revoke session + clear both cookies.
- reading GET: collapse per-book (finished > furthest > recent), batch
  enrich via `get_books_by_ids`, skip missing books, `{items:[{book:{id,
  title, authors, series, series_index, formats, has_cover}, progress:{format,
  percentage, finished, updatedAt}}]}`; DELETE clears + returns
  `{removed, deletionSeq}`.
- progress GET: `{progress, formats, serverSeq, deletionSeq}` (401 Not
  signed in for writes; anonymous GET → `{progress:null}` + no-store);
  `?format=` optional (invalid → 400 `Invalid format`).
- progress PUT/POST (beacon alias): body must be object (400); identity
  mismatch → 401 `Principal mismatch` / 409 `Library mismatch` (accept both
  `expectedUserId`/`userId` and `expectedLibraryId`/`libraryId`); format must
  match `^[A-Z0-9]{1,10}$` and be in `book.formats` else 400 `Invalid book
  format`; `upsert_progress`; respond `{progress, applied, reason,
  serverSeq, deletionSeq}` no-store.
- progress DELETE: `{removed, deletionSeq}` no-store.
- config/auth GET: `{authEnabled, hasAccounts, canManage, envControlled,
  users?}` no-store; PUT: canManage else 403; `enabled` boolean else 400;
  no-change → `{authEnabled, changed:false}`; enabling with zero accounts
  requires username+password (400s), prepares credential BEFORE persisting
  the toggle, then session cookie; disabling just persists. Admin gating:
  auth on → loopback OR (any authenticated user unless
  `CALIBER_ADMIN_RESTRICTED=1`); auth off → loopback AND
  `CALIBER_ALLOW_NOAUTH_ADMIN=1`.
- users mgmt: POST create (valid username/password, 409 if password exists),
  DELETE (404 unknown, 409 last password user `Cannot delete the last user
  with a password`), POST password (404 unknown, validate, set).
- `/api/config/library` GET: `{...library_config_status, libraryId, ready,
  stale, refreshing, failed, generation, revision}` no-store. PUT: 403 unless
  loopback host; body object; `save_library_config_with_validation` → 400 on
  ConfigError; then `db.reconfigure_library()`, ready=true, clear cache,
  `{...status, ready, applied:true}`.

### OPDS renderers — port `src/lib/opds.ts` faithfully

XML declaration `<?xml version="1.0" encoding="UTF-8"?>`, media types
(navigation/acquisition/entry/opensearch constants), FORBIDDEN_CONTROLS
strip, XML-escape, `toOpdsDate` (snapshot mtime ISO → RFC3339/ATOM),
navigation root (with totalBooks), catalog feeds (id = absolute self URL,
entry hrefs per kind), acquisition feeds (complete entries with
`urn:uuid:{uuid}` id, authors, series `Book {index} of {series}`, categories
tags, summary comments truncated, formats as acquisition links with types
from `getFormatContentType`, cover/thumb links), search feed (`Search: q`,
no-store), OpenSearch descriptor (public max-age 3600), single-book feed +
complete-entry variants, path prefix via `X-Forwarded-Prefix` (trusted
proxy) / `BASE_PATH` env, `updated` = snapshot mtime for nav/catalog.

### Media pipelines (port `epub-cache.ts`, `page-streaming.ts`)

- EPUB: extract entries on demand from the source zip (via `zip` crate) into
  `<config>/epub-cache/{libHash}-{bookId}/` with signature meta
  `.caliber-epub-cache.json` (+libHash field), legacy unscoped dirs dropped,
  singleflight per `{library}|{book}|{rev}|{op}|{path}`, max 2 concurrent
  extractions, per-entry 32MB / archive 256MB caps (413 `{"error":"EPUB
  resource is too large","code":"entry_too_large"}` etc.), 1GB quota sweep
  (oldest first, leased dirs kept), zip-slip safe paths (400 invalid_path),
  tmp+rename publishes, stale-signature aborts, entry CSP
  `default-src 'none'; img-src 'self' data: blob:; style-src 'self'
  'unsafe-inline'; font-src 'self' data:;`.
- Pages (`manifest` + `page`): CBZ via zip (natural-sort page names, image
  extensions only, `.svg` skipped+logged, contiguous manifest, page cap
  10k, entry size caps, pixel-count guard for PNG IHDR > 40MP → 413);
  CBR: if no Rust rar extractor is feasible, detect `unrar`/`unar` binary —
  otherwise return 501 `Page streaming is not supported`-style degradation
  and record it in PARITY.md; PDF: `pdfinfo` (Pages: parse) +
  `pdftoppm -f n -l n -singlefile -png -r 150` (env PDFINFO_PATH/
  PDFTOPPM_PATH, candidates /opt/homebrew/bin,/usr/local/bin,/usr/bin),
  30s timeout kill, lazy per-page render with tmp+rename + stale recheck
  (409 `Reader source changed during rendering`), meta `.caliber-page-cache.json`
  with libHash + pageCount, CBR manifest version 2, cache dir
  `<config>/page-cache/{libHash}-{bookId}-{FORMAT}/`, 2GB quota sweep,
  semaphores (3 pdf renders, 2 archive extracts), page CSP `sandbox;
  default-src 'none'; style-src 'unsafe-inline'`, manifest JSON shape
  `{bookId, format, pageCount, pages:[{index, href, type, name}]}`.
- `PageStreamingError(status, message)` → `{"error": message}` with status;
  415 `Page streaming is not supported for {format}` for others.

### main.rs startup

Load Config; open/init db (init failure → ready=false but continue); start
refresh callback (clear cache, ready=true); UserDb/Auth; bind
`config.host:config.port`; axum serve; startup log lines equivalent to TS
(`Server running at http://host:port`, library path, auth state). 1MB body
limit on /mcp; graceful Ctrl-C shutdown is nice-to-have.

### PARITY.md

At the end, write `crates/caliber-server/PARITY.md` listing: implemented
endpoints, degradations (CBR?), deviations, known gaps. Be honest.
