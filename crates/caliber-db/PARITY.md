# caliber-db — parity vs. the TypeScript reference

Reference: `src/lib/calibre-optimized.ts`, `src/lib/config.ts`,
`src/lib/file-signature.ts` (per `docs/rust/CONTRACT.md` §A).

## Status: full parity on the data layer

FTS5 was verified available in the bundled rusqlite SQLite build
(`-DSQLITE_ENABLE_FTS5` in libsqlite3-sys 0.30.1, plus an executing unit
test that creates a `USING fts5` virtual table, rebuilds it, and runs a
prefix MATCH). The LIKE fallback path was therefore **not** implemented:
a build without FTS5 fails `setup_snapshot_db` and `init()` returns
`false`, mirroring the TS behavior when `CREATE VIRTUAL TABLE ... USING
fts5` throws.

## Verified-parity behaviors (all covered by tests)

- Snapshot engine: read-only source (never written), serialized copy via
  `VACUUM INTO` (the SQLite equivalent of Bun's `db.serialize()`; also
  unit-tested on a read-only connection), tmp generation
  `metadata.db.gen-{n}.tmp-{pid}` + fsync + `PRAGMA journal_mode=DELETE` +
  in-tmp `setup_snapshot_db` + rename-publish with EEXIST/EPERM fallback,
  prev-generation retention (`metadata.db.prev-{id}`) and pruning,
  `metadata.source.json` sidecar (`{"sourcePath":..,"signature":..}` +
  trailing newline), cross-process `snapshot.lock` (exclusive mkdir),
  `CALIBER_SNAPSHOT_FAULT=1` fault hook (tmp cleaned, published generation
  untouched, error surfaced in `SnapshotStatus.failed`).
- Generations/revisions: monotonic ids, revision bumps on publish,
  5-connection pool with the exact pragmas
  (`cache_size=-64000`, `temp_store=memory`, `mmap_size=268435456`,
  `journal_mode=WAL`), refcounted checkouts + clonable RAII snapshot
  leases, deferred refresh retried on last release, refresh callbacks,
  periodic timer thread comparing `database_signature(source)` to the
  sidecar (`db_refresh_interval_ms`).
- Listing engine: two-phase page query with `cursor_sort` computed in SQL
  (never in Rust), rating sort via the `book_list_projection p` join with
  `ORDER BY p.rating, p.book` and `p.book` tie-break, cursor seek
  predicates `expr >= ? AND (expr > ? OR (expr = ? AND id > ?))`, tag OR /
  format OR (`UPPER(format) IN`) filters, `require_formats` EXISTS,
  first-page-only `includeTotal` count, limit clamp 1..=200 (default 100),
  stream clamp 1..=5000 (default 1000), `get_books_by_ids` cap 500,
  series feeds defaulting to `series_index`.
- `setup_snapshot_db`: every TS index (expression indexes with aliases
  stripped), FTS5 `books_fts` + `caliber_fts_meta` (`fts_schema_version=3`,
  `source_signature`), rebuild-verification MATCH probes, and the rating
  projection + count-based rebuild — SQL ported verbatim.
- Detail query `getBookByIdOptimized` SQL verbatim (isbn join, FILTER
  aggregates, lenient JSON-array-then-comma aggregate parsing);
  `getBooksByIdsOptimized`; stream column set identical to TS (no
  uuid/last_modified in stream rows).
- Catalog listings/entries (authors/series/tags/formats with text ids for
  formats, lenient `parseInt`-style numeric ids), `listAllTags` /
  `listAllFormats` orderings, `searchBooksByTitle` (FTS prefix-AND with
  `"`→`""` escaping), `searchBooksByAuthor`, `getAuthorByName`.
- Path safety: `isSafeLibraryPath` (lexical `resolve` under the library +
  `fs::canonicalize` containment when the file exists), Node-style
  `path.join` semantics (absolute segments do not reset the base), cover
  and format path resolution.
- `save_library_config_with_validation`: `prepare_library_selection` →
  read-only schema probe (books/authors/data/books_authors_link) →
  `apply_library_selection`, with the TS error strings ("controlled by
  CALIBRE_LIBRARY_PATH/CALIBRE_DB_NAME...", "Could not read the Calibre
  database: ...", "This file is not a supported Calibre database; missing
  ...").
- Cross-compat cursors: cursors produced by the TS implementation decode
  and vice versa (shared codec in caliber-common).

## Deliberate deviations (all additive or narrower-than-TS)

1. **Snapshot serialization mechanism**: Bun's `db.serialize()` is
   replaced by `VACUUM INTO` from a read-only connection. Same consistent
   committed-state semantics (WAL included); the resulting snapshot is
   vacuumed/defragmented, which is observable only in file layout, not
   content.
2. **`SnapshotStatus.failed` is also set on the startup path**
   (`ensureWritableDb`, i.e. first publish). TS only records failures from
   the periodic `swapDatabaseFile` path; the contract explicitly requires
   the fault-hook error to be visible in `SnapshotStatus.failed`, which
   this guarantees.
3. **`caliber_fts_meta.source_signature` JSON floats** are formatted
   JS-style (integral floats without `.0`). Semantically identical; only
   byte-comparison against a TS-written meta value could differ, and the
   result is a one-time FTS rebuild, never an error.
4. **Concurrency invariants are explicit**: TS relied on the
   single-threaded event loop; here a publish `gate` serializes snapshot
   swaps against pool checkouts/lease acquisition, and the pool bounds
   concurrent checkouts at 5 (blocking waiters) instead of handing out
   shared references to the same connection. No query-visible difference.
5. **Prune pattern**: TS matches prev-generation files by
   `{DB_NAME}.prev-`, which silently misses them for non-default db names
   (the snapshot is always `metadata.db`); this port prunes
   `metadata.db.prev-*` per the contract, fixing that inconsistency.
6. **Refresh timer implementation**: a `std::thread` sleeping in 250ms
   slices with a stop flag/condvar (TS uses `setInterval` + `unref`).
   Ticks are at-least-interval, same as TS; the thread exits promptly when
   the `CaliberDb` handle drops.

## Known gaps

- None functional. Not exercised here (server-crate concerns): LRU/ETag
  HTTP caching, OPDS rendering, epub/page media pipelines.
