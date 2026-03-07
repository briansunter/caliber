# Caliber

A fast, modern web interface for browsing and reading your [Calibre](https://calibre-ebook.com/) e-book library. Built with Bun, React, and TypeScript.

Caliber connects to your existing Calibre library in read-only mode and provides infinite scroll, virtual scrolling, and cursor-based pagination optimized for large libraries (tested with 1M+ books).

## Features

- Browse, search, and sort your Calibre library from any browser
- Infinite scroll with virtual rendering for massive collections
- Integrated EPUB and PDF reader
- Book detail pages with metadata, covers, and download links
- Cursor-based pagination with O(1) performance (no OFFSET)
- LRU API cache with ETag support
- CLI for scripting and terminal access
- MCP server for AI tool integration
- Dark academia theme with responsive design

## Quick Start

```bash
# Install dependencies
bun install

# Set your Calibre library path
export CALIBRE_LIBRARY_PATH="/path/to/your/Calibre Library"

# Start development server (port 3003)
bun dev
```

Open [http://localhost:3003](http://localhost:3003) in your browser.

## Usage

### Web Server

```bash
# Development with hot reload
bun dev

# Production
bun start

# Build frontend for production
bun run build
```

### CLI

```bash
bun run cli -- --help

# Examples
bun run cli -- stats
bun run cli -- list --limit 20 --sortBy title --sortOrder asc
bun run cli -- search --query "sanderson" --limit 10 --table
bun run cli -- get --id 42
bun run cli -- download --id 42 --format epub --out book.epub
bun run cli -- cover --id 42 --out cover.jpg
```

### MCP Server

A standalone MCP server is available for AI tool integration:

```bash
bun src/mcp-server.ts
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CALIBRE_LIBRARY_PATH` | `/Users/bsunter/Calibre Library` | Path to your Calibre library directory |
| `CALIBRE_DB_NAME` | `metadata.db` | Name of the Calibre database file |
| `PORT` | `3003` | Port for the web server |
| `NODE_ENV` | - | Set to `production` for production mode |

## API

```
GET /api/health                        Health check
GET /api/stats                         Library statistics
GET /api/books?cursor=&limit=&sortBy=  Paginated book list
GET /api/books/search?q=&cursor=       Search books
GET /api/books/count                   Total book count
GET /api/books/stream                  Stream all books (JSON)
GET /api/books/:id                     Book details
GET /api/books/:id/cover               Cover image
GET /api/books/:id/thumb               Cover thumbnail
GET /api/books/:id/download/:format    Download book file
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Database**: SQLite via `bun:sqlite` (read-only access to Calibre's `metadata.db`)
- **Server**: `Bun.serve()` with built-in routing
- **Frontend**: React 19, TanStack Router/Query/Virtual, Tailwind CSS v4
- **Build**: Bun's built-in bundler
- **Linting**: Biome

## Development

```bash
# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Full check (typecheck + lint + build)
bun run check
```

## License

[MIT](LICENSE)
