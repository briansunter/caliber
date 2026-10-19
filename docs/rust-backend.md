# Rust Backend — Build, Run, and Migration Guide

Caliber's backend (server, data layer, user state, CLI, MCP) is being
rewritten in Rust on this branch while the React frontend is preserved
unchanged. The TypeScript implementation under `src/` remains in the tree as
the behavioral reference and fallback until parity is verified.

## Workspace layout

| Crate | Purpose | Replaces |
|---|---|---|
| `crates/caliber-common` | Wire types, cursor codec, Bun-compatible wyhash, file signatures, config | `src/lib/config.ts`, parts of `calibre-optimized.ts`, `file-signature.ts` |
| `crates/caliber-db` | Read-only Calibre source + writable snapshot generations, FTS5, keyset pagination | `src/lib/calibre-optimized.ts` |
| `crates/caliber-user` | users.db: accounts, argon2id, sessions, reading progress | `src/lib/user-db.ts`, `src/lib/auth.ts` |
| `crates/caliber-server` | Axum HTTP server: JSON API, OPDS, file/media streaming, SPA hosting, MCP; CLI + stdio-MCP binaries | `src/index.ts`, `opds.ts`, `book-files.ts`, `epub-cache.ts`, `page-streaming.ts`, `cli.ts`, `mcp*.ts` |

The binding inter-crate contract is [`docs/rust/CONTRACT.md`](rust/CONTRACT.md).

## Build & run

```bash
# Backend only
cargo build --release
./target/release/caliber-server            # serves http://127.0.0.1:3003

# Full app (frontend + backend)
bun install
bun run build                              # builds the SPA into dist/
mkdir -p dist/pdfjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs dist/pdfjs/
CALIBER_STATIC_DIR=dist ./target/release/caliber-server
```

`scripts/build-rust.sh` performs the full sequence. The server serves SPA
assets from `CALIBER_STATIC_DIR` (default `./dist`) with an `index.html`
fallback for client-side routes, and `/pdfjs/pdf.worker.min.mjs` from the
same directory. Without a static dir the JSON API and OPDS still work; the
SPA route returns 404 and a warning is logged.

Binaries (all built and black-box verified 2026-10-18):

- `caliber-server` — HTTP server honoring the TS env vars (verified by the
  16/16 integration + 27/27 auth black-box suites).
- `caliber-cli` — CLI with the TS command surface (auth suite CLI flows pass
  against it).
- `caliber-mcp` — standalone stdio MCP server (initialize/tools/call smoke
  verified).

## Configuration

All TS environment variables are honored with the same names, precedence,
and defaults (verified end-to-end by the black-box suites; deviations are
enumerated in `docs/rust/PARITY.md`)
(`CALIBRE_LIBRARY_PATH`, `CALIBRE_DB_NAME`, `CALIBRE_HOST`,
`PORT`/`CALIBER_PORT`, `CALIBER_BASE_URL`, `CALIBER_TRUST_PROXY`,
`CALIBER_MCP_ENABLED`, `CALIBER_COOKIE_SECURE`, `CALIBER_AUTH_ENABLED`,
`CALIBER_DB_REFRESH_INTERVAL_MS`, `CALIBER_LIBRARY_ID`,
`CALIBER_USER_DB_PATH`, `CALIBER_CONFIG_DIR`, `CALIBER_ADMIN_RESTRICTED`,
`CALIBER_ALLOW_NOAUTH_ADMIN`, `PDFINFO_PATH`, `PDFTOPPM_PATH`), plus the
Rust-only `CALIBER_STATIC_DIR`. `config.json` keeps the TS shape and
atomic-replace semantics, including runtime toggles from the Settings UI
(auth-config matrix incl. prepare-then-commit enable verified by the
black-box auth suite).

Both backends accept `CALIBRE_LIBRARY_PATH` and its
`CALIBER_LIBRARY_PATH` alias; `CALIBRE_LIBRARY_PATH` takes precedence.

## Data continuity (verified)

1. **Library ids** — progress rows and on-disk caches are scoped by
   `lib-<Bun.hash(path).toString(36)>`. Bun's hash is Zig's std Wyhash;
   `caliber_common::wyhash::bun_hash` reproduces it **exactly — VERIFIED**
   against 16 vectors generated with Bun 1.4.2 (unit test in
   `crates/caliber-common`). Existing progress rows keep their library scope
   across the rewrite.
2. **users.db** — opens databases written by the TS app unchanged (same
   tables, legacy migrations preserving rows, argon2id PHC password hashes
   verified by both sides) — **VERIFIED** by the 45 `crates/caliber-user`
   tests incl. embedded Bun-produced PHC vectors and a legacy-schema
   migration test.
3. **Snapshot layout** — `<config>/metadata.db` generations, the
   `metadata.source.json` sidecar, FTS schema version 3, and the
   cross-process `snapshot.lock` follow the TS design; the Calibre source
   database is only ever opened read-only and a consistent snapshot is taken
   via `VACUUM INTO` — **VERIFIED** by the 13 `snapshot_engine` tests
   (fault hook, lease-deferred refresh, timer pickup, pruning, pool).
4. **API wire format** — JSON payloads, cursor encoding (base64url of
   `{"id":…,"sort":…}`), ETag/304 semantics, status codes, byte ranges,
   OPDS XML documents, EPUB/CBZ/PDF page endpoints, thumbnails, streaming,
   MCP JSON-RPC, and the CLI surface — **VERIFIED** by the black-box TS
   suites running against the Rust binaries: integration **16/16**, auth
   **27/27** (commands and evidence in `docs/rust/PARITY.md`). The
   untouched React frontend runs against either implementation.

## Testing

```bash
cargo test                      # unit tests per crate (fixture libraries in temp dirs only)

# Black-box compatibility suite (the TS repo tests) against either backend:
bun test tests/integration.test.ts tests/auth.test.ts          # TS backend (default)
# Rust backend — use ABSOLUTE paths (relative paths don't survive bun test's
# spawn environment; see docs/rust/PARITY.md):
CALIBER_TEST_SERVER=$PWD/target/release/caliber-server \
  bun test tests/integration.test.ts tests/auth.test.ts        # Rust backend
CALIBER_TEST_CLI=$PWD/target/release/caliber-cli \
CALIBER_TEST_SERVER=$PWD/target/release/caliber-server \
  bun test tests/auth.test.ts                                  # incl. CLI suites
```

The suites spawn the server under test as a child process, so redirecting
the command is the only change needed (`tests/server-cmd.ts`). All tests
create their Calibre fixture library and users.db inside a temp directory;
a real library or a real user database is never touched.

## Runtime parity notes & known gaps

See `crates/*/PARITY.md` for per-crate gap lists. Summary is maintained in
[`docs/rust/PARITY.md`](rust/PARITY.md).
