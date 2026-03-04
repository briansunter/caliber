import { serve } from "bun";
import { createHash } from "node:crypto";
import { join } from "node:path";
import index from "./index.html";
import {
  listBooks,
  searchBooks,
  getBookById,
  getBookFormats,
  getLibraryPath,
} from "./lib/calibre";

const LIBRARY_PATH = getLibraryPath();

// Simple in-memory cache for API responses
const apiCache = new Map<string, { data: string; etag: string; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Generate ETag from content
 */
function generateETag(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Check if client cache is still valid using If-None-Match header
 */
function isCacheValid(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers.get("If-None-Match");
  return ifNoneMatch === etag;
}

/**
 * Get cached response or generate new one
 */
function getCachedResponse(cacheKey: string, data: unknown, req: Request): Response {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    // Check if client's cached version is still valid
    if (isCacheValid(req, cached.etag)) {
      return new Response(null, { status: 304, headers: { ETag: cached.etag } });
    }

    return new Response(cached.data, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        ETag: cached.etag,
      },
    });
  }

  // Generate new response
  const jsonData = JSON.stringify(data);
  const etag = generateETag(jsonData);

  // Store in cache
  apiCache.set(cacheKey, { data: jsonData, etag, timestamp: now });

  return new Response(jsonData, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      ETag: etag,
    },
  });
}

/**
 * Clear expired cache entries periodically
 */
function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, value] of apiCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      apiCache.delete(key);
    }
  }
}

// Clean cache every 10 minutes
setInterval(cleanExpiredCache, 10 * 60 * 1000);

const server = serve({
  routes: {
    // API routes - more specific routes must come before parameterized ones
    "/api/books/search": {
      GET: async (req) => {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") || "";
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);

          const cacheKey = `search:${query}:${limit}`;
          const result = query
            ? searchBooks(query, 1, limit)
            : listBooks(1, limit);

          return getCachedResponse(cacheKey, result.books, req);
        } catch (error) {
          console.error("Error searching books:", error);
          return Response.json(
            { error: "Failed to search books" },
            { status: 500 }
          );
        }
      },
    },

    "/api/books/:id/download/:format": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);
          const format = req.params.format.toUpperCase();

          if (Number.isNaN(id)) {
            return Response.json(
              { error: "Invalid book ID" },
              { status: 400 }
            );
          }

          const book = getBookById(id);
          if (!book) {
            return Response.json(
              { error: "Book not found" },
              { status: 404 }
            );
          }

          const formats = getBookFormats(id);
          const bookFormat = formats.find(
            (f) => f.format.toUpperCase() === format
          );

          if (!bookFormat) {
            return Response.json(
              { error: `Format ${format} not found` },
              { status: 404 }
            );
          }

          const filePath = join(
            LIBRARY_PATH,
            book.path,
            `${bookFormat.name}.${format.toLowerCase()}`
          );
          const file = Bun.file(filePath);

          if (!(await file.exists())) {
            return Response.json(
              { error: "File not found" },
              { status: 404 }
            );
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

          const safeTitle = book.title
            .replace(/[^a-zA-Z0-9\s-]/g, "")
            .replace(/\s+/g, "_");
          const filename = `${safeTitle}.${format.toLowerCase()}`;

          // Generate ETag based on file size and last modified
          const fileStat = await file.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          // Check If-None-Match for download caching
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
          return Response.json(
            { error: "Failed to download book" },
            { status: 500 }
          );
        }
      },
    },

    "/api/books/:id/cover": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);

          if (Number.isNaN(id)) {
            return Response.json(
              { error: "Invalid book ID" },
              { status: 400 }
            );
          }

          const book = getBookById(id);
          if (!book || !book.has_cover) {
            return Response.json(
              { error: "Cover not found" },
              { status: 404 }
            );
          }

          const coverPath = join(LIBRARY_PATH, book.path, "cover.jpg");
          const file = Bun.file(coverPath);

          if (!(await file.exists())) {
            return Response.json(
              { error: "Cover file not found" },
              { status: 404 }
            );
          }

          // Generate ETag based on file size and last modified
          const fileStat = await file.stat();
          const etag = `"${fileStat.size}-${fileStat.mtime?.getTime() || 0}"`;

          // Check If-None-Match for cover caching (aggressive caching for covers)
          const ifNoneMatch = req.headers.get("If-None-Match");
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(file, {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable", // 7 days, immutable since covers don't change
              ETag: etag,
            },
          });
        } catch (error) {
          console.error("Error getting cover:", error);
          return Response.json(
            { error: "Failed to get cover" },
            { status: 500 }
          );
        }
      },
    },

    "/api/books/:id": {
      GET: async (req) => {
        try {
          const id = parseInt(req.params.id, 10);

          if (Number.isNaN(id)) {
            return Response.json(
              { error: "Invalid book ID" },
              { status: 400 }
            );
          }

          const cacheKey = `book:${id}`;
          const book = getBookById(id);

          if (!book) {
            return Response.json(
              { error: "Book not found" },
              { status: 404 }
            );
          }

          return getCachedResponse(cacheKey, book, req);
        } catch (error) {
          console.error("Error getting book:", error);
          return Response.json(
            { error: "Failed to get book" },
            { status: 500 }
          );
        }
      },
    },

    "/api/books": {
      GET: async (req) => {
        try {
          const url = new URL(req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);

          const cacheKey = `books:${limit}`;
          const result = listBooks(1, limit);

          return getCachedResponse(cacheKey, result.books, req);
        } catch (error) {
          console.error("Error listing books:", error);
          return Response.json(
            { error: "Failed to list books" },
            { status: 500 }
          );
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
