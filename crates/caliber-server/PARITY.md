# caliber-server — PARITY

Status: **complete against the mock backends** (`src/mock.rs`). The server is
implemented entirely against the `CaliberBackend` / `UserBackend` traits in
`src/backend.rs`; wiring the real `caliber-db` / `caliber-user` crates is the
remaining integration step (see “Integration” at the bottom).

## Implemented endpoints (route parity with src/index.ts)

**JSON API**
- `GET /api/health`
- `GET|PUT /api/config/library` (PUT loopback-only, `save_library_config_with_validation` via backend)
- `GET|PUT /api/config/auth` (canManage matrix, prepare-then-commit enable-with-first-account + session cookie, no-change short-circuit, env-controlled rejection)
- `GET /api/stats`, `GET /api/tags`, `GET /api/formats`, `GET /api/books/count`
- `GET /api/books` (cursor/limit 1..100 d50/sortBy/sortOrder/repeated `tag` ≤50/repeated `format` ≤20/includeTotal, exact cache key)
- `GET /api/books/search` (never cached; empty query reuses the books cache key)
- `GET /api/books/:id`, `GET|HEAD /api/books/:id/download/:format`, `GET|HEAD /api/books/:id/file/:format`
- `GET|HEAD /api/books/:id/epub` → 308 to `epub/`; `GET|HEAD /api/books/:id/epub/` and `/api/books/:id/epub/**` (default `META-INF/container.xml`, optional iBooks display-options default body, entry CSP)
- `GET|HEAD /api/books/:id/pages/:format/manifest` and `/:page` (page CSP)
- `GET /api/books/:id/cover`, `GET /api/books/:id/thumb?size=small|medium`
- `GET /api/books/stream` (chunked JSON array, batchSize 1..5000 d1000, snapshot lease, abort-aware)
- `GET /api/user/me`, `POST /api/user/login` (both auth modes), `POST /api/user/logout`
- `POST /api/auth/setup` (mutex-serialized, double-check)
- `GET|DELETE /api/user/reading`
- `GET|PUT|POST|DELETE /api/user/progress/:bookId` (identity mismatch 401/409, format validation, `{progress, applied, reason?, serverSeq, deletionSeq}`)
- `POST /api/auth/users`, `DELETE /api/auth/users/:username` (last-account 409), `POST /api/auth/users/:username/password`

**OPDS** — all feeds: `/opds`, `/opds/search.xml`, `/opds/books`, `/opds/recent`,
`/opds/authors(/:id/books)`, `/opds/series(/:id/books)` (series_index default),
`/opds/tags(/:id/books)`, `/opds/formats(/:format/books)`, `/opds/search`
(no-store), `/opds/book/:id`, `/opds/book/:id/feed`, `/opds/book/:id/complete`,
`/opds/book/:id/download|file/:format` (GET|HEAD), `/opds/book/:id/cover`,
`/opds/book/:id/thumb`. Renderers byte-track `src/lib/opds.ts` (XML
declaration, FORBIDDEN_CONTROLS strip, `toOpdsDate`, `acquisitionFeedUpdated`,
`urn:uuid:` ids, categories/summary/metadata, cover+format links, path-prefix
via `X-Forwarded-Prefix`/`BASE_PATH`/`CALIBER_BASE_URL`).

**Other** — `POST /mcp` (disabled 404, batch, 202 notifications, `-32700` parse
error, `-32601`/`-32602`/`-32603`; `initialize`, `tools/list`, `tools/call` for
`search_book_title` / `search_author` / `search_library` with the TS
`formatBook` text output); `/pdfjs/pdf.worker.min.mjs` (from the static dir);
SPA fallback serving files from `CALIBER_STATIC_DIR` (default `./dist`) with
`index.html` fallback, `Cache-Control: no-cache`.

**Cross-cutting**
- Guards: host validation (421, `Cache-Control: no-store`, permissive mode,
  `X-Forwarded-Host` under trust_proxy, IPv6 brackets) then auth guard (live
  `auth_enabled`, public paths, Basic/session, `WWW-Authenticate` only on
  `/opds*`).
