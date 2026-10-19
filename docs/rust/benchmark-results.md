# Caliber backend benchmark: Rust (release) vs Bun (production)

Evidence report for the `rewrite/rust` branch. Raw data (every sample, per-round
results, env metadata): [`benchmark-results.json`](./benchmark-results.json).

Harness: [`scripts/benchmark-backends.py`](../../scripts/benchmark-backends.py)
(Python 3 stdlib only, seeded/reproducible fixture generator included).

## Scope

Compare the Rust rewrite (`crates/*`, release build) against the original Bun
backend (`src/index.ts`, production mode) on:

- cold and warm startup readiness (HTTP *health* vs *DB ready*)
- idle RSS and sampled peak RSS
- latency (p50/p95/mean) and throughput at concurrency 1 and 16 for cached
  list/stats, uncached tag-filtered list, uncached FTS search, and sequential
  keyset (cursor) pagination
- semantic parity of responses

**Not claimed:** an overall winner. Results below are specific to this machine,
this fixture, and these scenarios.

## Environment

| Item | Value |
|---|---|
| Date | 2026-10-18 (run `20261018-150534`) |
| Repo / commit | `/Volumes/Storage/code/caliber-rust`, branch `rewrite/rust`, commit `34f1ee2feb` (working tree dirty: Rust crates + docs + tests from the rewrite itself; `src/` unmodified vs HEAD) |
| OS / hardware | macOS 27.0.1 (Mac16,11), Apple M4 Pro, 12 cores, 24 GB RAM |
| Bun | 1.4.2 (`bun src/index.ts`, `NODE_ENV=production` — same as `bun start`) |
| Rust | rustc 1.97.0, `cargo build --release` → `target/release/caliber-server` (axum/tokio/rusqlite) |
| Client | Python 3.12.12, `http.client` over loopback, HTTP/1.1 keep-alive, 1 connection per worker thread |

Commands (reproduce with):

```bash
python3 scripts/benchmark-backends.py            # defaults: 100k books, 3 rounds, c=1,16
python3 scripts/benchmark-backends.py --books 10000 --rounds 5   # smaller library
```

## Fixture & isolation

- Generated Calibre library (`scripts/benchmark-backends.py`, seed `20261018`):
  **100,000 books**, 10,711 authors, 5,824 series, 119 tags,
  `metadata.db` = 72.2 MB, sha256 `a8bfe44030b60614…`. Schema mirrors
  `scripts/generate-test-library.ts`. No real/user library was used as a source.
- Both backends read the **same fixture file** (read-only) and got **separate
  `CALIBER_CONFIG_DIR` cache dirs**, each building its own 104.5 MB snapshot
  (copy + 17 indexes + FTS5 + rating projection — identical artifact sizes).
- Otherwise identical env: `CALIBER_HOST=127.0.0.1`, `PORT` (unique per boot),
  `CALIBER_MCP_ENABLED=false`, default `CALIBER_DB_REFRESH_INTERVAL_MS=60000`,
  auth disabled. `NODE_ENV=production` set only for Bun (matches `bun start`;
  for Rust it only affects a cookie flag that is unused here).
- Health = first 200 from `GET /api/health` (listening). DB ready = first
  `GET /api/config/library` with `ready:true`. Both backends run snapshot init
  *before* binding the listener, so the two signals coincide by design; they are
  reported separately anyway.
- 3 rounds, backend order alternated each round (rust,bun / bun,rust / rust,bun)
  to cancel drift. Total **15,600 requests, 0 errors, 0 non-200s**.

### Cache-state honesty

- `stats_hit`, `books_first_page_hit`: LRU (100 entries, 60 s TTL) **HIT** — one
  untimed warm-up request precedes the timed loop. These measure cache serving,
  not SQLite.
- `books_tag_pair_miss`: unique tag-pair filter per request → genuine LRU
  **MISS**, every request hits SQLite.
- `search_*`: **never cached** by either backend (`no-store` by design).
- `pagination_walk`: every cursor page is a distinct cache key → effectively
  MISS per page; walk of 10 pages follows `nextCursor` sequentially at c=1.
- Search queries: broad `golden` (993 hits), narrow full title `the unclear
  castle` (10 hits), miss `zzzqxvnope` (0 hits).

## Results

### Startup (seconds, n=1 per boot type)

| Boot | Rust health/ready | Bun health/ready |
|---|---|---|
| Cold (empty cache dir) | 2.81 / 2.82 | 35.94 / 35.95 |
| Warm, rounds 1–3 | 0.47 / 0.49, 0.041 / 0.043, 0.042 / 0.042 | 0.193 / 0.194, 0.098 / 0.098, 0.059 / 0.059 |

