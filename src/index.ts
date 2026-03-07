import { serve } from "bun";
import index from "./index.html";
import {
  listBooksCursor,
  searchBooksCursor,
  getBookByIdOptimized,
  getLibraryStats,
  getBookCount,
  streamBooks,
  getLibraryPath,
  getBookFormatPath,
  getBookCoverPath,
  initFTS,
  type BookListItem,
} from "./lib/calibre-optimized";
import { handleMCPRequest } from "./mcp";
import { join } from "node:path";
import { homedir } from "node:os";

const LIBRARY_PATH = getLibraryPath();
const WORK_DIR = join(homedir(), ".config", "caliber");
const DEFAULT_PORT = 3003;
const MAX_QUERY_LIMIT = 100;
const MAX_STREAM_BATCH_SIZE = 5000;
const SORT_FIELDS = ["title", "author", "added", "rating"] as const;
const SORT_ORDERS = ["asc", "desc"] as const;

type SortField = (typeof SORT_FIELDS)[number];
type SortOrder = (typeof SORT_ORDERS)[number];

function parseBoundedInt(
  value: string | null | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function parseSortField(value: string | null): SortField {
  return SORT_FIELDS.includes(value as SortField) ? (value as SortField) : "title";
}

function parseSortOrder(value: string | null): SortOrder {
  return SORT_ORDERS.includes(value as SortOrder) ? (value as SortOrder) : "asc";
}

// Initialize FTS on startup
initFTS();

// Simple LRU cache for API responses
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

interface CachedResponse {
  data: string;
  etag: string;
  timestamp: number;
}

const apiCache = new LRUCache<string, CachedResponse>(100);
const CACHE_TTL = 60 * 1000; // 1 minute for list results

function generateETag(data: string): string {
  const hash = Bun.hash(data);
  return `"${hash.toString(36)}"`;
}

function getCachedResponse(cacheKey: string, data: unknown, req: Request): Response {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === cached.etag) {
      return new Response(null, { status: 304, headers: { ETag: cached.etag } });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        ETag: cached.etag,
      },
    });
  }

  const jsonData = JSON.stringify(data);
  const etag = generateETag(jsonData);

  apiCache.set(cacheKey, { data: jsonData, etag, timestamp: now });

  return new Response(jsonData, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      ETag: etag,
    },
  });
}

// Streaming JSON response for large datasets
async function* streamBooksJSON(
  generator: AsyncGenerator<BookListItem[], void, unknown>,
): AsyncGenerator<string, void, unknown> {
  yield "[";
  let first = true;

  for await (const batch of generator) {
    for (const book of batch) {
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(book);
    }
  }

  yield "]";
}