- Caching: LRU 100 entries / 50MB / 60s TTL, `shared:` / `auth-private:`
  `rev{revision}` keys, ETag = quoted base36 `bun_hash`, If-None-Match → 304,
  Cache-Control matrix (per-user no-store / private max-age=60 / public
  max-age=60 / covers max-age=300 must-revalidate), 404 producer
  short-circuit, refresh callback clears cache + sets ready.
- File serving: ETag `"{size}-{mtimeMs}"`, Last-Modified, 304, single
  `bytes=` ranges incl. suffix, 416 + `Content-Range: bytes */size`, If-Range
  (etag/date), HEAD, `Accept-Ranges`, nosniff, dual Content-Disposition,
  inline→attachment downgrade, `getSafeBookFilename`.
- Thumbnails: 256/512 resize via the `image` crate (Lanczos3,
  without-enlargement), disk cache `thumbs/{id}-{size}-{sig}.jpg` with
  `{libraryPath}:{fileSize}:{mtimeMs}` hash36 signature, ETag `"t{size}-{sig}"`,
  FIFO max 2, degraded fallback (`X-Thumbnail-Degraded: resize-unavailable`,
  `CALIBER_THUMB_DISABLE_RESIZE=1`), 501 when no cover bytes exist.
- EPUB cache: on-demand extraction, scoped dirs `{libHash}-{bookId}`, meta
  `.caliber-epub-cache.json` (+libHash), single-flight, 2-extraction
  semaphore, 32MB/entry + 256MB/archive caps (413 `entry_too_large` /
  `epub_too_large`), 422 `invalid_epub`, 400 `invalid_path` (percent-decode
  failures), 1GB quota sweep, tmp+rename, stale-signature aborts, leases.
- Pages: CBZ (natural sort, svg skip+log, contiguous manifest, lazy per-page
  extraction, declared-size caps, PNG IHDR >40MP guard, 409
  `Reader source changed during extraction`), PDF (`pdfinfo`/`pdftoppm`,
  PDFINFO_PATH/PDFTOPPM_PATH overrides + brew/local/usr candidates, 30s
  kill timeout, tmp-prefix render + rename, meta
  `.caliber-page-cache.json`), 2GB quota sweep, semaphores (3 pdf / 2
  archive), manifest `{bookId, format, pageCount, pages[]}`, 415 for
  unsupported formats, 404 `Format {F} not found`.
- 1MB request-body limit (router-wide, matching TS `maxRequestBodySize`).

## Tests

37 tests (`cargo test -p caliber-server`), covering: health, host validation
(421/allowlist/trust-proxy), SPA fallback, auth guard (401/challenge/public
paths/Basic/session), login+logout cookie flows (both auth modes), books
pagination + includeTotal + tag/format filters + invalid cursor 400, cache
ETag/304/private-vs-public, search no-store + empty-query reuse, book detail
200/400/404, stats/tags/formats/count, the full progress write protocol
(happy/duplicate/401 principal/409 library/400 format/404 book/DELETE +
deletionSeq/deleted-reject/fresh-seq resurrect), reading shelf GET/DELETE,
config/auth matrix (env flags, prepare-then-commit, last-account guard,
password change), config/library GET + PUT loopback guard + applied flag, OPDS
feed shapes/media types/next links/search-no-store/complete entry, file
serving (HEAD/304/206/suffix/416/If-Range both ways/disposition), filename
sanitization, EPUB entry serving (redirect/default/optional entry/CSP/404/
zip-slip), pages manifest 415/404 + CBZ manifest/page + CSP, covers + real
resize + degraded thumbnail, stream full-array shape, MCP
disabled/enabled/batch/notifications/parse-error/tools, pdfjs worker
present/missing.

## Degradations & deviations (honest list)