Cold = full snapshot build (identical `INSERT INTO books_fts(books_fts)
VALUES('rebuild')` + index creation on identical data). The 12.8× cold-build gap
is the largest measured difference in this run; both produce byte-count-identical
snapshot artifacts (104.5 MB). Root cause not investigated further here (plausible
candidates: SQLite build-connection pragmas/cache; TS pool pragmas apply only
after the build). Warm restarts are parity-grade (both ≤ 0.2 s; rust round-1
0.47 s is a cold page-cache outlier).

### Memory (RSS, KB; `ps` sampled every 50 ms — sampled peaks are lower bounds)

| Metric | Rust | Bun |
|---|---|---|
| RSS right after cold-boot ready (direct `ps`) | 44,496 | 155,120 |
| Peak sampled during cold build | 43,600 | 155,120 |
| Idle RSS after warm boot (median of 5 samples, 3 rounds) | 38,096–38,160 | 71,904–74,368 |
| Max sampled during load rounds (tag-miss/search c16) | 263,056 | 322,304 |

Rust used ~1.9× less memory idle and ~60 MB less at peak under load. Caveats:
macOS RSS includes memory that would be freed under pressure (SQLite page cache
and mmap growth dominate the load peaks for both); sampling cadence can miss
short spikes (some short phases recorded 0 samples — see JSON).

### Latency & throughput (aggregated over 3 rounds; c1: 50 reqs/round, c16: 320)

p50 / p95 in ms; rps = mean requests/s per round. `err` counts are 0 everywhere.

| Scenario | Rust p50 | Rust p95 | Rust rps | Bun p50 | Bun p95 | Bun rps |
|---|---|---|---|---|---|---|
| health@c1 (client floor) | 0.157 | 0.351 | 5,130 | 0.262 | 1.556 | 3,119 |
| health@c16 | 1.041 | 3.605 | 10,029 | 1.455 | 5.668 | 7,391 |
| stats_hit@c1 (cached) | 0.153 | 0.295 | 5,679 | 0.219 | 0.937 | 4,220 |
| stats_hit@c16 (cached) | 1.055 | 3.858 | 9,675 | 1.474 | 6.223 | 7,372 |
| books_first_page_hit@c1 (cached, ~21 KB body) | 0.151 | 0.380 | 3,371 | 0.198 | 0.828 | 2,727 |
| books_first_page_hit@c16 | 2.609 | 7.199 | 4,599 | 3.514 | 11.247 | 3,254 |
| books_tag_pair_miss@c1 (uncached) | 5.892 | 8.859 | 154 | 6.364 | 10.062 | 148 |
| books_tag_pair_miss@c16 | 76.863 | 105.145 | 231 | 75.907 | 117.685 | 221 |
| search_broad@c1 (993 hits) | 2.876 | 5.295 | 314 | 2.016 | 4.353 | 417 |
| search_broad@c16 | 17.744 | 34.993 | 791 | 19.597 | 39.887 | 736 |
| search_narrow@c1 (10 hits) | 3.158 | 6.002 | 274 | 2.957 | 5.520 | 288 |
| search_narrow@c16 | 18.230 | 38.832 | 778 | 37.410 | 67.477 | 395 |
| search_miss_zero@c1 (0 hits) | 0.513 | 2.405 | 1,445 | 0.405 | 0.917 | 2,093 |
| search_miss_zero@c16 | 1.936 | 5.848 | 6,229 | 1.543 | 5.685 | 6,585 |
| pagination_walk@c1 (10 pages, sequential) | 1.272 | 2.567 | 666 | 1.109 | 1.871 | 727 |

### Semantic sanity checks

| Check | Result |
|---|---|
| `/api/stats` payload equality | ✅ identical (100,000 books / 10,711 authors / 5,824 series / 119 tags) |
| First-page book ids & order (title sort) | ✅ identical |
| Tag-filtered page ids + total (2,517) | ✅ identical |
| 5-page cursor walk ids + cursors | ✅ identical |
| Search result id sets (broad / narrow / miss) | ✅ identical (993 / 10 / 0 hits) |
| First-page ETag | ❌ **differs** — see below |

ETag finding: response bodies are semantically identical but **byte-different**
because the two stacks serialize JSON with different key order (serde struct
order vs `JSON.stringify` insertion order), and the ETag is a hash of the
serialized body (`first_page_body_sha256` in the JSON: rust
`1c7a9343…`, bun `e3eb3a60…`). Verified on a 2,000-book fixture that the parsed
documents are equal and only key order/spacing differ. No client-visible bug for
single-backend use (ETags are only compared against the same server), but it is
a real contract-level difference. Hash-port itself is *not* implicated.

