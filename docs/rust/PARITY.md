# Rust Backend Parity Status

Live tracker. "Verified" entries carry evidence (test/log output). Per-crate
detail: `crates/caliber-db/PARITY.md`, `crates/caliber-user/PARITY.md`,
`crates/caliber-server/PARITY.md`.

## Final integration status (2026-10-18, branch `rewrite/rust`)

| Check | Result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo check --workspace --all-targets` | 0 errors, 0 warnings |
| `cargo test --workspace` | **230 passed / 0 failed** (common 16, db 80, user 45, server 37 mock route tests, CLI/MCP module tests 21+21+10 via bin and test targets) |
| Release build | `target/release/caliber-server` (8.6MB), `caliber-cli` (3.4MB), `caliber-mcp` (3.1MB) |
| Black-box `tests/integration.test.ts` vs Rust server | **16/16 pass** (143 assertions) — `CALIBER_TEST_SERVER=$PWD/target/release/caliber-server bun test tests/integration.test.ts` |
| Black-box `tests/auth.test.ts` vs Rust server + `caliber-cli` | **27/27 pass** (90 assertions) — additionally sets `CALIBER_TEST_CLI=$PWD/target/release/caliber-cli`; covers sessions, Basic auth, throttling, first-run setup, auth-config UI matrix incl. prepare-then-commit + last-account guard, multi-user progress, CLI user add/passwd/list/remove via the Rust binary |
| TS baseline (default spawn) re-verified | integration 16/16, auth 27/27 against `bun src/index.ts` — suites are implementation-agnostic |
| `caliber-mcp` stdio smoke | initialize + tools/call `search_library` return the exact TS JSON-RPC shapes/text format against a fixture library |
| `caliber-cli` smoke | stats / search / `user add --password-stdin` / `user list` produce the TS JSON shapes |

Note: `CALIBER_TEST_SERVER`/`CALIBER_TEST_CLI` must be **absolute paths** — a
relative `./target/...` path works under plain `bun run` but not under
`bun test`'s spawn environment (the child starts and exits silently). Both
suites pass with absolute paths; no other harness change was needed.

## Verified continuity claims

| Claim | Evidence |
|---|---|
| `Bun.hash` reproduction (library-id continuity) | `crates/caliber-common` `wyhash::tests::bun_hash_matches_vectors` — 16/16 vectors from Bun 1.4.2 (Zig std Wyhash), incl. exactly-48B and >48B inputs and real library paths |
| users.db on-disk compatibility | `crates/caliber-user` opens TS-written schemas: legacy-progress migration tests preserve rows (most-recent on PK collision); schema identical incl. `progress_deletions` + `processed_mutations` |
| argon2id PHC interop, both directions | Bun 1.4.2 `Bun.password.hash` verified by Rust `argon2` 0.5 and vice versa (embedded Bun PHC vectors in `crates/caliber-user` tests + live Bun run) |
| Progress protocol (T2/T3/T5) | `crates/caliber-user` 22 tests: server_seq CAS, mutation-history duplicate, deletion-generation resurrect, monotonic furthest on conflict |
| Snapshot engine | `crates/caliber-db` 13 tests: generations/revisions, fault hook, lease-deferred refresh, timer pickup, prev-gen pruning, 8-thread pool, VACUUM-INTO read-only serialize |
| Keyset pagination | `crates/caliber-db` 49 tests: per-sort round-trips incl. non-ASCII, invalid cursors, FTS prefix/quotes, tag/format OR filters, rating projection, first-page totals |
| HTTP compat (ranges, ETag/304, guards, OPDS, EPUB, CBZ, thumbs, stream, MCP) | the 16/16 black-box integration suite above (same fixtures/assertions the TS backend passes) |

## Known deviations / remaining gaps (all documented per crate)

### Follow-up review: unresolved runtime issues

Passing compatibility tests does not establish long-running stability. A
follow-up review found:

- **Memory leak:** `crates/caliber-server/src/state.rs`, `SingleFlight::run`
  retains every distinct resource/revision key forever instead of removing
  completed entries. Reader activity can grow this map without bound.
- **Memory leak:** `crates/caliber-server/src/pages.rs`, `leak_content_type`
  calls `Box::leak` for every page response, including cache hits.
- **Refresh blocking:** dropping the last snapshot lease can synchronously
  run a deferred snapshot rebuild on a Tokio worker. The snapshot gate also
  blocks queries during publish (the latter is shared with the Bun design).
- **Scaling concerns:** CBZ manifest construction uses repeated linear name
  lookups; file streaming dispatches a blocking task per 64KB and advances by
  the requested rather than actual read length; page-meta sweep does not
  remove orphaned nonempty entries.

These were not fixed as part of the comparison. See
[`benchmark-results.md`](benchmark-results.md) for measured performance and
its limits. Do not interpret the short API benchmark as a reader soak test.

1. **JSON key order**: Rust serializes object keys alphabetically; TS uses
   insertion order. Values are identical; all suites parse JSON rather than
   diff bytes. Cosmetic only.
2. **CBR**: external `unrar` or `bsdtar` (macOS default); 501 when neither
   exists (verified: 16/16 with bsdtar on this machine).
3. **NFKC** in filename sanitization approximated char-wise (ASCII-identical;
   verified for the TS test corpus incl. Bun cross-check).
4. `pdf.js` worker is served from the static dir (`scripts/build-rust.sh`
   copies it from node_modules) instead of node_modules at runtime.
5. Open-EPUB archive LRU (max 3) skipped: archives are reopened per batch
   (cheap zip reopen; caps/leases/single-flight unchanged).
6. `tests/cursor-pagination.test.ts` remains a TS-internal suite (imports the
   TS data layer directly); its Rust equivalent is the 49-test
   `cursor_pagination` binary, not a spawnable suite.

## Fixed during integration (root causes worth remembering)

- Basic-auth throttling now uses `{ip}|{username.trim().toLowerCase()}`,
  matching TS and sharing the form-login bucket. Two regression tests cover
  cross-user isolation and cross-path throttling.
- Both TS and Rust accept the `CALIBER_LIBRARY_PATH` alias, with
  `CALIBRE_LIBRARY_PATH` taking precedence; an earlier claim of a TS typo
  was an inspection error.

- `is_same_signature` compares mtimes with a 1µs epsilon: same-file stats can
  wobble ~1 f64 ULP at epoch-ms magnitude (~0.2µs), which flaked refresh
  staleness checks.
- A test env-var misspelling (`CALIBER_LIBRARY_PATH` vs `CALIBRE_LIBRARY_PATH`)
  leaked across tests via the process env and produced misleading failures.
- Mid-session server restarts left mid-write sources and stale binaries that
  caused "ghost" failures; clean rebuilds resolved them (both worker agents
  noted this independently).