const server = serve({
  port: parseBoundedInt(process.env.PORT, DEFAULT_PORT, { min: 1, max: 65535 }),
  routes: {
    // Health check
    "/api/health": {
      GET: () => Response.json({ status: "ok", timestamp: Date.now() }),
    },

    // Library stats
    "/api/stats": {
      GET: (req) => {
        const stats = getLibraryStats();
        return getCachedResponse("stats", stats, req);
      },
    },

    // Book count (lightweight)
    "/api/books/count": {
      GET: (req) => {
        const count = getBookCount();
        return getCachedResponse("count", { count }, req);
      },
    },

    // Stream all books (for massive datasets)
    "/api/books/stream": {
      GET: async (req) => {
        const url = new URL(req.url);
        const batchSize = parseBoundedInt(url.searchParams.get("batchSize"), 1000, {
          min: 1,
          max: MAX_STREAM_BATCH_SIZE,
        });

        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of streamBooksJSON(streamBooks(batchSize))) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
          },
        });
      },
    },

    // Cursor-based paginated list
    "/api/books": {
      GET: (req) => {
        try {
          const url = new URL(req.url);
          const cursor = url.searchParams.get("cursor") || undefined;
          const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
            min: 1,
            max: MAX_QUERY_LIMIT,
          });
          const sortBy = parseSortField(url.searchParams.get("sortBy"));
          const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));

          const result = listBooksCursor({ cursor, limit, sortBy, sortOrder });

          const cacheKey = `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}`;
          return getCachedResponse(cacheKey, result, req);
        } catch (error) {
          console.error("Error listing books:", error);
          return Response.json({ error: "Failed to list books" }, { status: 500 });
        }
      },
    },

    // Search with cursor pagination
    "/api/books/search": {
      GET: (req) => {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") || "";
          const cursor = url.searchParams.get("cursor") || undefined;
          const limit = parseBoundedInt(url.searchParams.get("limit"), 50, {
            min: 1,
            max: MAX_QUERY_LIMIT,
          });
          const sortBy = parseSortField(url.searchParams.get("sortBy"));
          const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));

          if (!query.trim()) {
            const result = listBooksCursor({ cursor, limit, sortBy, sortOrder });
            return getCachedResponse(
              `books:${cursor || "first"}:${limit}:${sortBy}:${sortOrder}`,
              result,
              req,
            );
          }

          const result = searchBooksCursor({ query, cursor, limit, sortBy, sortOrder });

          // Don't cache search results
          return Response.json(result, {
            headers: {
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          console.error("Error searching books:", error);
          return Response.json({ error: "Failed to search books" }, { status: 500 });
        }
      },
    },

    // Get single book
    "/api/books/:id": {
      GET: (req) => {
        try {
          const id = parseInt(req.params.id, 10);

          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const book = getBookByIdOptimized(id);

          if (!book) {
            return Response.json({ error: "Book not found" }, { status: 404 });
          }

          return getCachedResponse(`book:${id}`, book, req);
        } catch (error) {
          console.error("Error getting book:", error);
          return Response.json({ error: "Failed to get book" }, { status: 500 });
        }
      },
    },

    // Download book
    "/api/books/:id/download/:format": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          const format = req.params.format.toUpperCase();

          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const filePath = getBookFormatPath(id, format);

          if (!filePath) {
            return Response.json({ error: `Format ${format} not found` }, { status: 404 });
          }

          const file = Bun.file(filePath);

          if (!(await file.exists())) {
            return Response.json({ error: "File not found" }, { status: 404 });
          }

          const contentTypeMap: Record<string, string> = {
            EPUB: "application/epub+zip",
            MOBI: "application/x-mobipocket-ebook",
            AZW3: "application/vnd.amazon.ebook",
            PDF: "application/pdf",
            TXT: "text/plain",
            HTML: "text/html",
            RTF: "application/rtf",
            DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          };

          const book = getBookByIdOptimized(id);
          const safeTitle =
            book?.title.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_") || "book";
          const filename = `${safeTitle}.${format.toLowerCase()}`;

          const fileStat = await file.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(file, {
            headers: {
              "Content-Type": contentTypeMap[format] || "application/octet-stream",
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Cache-Control": "public, max-age=3600",
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error downloading book:", error);
          return Response.json({ error: "Failed to download book" }, { status: 500 });
        }
      },
    },

    // Get cover (full size)
    "/api/books/:id/cover": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          const coverPath = getBookCoverPath(id);
          if (!coverPath) {
            return Response.json({ error: "Cover not found" }, { status: 404 });
          }

          const file = Bun.file(coverPath);
          if (!(await file.exists())) {
            return Response.json({ error: "Cover file not found" }, { status: 404 });
          }

          const fileStat = await file.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(file, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error getting cover:", error);
          return Response.json({ error: "Failed to get cover" }, { status: 500 });
        }
      },
    },

    // Get cover thumbnail (resized for list/grid views)
    "/api/books/:id/thumb": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          if (Number.isNaN(id)) {
            return Response.json({ error: "Invalid book ID" }, { status: 400 });
          }

          // Check thumbnail cache first
          const thumbDir = join(WORK_DIR, "thumbs");
          const thumbPath = join(thumbDir, `${id}.jpg`);
          const thumbFile = Bun.file(thumbPath);

          if (await thumbFile.exists()) {
            const ifNoneMatch = req.headers.get("If-None-Match");
            const stat = await thumbFile.stat();
            const etag = `"t${stat.size}-${stat.mtime?.getTime() || 0}"`;
            if (ifNoneMatch === etag) {
              return new Response(null, { status: 304 });
            }
            return new Response(thumbFile, {
              headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=604800, immutable",
                ETag: etag,
              },
            });
          }

          // Generate thumbnail
          const coverPath = getBookCoverPath(id);
          if (!coverPath) {
            return Response.json({ error: "Cover not found" }, { status: 404 });
          }

          const coverFile = Bun.file(coverPath);
          if (!(await coverFile.exists())) {
            return Response.json({ error: "Cover file not found" }, { status: 404 });
          }

          // Use sharp-like resize if available, otherwise serve original with size hint
          // For now, serve the original with aggressive caching — the browser will cache it
          const fileStat = await coverFile.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(coverFile, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error getting thumb:", error);
          return Response.json({ error: "Failed to get thumbnail" }, { status: 500 });
        }
      },
    },

    // Serve PDF.js worker
    "/pdfjs/pdf.worker.min.mjs": {
      GET: async () => {
        const workerPath = join(
          import.meta.dir,
          "..",
          "node_modules",
          "pdfjs-dist",
          "build",
          "pdf.worker.min.mjs",
        );
        const file = Bun.file(workerPath);
        return new Response(file, {
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
          },
        });
      },
    },

    // MCP endpoint for AI tool integration
    "/mcp": {
      POST: async (req) => {
        try {
          const result = await handleMCPRequest(req);
          return result;
        } catch (error) {
          console.error("MCP error:", error);
          return Response.json({ error: "MCP request failed" }, { status: 500 });
        }
      },
    },

    // Serve index.html for all unmatched routes
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
console.log(`📚 Library: ${LIBRARY_PATH}`);