## Interpretation (read with the caveats)

- **Cached endpoints & HTTP floor**: Rust serves cached responses with
  consistently lower p50/p95 and ~1.3–1.4× the throughput at c16. Both are
  sub-millisecond at c1; the Python client floor (`health@c1` ≈ 0.16–0.26 ms)
  is included in every number, so sub-0.2 ms differences are noise.
- **Uncached tag-filtered list**: parity at c1 (~6 ms p50, 8% apart); at c16
  both saturate around ~76 ms p50 / ~230 rps with Rust slightly tighter p95
  (105 vs 118 ms). Both are dominated by SQLite work.
- **FTS search**: mixed. Bun is ~30% faster on the broad query at c1 (2.0 vs
  2.9 ms) and slightly faster on miss queries; Rust is ~2× faster on the
  multi-token narrow query under c16 (18.2 vs 37.4 ms p50, 778 vs 395 rps) and
  ahead on broad@c16 by ~8–10%. No single search winner across shapes.
- **Keyset pagination**: near parity (bun p50 1.11 vs rust 1.27 ms; p95 1.87 vs
  2.57 ms); both bound by the same query plan.
- **Memory**: Rust lower in every measured state (idle ~38 vs ~73 MB; load peak
  ~257–263 vs ~311–322 MB; cold build 44 vs 155 MB).
- **Cold start**: Rust builds the identical snapshot ~13× faster (2.8 s vs
  35.9 s). Warm restarts: parity.
- **Startup readiness semantics**: both bind the port only after DB init
  completes, so health and ready are simultaneous in both — there is no window
  where health answers but the DB is not.

## Caveats & known limitations

- Follow-up code review found reader-path leaks not exercised by these API
  workloads: `SingleFlight::run` retains every distinct key (`state.rs`), and
  `leak_content_type` leaks a string per page request (`pages.rs`). These are
  unresolved; the measured RSS is **not** a long-duration memory-stability test.
- Deferred snapshot refresh can execute synchronously on the thread dropping
  the last stream lease. Refresh stalls are not measured in this benchmark.
- Cold startup was measured only once per backend; it is an observation, not
  a robust estimate of a general startup speedup.

- Single Apple Silicon laptop, loopback TCP, battery/thermal state uncontrolled;
  run-to-run variance was significant (e.g. rust `health@c1` rps ranged
  3,509–5,998 across rounds — per-round values are in the JSON). Alternating
  backend order per round mitigates but does not eliminate drift.
- Load client is Python stdlib with 16 threads (GIL released during socket I/O,
  but client overhead is real and included); `health` scenarios quantify that
  floor. Absolute rps figures are lower bounds on server capability, not
  ceilings; relative comparisons share the same client.
- RSS is sampled (50 ms cadence, `ps`) — peaks are lower bounds; 0-sample
  windows appear as `0` in per-phase data. macOS RSS overstates reclaimable
  memory (SQLite page cache / mmap).
- The fixture is synthetic (seeded RNG, uniform distributions, short titles);
  real libraries have different text lengths, tag cardinality and FTS selectivity.
- API cache state is per-scenario by construction (see above); search is never
  cached in either backend, so `search_*` numbers are pure handler+SQLite paths.
- Bun ran via `bun src/index.ts` (bundling happens in-process at startup), Rust
  as a prebuilt release binary — this matches how each is actually started in
  this repo (`bun start` / `scripts/build-rust.sh`), but it is not a
  like-for-like binary-format comparison.

## Harness incident & remediation (disclosure)

The first full run (15:01, discarded) passed `CALIBRE_CONFIG_DIR` (Calibre's
spelling). The library-path variable accepts both spellings, but the config-dir
variable only accepts `CALIBER_…`, so both backends silently shared
`~/.config/caliber/`, invalidating cache isolation and cold-boot numbers. The
contaminated files (`~/.config/caliber/metadata.db*`, `metadata.source.json` —
regenerable cache artifacts of the *user's* Caliber install) were deleted after
the run; the user's real library, `config.json` and `users.db` were never
touched, and caliber rebuilds its snapshot automatically on next start. The
harness now uses `CALIBER_CONFIG_DIR`, verifies per-backend cache-dir contents
after cold boot (recorded in the JSON), and all numbers in this report come from
the corrected run only.
