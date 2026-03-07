# Caliber

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

## CLI

Run the new CLI:

```bash
bun run cli -- --help
```

Examples:

```bash
# Stats and counts
bun run cli -- stats
bun run cli -- count

# Paginated listing and search
bun run cli -- list --limit 20 --sortBy title --sortOrder asc
bun run cli -- search --query "sanderson" --limit 10 --table

# Book details and files
bun run cli -- get --id 42
bun run cli -- download --id 42 --format epub --out my-book.epub
bun run cli -- cover --id 42 --out my-book-cover.jpg
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CALIBRE_LIBRARY_PATH` | `/Users/bsunter/Calibre Library` | Path to your Calibre library directory |
| `CALIBRE_DB_NAME` | `metadata.db` | Name of the Calibre database file |
| `PORT` | `3003` | Port for the web server |
| `NODE_ENV` | — | Set to `production` for production mode |
