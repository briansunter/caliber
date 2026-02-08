import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { BookListItem, CursorPaginatedResult } from "@/lib/calibre-optimized";

const API_BASE = "/api";

export type SortField = "title" | "author" | "added" | "rating";
export type SortOrder = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  order: SortOrder;
}

interface BooksResponse extends CursorPaginatedResult<BookListItem> {}

async function fetchBooks({
  pageParam,
  sortBy,
  sortOrder,
}: {
  pageParam?: string;
  sortBy: SortField;
  sortOrder: SortOrder;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", "50");
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }

  const response = await fetch(`${API_BASE}/books?${params}`);
  if (!response.ok) {
    throw new Error("Failed to fetch books");
  }
  return response.json();
}

async function searchBooks({
  pageParam,
  query,
  sortBy,
  sortOrder,
}: {
  pageParam?: string;
  query: string;
  sortBy: SortField;
  sortOrder: SortOrder;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", "50");
  params.set("q", query);
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }

  const response = await fetch(`${API_BASE}/books/search?${params}`);
  if (!response.ok) {
    throw new Error("Failed to search books");
  }
  return response.json();
}

// Infinite scroll hook for all books
export function useBooksInfinite(sortConfig: SortConfig = { field: "title", order: "asc" }) {
  return useInfiniteQuery({
    queryKey: ["books", "infinite", sortConfig.field, sortConfig.order],
    queryFn: ({ pageParam }) =>
      fetchBooks({
        pageParam,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 5 * 60, // 5 minutes
  });
}

// Infinite scroll hook for search
export function useSearchInfinite(query: string, sortConfig: SortConfig = { field: "title", order: "asc" }) {
  return useInfiniteQuery({
    queryKey: ["books", "search", "infinite", query, sortConfig.field, sortConfig.order],
    queryFn: ({ pageParam }) =>
      searchBooks({
        pageParam,
        query,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    enabled: query.trim().length > 0,
    staleTime: 1000 * 30, // 30 seconds for search
    gcTime: 1000 * 60, // 1 minute
  });
}

// Hook for library stats
export function useLibraryStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/stats`);
      if (!response.ok) {
        throw new Error("Failed to fetch stats");
      }
      return response.json() as Promise<{
        totalBooks: number;
        totalAuthors: number;
        totalSeries: number;
        totalTags: number;
      }>;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Hook for single book
export function useBook(id: number) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/books/${id}`);
      if (!response.ok) {
        throw new Error("Failed to fetch book");
      }
      return response.json() as Promise<BookListItem>;
    },
    enabled: !isNaN(id) && id > 0,
  });
}
