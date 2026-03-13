# Caliber

A fast, modern web interface for browsing and reading your [Calibre](https://calibre-ebook.com/) e-book library.

Built with [Bun](https://bun.sh), React, and TypeScript. Features infinite scroll, virtual scrolling, and cursor-based pagination optimized for large libraries (tested with 1M+ books).

## Features

- **Browse & search** your Calibre library from any browser
- **Infinite scroll** with virtual rendering for massive collections
- **Integrated readers** for EPUB and PDF formats
- **Cursor-based pagination** with O(1) performance (no OFFSET)
- **Book details** with metadata, covers, and download links
- **LRU API cache** with ETag support
- **CLI** for scripting and terminal access
- **MCP server** for AI tool integration
- **Read-only** — never modifies your Calibre database

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- A [Calibre](https://calibre-ebook.com/) library with a `metadata.db` file

### Install & Run

```bash
# Clone the repository
git clone https://github.com/briansunter/caliber.git
cd caliber

# Install dependencies
bun install

# Set your Calibre library path
export CALIBRE_LIBRARY_PATH="/path/to/your/Calibre Library"

# Start development server
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

A standalone [MCP](https://modelcontextprotocol.io/) server is available for AI tool integration:

```bash
bun src/mcp-server.ts
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CALIBRE_LIBRARY_PATH` | `~/Calibre Library` | Path to your Calibre library directory |
| `CALIBRE_DB_NAME` | `metadata.db` | Name of the Calibre database file |
| `PORT` | `3003` | Port for the web server |
| `NODE_ENV` | — | Set to `production` for production mode |

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

## Architecture

Caliber is a full-stack Bun application — both frontend and backend run on Bun with no additional runtime dependencies.

- **Server**: `Bun.serve()` with built-in routing and API endpoints
- **Database**: SQLite via `bun:sqlite` — connects directly to Calibre's `metadata.db` in read-only mode
- **Frontend**: React 19 + TanStack Router/Query/Virtual + Tailwind CSS v4
- **Build**: Bun's built-in bundler (no Vite/webpack)

### Performance

- **CTE queries** with cursor pagination — 17x faster than OFFSET for large datasets
- **Virtual scrolling** — only renders visible rows (~20 at a time)
- **Connection pooling** — 5-connection round-robin pool for concurrent requests
- **LRU cache** with ETag support on list endpoints (60s TTL)

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
