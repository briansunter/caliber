# Caliber

A fast, modern web interface for browsing, reading, and downloading books from your [Calibre](https://calibre-ebook.com/) library. Optimized for large collections with 1M+ books.

## Highlights

- **Fast** — cursor-based pagination instead of OFFSET queries, so browsing stays instant no matter how large your library gets
- **Read in the browser** — built-in EPUB, PDF, CBZ, and CBR readers
- **Download books** — access any format stored in your library
- **OPDS catalog** — browse from OPDS-compatible reader apps with download and inline file links
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

OPDS clients can use [http://localhost:3003/opds](http://localhost:3003/opds). The web reader
defaults to streaming mode and also supports full-file loading with `?mode=full` where the
format supports it. EPUB streams unpacked entries, PDF uses HTTP byte ranges, CBZ supports
streamed pages or full-archive loading, and CBR streams extracted pages.

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
GET /api/books/:id/file/:format        Open/stream book file inline with byte ranges
GET /api/books/:id/epub/*              Stream unpacked EPUB entries
GET /api/books/:id/pages/:format/manifest
GET /api/books/:id/pages/:format/:page Stream CBZ/CBR/PDF page images
GET /api/stats                         Library statistics
GET /opds                              OPDS catalog root
GET /opds/books                        OPDS paged acquisition feed
GET /opds/authors                      OPDS author navigation feed
GET /opds/series                       OPDS series navigation feed
GET /opds/tags                         OPDS tag navigation feed
GET /opds/formats                      OPDS format navigation feed
GET /opds/recent                       OPDS recently-added feed
GET /opds/search?q=                    OPDS search feed
GET /opds/search.xml                   OPDS OpenSearch descriptor
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
