# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Caliber is a personal Calibre library management application built with Bun, React, and TypeScript. It provides a web interface for browsing, searching, and downloading e-books from a Calibre database with infinite scroll, virtual scrolling, and cursor-based pagination optimized for large libraries (tested with 1M+ books).

## Development Commands

```bash
# Install dependencies
bun install

# Development server with hot reload (port 3000)
bun dev

# Production server
bun start

# Build for production
bun run build

# Run tests
bun test
```

## Architecture

### Full-Stack Bun Architecture

This is a full-stack Bun application - both frontend and backend run on Bun:

- **Backend**: `src/index.ts` - Bun.serve() with API routes and HTML serving
- **Frontend**: `src/frontend.tsx` - React app bundled by Bun's built-in bundler
- **Database**: `src/lib/calibre-optimized.ts` - SQLite via `bun:sqlite`

### Database Layer (Calibre Integration)

The app connects directly to Calibre's `metadata.db` SQLite database in **read-only mode**:

```typescript
// Library path is configurable via CALIBRE_LIBRARY_PATH env var
const LIBRARY_PATH = process.env.CALIBRE_LIBRARY_PATH || "/Users/bsunter/Desktop";
```

Key architectural decisions:
- **Read-only access**: Database opened with `{ readonly: true }` - never modifies Calibre data
- **Connection pooling**: 5-connection round-robin pool for concurrent requests
- **CTE-based queries**: Common Table Expressions for O(1) cursor pagination (avoids OFFSET performance issues)
- **Cursor pagination**: Keyset pagination using base64url-encoded cursors (not offset-based)

Calibre schema uses link tables for many-to-many relationships:
- `books` → `books_authors_link` → `authors`
- `books` → `books_tags_link` → `tags`
- `books` → `books_series_link` → `series`
- `books` → `data` (file formats)

### API Architecture

RESTful API with LRU caching and ETag support:

```
GET /api/health              # Health check
GET /api/stats               # Library statistics (cached)
GET /api/books               # Cursor-paginated list (cached)
GET /api/books/search?q=...  # Search books (uncached)
GET /api/books/:id           # Single book details
GET /api/books/:id/download/:format  # Download book file
GET /api/books/:id/cover     # Get cover image
```

### Frontend Architecture

- **Routing**: TanStack Router with file-based routes (`src/routes/`)
- **State Management**: TanStack Query for server state, React useState for UI state
- **Data Fetching**: Infinite scroll via `useInfiniteQuery` with cursor pagination
- **Virtual Scrolling**: `@tanstack/react-virtual` for rendering massive lists efficiently
- **Sorting**: Client-side sort configuration passed to API via query params

Key components:
- `BookTableInfinite.tsx` - Virtualized table with infinite scroll and sortable headers
- `useBooksInfinite.ts` - Hooks for infinite scroll data fetching

### Performance Optimizations

1. **Database**: CTE queries with cursor pagination (17x faster than OFFSET for large datasets)
2. **Frontend**: Virtual scrolling only renders visible rows (~20 at a time)
3. **API**: LRU cache with ETag support for list endpoints (60s TTL)
4. **Connection pooling**: Reuses SQLite connections across requests

## File Structure

```
src/
├── index.ts              # Bun server entry (API routes + HTML serving)
├── frontend.tsx          # React entry point
├── index.html            # HTML template
├── routes/               # TanStack Router routes
│   ├── __root.tsx        # Root layout
│   ├── index.tsx         # Home page (book listing with stats/search)
│   └── book.$id.tsx      # Book detail page
├── components/
│   ├── BookTableInfinite.tsx  # Virtual scroll table with sorting
│   ├── BookSearch.tsx    # Search input
│   └── ui/               # shadcn/ui components
├── hooks/
│   └── useBooksInfinite.ts    # Infinite scroll + sort hooks
├── lib/
│   ├── calibre-optimized.ts   # Database layer (read-only SQLite)
│   └── query-client.ts   # TanStack Query client config
└── index.css             # Tailwind CSS entry
```

## Technology Stack

- **Runtime**: Bun (not Node.js)
- **Database**: SQLite via `bun:sqlite` (not better-sqlite3)
- **Server**: `Bun.serve()` with built-in routing (not Express)
- **Frontend**: React 19 + TanStack (Router, Query, Virtual) + Tailwind CSS v4
- **Build**: Bun's built-in bundler (not Vite/webpack)

## Environment Variables

```bash
CALIBRE_LIBRARY_PATH=/path/to/calibre/library  # Default: /Users/bsunter/Desktop
NODE_ENV=production                            # Set for production mode
```

## Key Patterns

### Adding a New API Endpoint

Add route to `src/index.ts` in the `routes` object:

```typescript
"/api/my-endpoint": {
  GET: (req) => {
    return Response.json({ data: "value" });
  },
}
```

### Adding a Database Query

Add function to `src/lib/calibre-optimized.ts` using the CTE pattern:

```typescript
export function myQuery(): ResultType {
  const db = getDb();
  // Use CTE for pagination if returning multiple rows
  const query = `...`;
  return db.query(query).all(...) as ResultType;
}
```

### Adding a Frontend Route

Create file in `src/routes/` following TanStack Router conventions:
- `src/routes/my-route.tsx` → `/my-route`
- `src/routes/nested.$id.tsx` → `/nested/:id`
