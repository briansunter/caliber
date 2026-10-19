# caliber-user — parity report

Reference: `src/lib/user-db.ts` + `src/lib/auth.ts` (TS behavioral reference,
SQL ported verbatim). Status: **full parity** for everything in this crate's
scope, with the additive notes and Unicode-edge-case caveats below.

## On-disk compatibility

- Schema, `PRAGMA journal_mode=WAL` / `busy_timeout=5000` / `foreign_keys=ON`,
  and all migrations are byte-identical SQL ports: `users`, `progress`
  (including the legacy rebuild to PK `(user_id, library_id, book_id, format)`
  keeping the most-recent row on collisions), `progress_deletions`,
  `processed_mutations`, `sessions`, all indexes, and the additive
  `password_hash` / `auth_epoch` column migrations. A users.db written by the
  TS app opens and keeps working (covered by the legacy-migration tests).
- Password hashes: argon2id PHC strings. Bun-produced hashes verify (two
  literal `Bun.password.hash` vectors are embedded as test constants), and
  Rust-produced hashes verify under `Bun.password.verify` (parameters are
  carried in the PHC string; Rust uses argon2-crate defaults m=19456,t=2,p=1
  vs Bun's m=65536,t=2,p=1 — cross-verified both directions during
  development).

## Deviations / notes (all minor)

1. **`Auth::with_cookie_secure(user_db, cookie_secure)`** is provided in
   addition to the contract's `Auth::new(user_db)` (which defaults
   `cookie_secure = false`). The server should construct with
   `with_cookie_secure(..., config.cookie_secure)` so the session cookie gets
   `Secure` in production. This keeps the exact CONTRACT.md `new` signature
   compiling for the server crate.
2. **`UserDb::open_at(path)`** is additive (used by tests/tools); `open(config)`
   resolves `CALIBER_USER_DB_PATH || <config_dir>/users.db` exactly like TS.
3. **Error handling**: TS throws on unexpected SQLite failures; this crate
   panics with a `caliber-user:` message (server maps either to a 500). One
   deliberate difference: `create_user_with_password` maps SQL errors (e.g. a
   lost race on `username_lower`) to `None` instead of throwing — the TS
   server pre-checks duplicates and returns 409, so this is unreachable
   except in races and returning `None` (→ "Could not create user") is
   safer than unwinding.
4. **Unicode edges**: JS string ops are UTF-16-based; this port slices by
   `char` ( usernames/locations/formats are ASCII in practice; a difference
   requires astral-plane characters exactly at a truncation boundary).
   `to_lowercase()` uses full Unicode case mapping vs JS's simple mapping
   (differs only for e.g. Turkish `İ`). JS `trim`/`\s` character sets are
   reproduced exactly (including U+00A0 and U+FEFF in `\s`).
   `Number.parseInt(s, 10)` semantics (leading whitespace, optional sign,
   trailing junk ignored) are reproduced exactly; over-i64 "integers" are
   treated as invalid, which can only affect inputs that could never pass the
   TS `String(n) === location.trim()` check anyway.
5. **Concurrency model**: a single `Mutex<Connection>` replaces the TS single
   shared Bun `Database` handle (both serialize all access). The upsert /
   delete / clear / password-rotation paths run inside SQLite transactions
   exactly like the TS `database.transaction(...)` wrappers; early returns
   commit (mirroring Bun's commit-on-return), which matters for the
   duplicate-backfill insert. The global argon2 semaphore is a blocking
   Condvar gate (max 4) — the server should already be calling this crate
   from `spawn_blocking`.
6. **`base64` crate not in the dependency list**: URL-safe-no-pad encoding
   (session tokens) and Node's lenient standard-alphabet decoder (Basic
   auth) are implemented in `util.rs` (~40 lines, unit-tested against
   `btoa`/Node semantics) rather than adding a dependency.
7. **Throttle division of labor** (matches TS, worth restating for the
   server): `authenticate_with_password` does *not* check the throttle — the
   TS login route checks `loginRateLimited` first and returns 429.
   `authenticate_basic` *does* check the throttle internally, but only after
   the Basic cache lookup, so a cached valid header bypasses a limited
   client key (same as TS).
8. **Additive derives** beyond the contract (`PartialEq` on row types,
   `Display + Error` on `PasswordError`, exported `USERNAME_MAX`) — no
   contract signature changed.

## Verified behavior (43 tests, all green)

- Schema creation, WAL, reopen stability; config-dir vs
  `CALIBER_USER_DB_PATH` resolution.
- Users: normalization, case-insensitive lookup, last-seen bump, delete with
  cascade, credentials/epoch, `list_auth_users` ordering.
- `upsert_progress` protocol: initial write `server_seq=1`, sequence
  advance per format row, duplicate `mutationId` idempotency (including
  replay-after-delete and the legacy `last_mutation_id` single-slot
  backfill), baseRevision conflict (resume point kept, monotonic
  furthest/finished merge, no seq bump), deletion-generation guard
  (`reason:"deleted"`, fresh `baseDeletionSeq` resurrect at seq 1,
  `force` resurrect), book-level and library-level tombstones, mutation
  history prune to last 50.
- Reads: publication-level collapse (finished > furthest > recent),
  legacy `"default"` fallbacks, limit clamps, `set_finished` semantics.
- Sanitization: format-aware location validation (EPUB CFI / numeric pages,
  20000 cap), percentage clamp, format uppercase/truncate.
- Legacy users.db migration: rows preserved, furthest backfill, PK rebuild
  (most-recent-on-collision), additive user columns, post-migration writes.
- Auth: argon2 round-trip, Bun PHC vectors (both directions), session
  create/resolve/revoke, expiry purge, epoch invalidation after rotation and
  cross-process, throttle (10/15min, success clears, per-key), Basic parse
  matrix, Basic flow + cache epoch recheck, cookie header (incl. `Secure`
  variant), `needs_initial_setup`, `set_password_for_user` create/rotate +
  exact error messages.

## Known gaps

None within this crate's scope. (Server-level concerns — last-account
deletion guard, `/api/*` wiring, cookie `caliber-user` profile flow — are
owned by caliber-server per the contract.)
