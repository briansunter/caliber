# Caliber

A fast, modern web interface for browsing, reading, and downloading books from your [Calibre](https://calibre-ebook.com/) library. Optimized for large collections with 1M+ books.

## Highlights

- **Fast** — cursor-based pagination instead of OFFSET queries, so browsing stays instant no matter how large your library gets
- **Read in the browser** — built-in EPUB and PDF readers
- **Download books** — access any format stored in your library
- **Modern UI** — infinite scroll, virtual rendering, responsive design
- **Lightweight** — single process, minimal dependencies

## Quick Start

Requires [Bun](https://bun.sh) and a [Calibre](https://calibre-ebook.com/) library.

```bash
git clone https://github.com/briansunter/caliber.git
cd caliber
bun install
export CALIBRE_LIBRARY_PATH="/path/to/your/Calibre Library"
bun dev
```

Open [http://localhost:3003](http://localhost:3003).

## CLI

```bash
bun run cli -- stats
bun run cli -- search --query "sanderson" --limit 10 --table
bun run cli -- download --id 42 --format epub --out book.epub
```

Run `bun run cli -- --help` for all commands.

## MCP Server

For AI tool integration via [MCP](https://modelcontextprotocol.io/):

```bash
bun src/mcp-server.ts
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CALIBRE_LIBRARY_PATH` | `~/Calibre Library` | Path to your Calibre library |
| `PORT` | `3003` | Server port |
| `NODE_ENV` | — | Set to `production` for production mode |

## API

```
GET /api/books?cursor=&limit=&sortBy=  Paginated book list
GET /api/books/search?q=               Search books
GET /api/books/:id                     Book details
GET /api/books/:id/cover               Cover image
GET /api/books/:id/download/:format    Download book file
GET /api/stats                         Library statistics
```

## Tech Stack

[Bun](https://bun.sh) + React 19 + TanStack (Router, Query, Virtual) + Tailwind CSS v4 + SQLite via `bun:sqlite`

## Development

```bash
bun run check   # typecheck + lint + build
bun run build   # build frontend
```

## License

[MIT](LICENSE)
