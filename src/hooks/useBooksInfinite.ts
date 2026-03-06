import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BookListItem, CursorPaginatedResult } from "@/lib/calibre-optimized";

const API_BASE = "/api";
const PAGE_SIZE = 100;

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
  params.set("limit", String(PAGE_SIZE));
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }

  const response = await fetch(`${API_BASE}/books?${params}`, { priority: "high" });
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
  params.set("limit", String(PAGE_SIZE));
  params.set("q", query);
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }

  const response = await fetch(`${API_BASE}/books/search?${params}`, { priority: "high" });
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
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    maxPages: 50,
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
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    maxPages: 20,
  });
}

// Shared hook: flattens pages and exposes fetch controls
export function useFlattenedBooks(searchQuery: string, sortConfig: SortConfig) {
  const isSearching = searchQuery.trim().length > 0;
  const booksQuery = useBooksInfinite(sortConfig);
  const searchQueryHook = useSearchInfinite(searchQuery, sortConfig);
  const query = isSearching ? searchQueryHook : booksQuery;

  const books = useMemo(() => {
    return query.data?.pages.flatMap((page) => page.items) ?? [];
  }, [query.data]);

  return {
    books,
    hasNextPage: query.hasNextPage ?? false,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
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
    staleTime: 1000 * 60 * 5,
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