1. **CBR page streaming** uses an external RAR reader — `unrar` when present
   (`unrar lb` / `unrar p -inul`; `CALIBER_UNRAR_PATH` overrides,
   brew/local/usr/bin/PATH candidates), otherwise macOS's libarchive
   `bsdtar` (`bsdtar -tf` / `bsdtar -xOf`, integration-verified). When
   neither binary exists the endpoints return **501** ("CBR page
   extraction is unavailable (install unrar or bsdtar)") instead of
   shipping a rar extractor. Everything else about the CBR path (scoped dirs, meta version 2,
   caps, pixel guard, contiguous pages, stale rechecks) is implemented.
2. **`handle_jsonrpc` signature** takes `(state: &AppState, body: Value)` —
   the contract's zero-arg form is impossible in Rust without ambient
   globals. The dispatch logic itself matches `mcp-core.ts`.
3. **Throttle-key convention** (must be honored by the caliber-user adapter):
   `login_rate_limited` and `authenticate_with_password` receive the FULL key
   `"{ip}|{username.to_lowercase()}"`; `authenticate_basic` receives only the
   ip part and combines with the parsed username itself. (See
   `routes_user::throttle_key` and `guards::auth_client_key`.)
4. **`getSafeBookFilename` NFKC** is approximated by the code-point filter —
   the locked dependency set has no unicode-normalization crate. ASCII
   behavior (quotes/controls/slashes/replacement/collapse/160-cap/fallback)
   is identical; combining-character titles keep their decomposed form.
5. **JSON key order** is alphabetical (serde_json BTreeMap) rather than the
   TS insertion order. Semantically identical; affects only byte-level diffs.
6. **`/opds/search.xml` Cache-Control** is `public, max-age=60` — the TS
   `getCachedTextResponse` overrides the 3600 default with
   `cacheControlFor(req)`; mirrored faithfully (not a deviation, recorded
   because it surprises).
7. **EPUB open-archive LRU** (TS `MAX_OPEN_EPUBS = 3`) is not implemented —
   the zip is reopened per extraction (central-directory read only, cheap).
   The concurrent-extraction semaphore (max 2) is implemented.
8. **PDF.js worker** is served from `{CALIBER_STATIC_DIR}/pdf.worker.min.mjs`
   or `{CALIBER_STATIC_DIR}/pdfjs/pdf.worker.min.mjs` — the build step must
   copy `pdfjs-dist/build/pdf.worker.min.mjs` there (TS read it from
   node_modules). 404 + a warning log when absent.
9. **Date parsing** (`new Date(...)` equivalent) accepts the shapes Calibre
   emits (`YYYY-MM-DD[ T]HH:MM:SS[.f][±HH:MM|Z]`, date-only); naive timestamps
   are treated as UTC (JS would use the local zone). Calibre databases carry
   explicit offsets, so this is benign in practice.
10. **Unmatched-method requests** on registered paths (e.g. DELETE
    /api/books) run through the guards and then axum's 405, where TS would
    fall through to the SPA shell; unregistered paths (e.g. `/api/unknown`)
    still fall through to the SPA like TS.
11. **Static serving** serves real files under the static dir for any
    unmatched path before falling back to index.html — the TS `/*` route
    served only index.html (its bundler served assets). Strictly a superset.
12. **arg2 hashing params**: mock password hashing is sha256-based (mock
    only); the real crate provides argon2id as specified.

## Integration (for the lead agent)

```rust,ignore
let config = caliber_common::Config::load();
let db = Arc::new(caliber_db::CaliberDb::open(config.clone()));
let ready = db.init();                       // false keeps the UI reachable
let user_db = Arc::new(caliber_user::UserDb::open(&config));
let auth = Arc::new(caliber_user::Auth::new(user_db.clone()));
let state = caliber_server::app_state(
    config,
    db as Arc<dyn caliber_server::backend::CaliberBackend + Send + Sync>,
    auth as Arc<dyn caliber_server::backend::UserBackend + Send + Sync>,
    caliber_server::resolve_static_dir(),
);
caliber_server::run(state).await
```

- Implement `CaliberBackend for caliber_db::CaliberDb` and `UserBackend for
  caliber_user::Auth` against the exact trait signatures in
  `src/backend.rs` (types are structurally identical to CONTRACT.md B, so
  adapters can map fields 1:1; `SnapshotLease` wraps the real RAII guard via
  `SnapshotLease::from_release`).
- The refresh callback wired by `run()` clears the API cache and sets
  `ready=true` on every publish (mirrors TS `onDbRefresh`).
- `src/main.rs` currently only reports the pending wiring; replace its body
  with the construction above.
- Note: `src/bin/` (caliber-cli / caliber-mcp, behind the `real-backends`
  feature) belongs to the CLI/MCP agent and shares this crate's Cargo.toml.
