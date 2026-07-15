# Caliber

Caliber is a fast, local-first web interface for browsing, searching, reading, and downloading books from any [Calibre](https://calibre-ebook.com/) library. It uses cursor pagination and virtualized lists so large collections remain responsive.

## Features

- EPUB, PDF, CBZ, and CBR browser readers
- Downloads for every format stored in the library
- OPDS catalog for compatible reading apps
- Full-text search, tag filters, infinite scroll, list/grid views, and reading progress
- Read-only access to Calibre data with a separate writable search/cache snapshot
- Periodic database refresh while the server is running (including SQLite WAL/SHM changes)
- Bun CLI and optional MCP integrations

## Quick start

Requires [Bun](https://bun.sh) and a Calibre library. Caliber looks for `metadata.db` in `~/Calibre Library` by default.

```bash
git clone https://github.com/briansunter/caliber.git
cd caliber
bun install
bun dev
```

Open [http://localhost:3003](http://localhost:3003). On first launch, if the default library is not present, Caliber opens a library setup screen where you can enter the path to a Calibre `metadata.db` (or its containing library folder). The selection is validated and applied without a restart; it can be changed later in Settings.

For a scripted or headless setup:

```bash
CALIBRE_LIBRARY_PATH="/path/to/Calibre Library" bun dev
```

Caliber binds to `127.0.0.1` by default. If you intentionally expose it on another interface, set `CALIBER_HOST` and put it behind authentication and HTTPS; the username prompt is a local reading-progress profile, not authentication.

## Configuration

Configuration can be stored in the platform config directory (`~/.config/caliber/config.json` on macOS/Linux, `%APPDATA%\\caliber\\config.json` on Windows), set with `CALIBER_CONFIG_DIR`, or supplied through environment variables. Environment variables take precedence.

| Variable | Default | Description |
|---|---|---|
| `CALIBRE_LIBRARY_PATH` | `~/Calibre Library` | Calibre library directory; `CALIBER_LIBRARY_PATH` is accepted as an alias |
| `CALIBRE_DB_NAME` | `metadata.db` | Database filename inside the library directory |
| `PORT` / `CALIBER_PORT` | `3003` | HTTP port |
| `CALIBER_HOST` | `127.0.0.1` | Bind address; keep loopback for a local library |
| `CALIBER_CONFIG_DIR` | platform config directory | Caliber cache and config directory |
| `CALIBER_DB_REFRESH_INTERVAL_MS` | `60000` | Database refresh interval, clamped to 5 seconds–1 hour |
| `CALIBER_BASE_URL` | request URL | Public URL used in OPDS feeds behind a proxy |
| `CALIBER_TRUST_PROXY` | `false` | Honor forwarded host/protocol headers only when behind a trusted proxy |
| `CALIBER_COOKIE_SECURE` | production: `true` | Add the `Secure` attribute to the progress cookie |
| `CALIBER_MCP_ENABLED` | `false` | Enable the HTTP MCP endpoint; the standalone stdio server is separate |
| `CALIBER_USER_DB_PATH` | `<config>/users.db` | Location for local profile and reading-progress data |
| `PDFINFO_PATH` | auto-detected | Optional path to Poppler `pdfinfo` |
| `PDFTOPPM_PATH` | auto-detected | Optional path to Poppler `pdftoppm` |

Copy `.env.example` as a starting point for a deployment. Caliber copies the source database through SQLite serialization into its cache so live WAL changes are included, then checks the source periodically and rebuilds its FTS snapshot when it changes. It never writes to the Calibre library.

## CLI

```bash
bun run cli -- stats
bun run cli -- search --query "sanderson" --limit 10 --table
bun run cli -- download --id 42 --format epub --out book.epub
bun run cli -- --help
```

Each command initializes the same writable snapshot used by the server, so first-run CLI commands work on a fresh config directory.

## MCP

For local AI tool integration over stdio:

```bash
bun src/mcp-server.ts
```

The HTTP `/mcp` endpoint is disabled by default. Enable it only on a protected local or authenticated network deployment with `CALIBER_MCP_ENABLED=true`.

## API

```text
GET  /api/health
GET  /api/config/library
PUT  /api/config/library
GET  /api/books?cursor=&limit=&sortBy=&sortOrder=&tag=
GET  /api/books/search?q=
GET  /api/books/:id
GET  /api/books/:id/cover
GET  /api/books/:id/thumb
GET  /api/books/:id/download/:format
GET  /api/books/:id/file/:format
GET  /api/books/:id/epub/*
GET  /api/books/:id/pages/:format/manifest
GET  /api/books/:id/pages/:format/:page
GET  /api/stats
GET  /opds
GET  /opds/search?q=
```

## Development and release checks

```bash
bun run check       # tests + typecheck + lint + production frontend build
bun test            # test suite only
bun run build       # production frontend bundle
```

The production server runs from `src/index.ts` so the Bun runtime can continue to serve the generated HTML entrypoint and reader assets. `dist/` is a frontend build artifact and is intentionally ignored.

## License

[MIT](LICENSE)
