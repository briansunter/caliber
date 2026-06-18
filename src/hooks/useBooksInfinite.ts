import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BookListItem, BookWithDetails, CursorPaginatedResult } from "@/lib/calibre-optimized";
import { fetchJson } from "@/lib/http";

const API_BASE = "/api";
const PAGE_SIZE = 100;

export type SortField = "title" | "author" | "added" | "rating";
export type SortOrder = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  order: SortOrder;
}

export interface TagSummary {
  id: number;
  name: string;
  bookCount: number;
}

interface BooksResponse extends CursorPaginatedResult<BookListItem> {}

function appendTagParams(params: URLSearchParams, tagIds: number[]): void {
  for (const id of tagIds) {
    params.append("tag", String(id));
  }
}

async function fetchBooks({
  pageParam,
  sortBy,
  sortOrder,
  tagIds,
  signal,
}: {
  pageParam?: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  tagIds: number[];
  signal?: AbortSignal;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }
  appendTagParams(params, tagIds);

  return fetchJson<BooksResponse>(`${API_BASE}/books?${params}`, { signal });
}

async function searchBooks({
  pageParam,
  query,
  sortBy,
  sortOrder,
  tagIds,
  signal,
}: {
  pageParam?: string;
  query: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  tagIds: number[];
  signal?: AbortSignal;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("q", query);
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  }
  appendTagParams(params, tagIds);

  return fetchJson<BooksResponse>(`${API_BASE}/books/search?${params}`, { signal });
}

// Infinite scroll hook for all books
export function useBooksInfinite(
  sortConfig: SortConfig = { field: "title", order: "asc" },
  tagIds: number[] = [],
) {
  return useInfiniteQuery({
    queryKey: ["books", "infinite", sortConfig.field, sortConfig.order, tagIds],
    queryFn: ({ pageParam, signal }) =>
      fetchBooks({
        pageParam,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
        tagIds,
        signal,
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
export function useSearchInfinite(
  query: string,
  sortConfig: SortConfig = { field: "title", order: "asc" },
  tagIds: number[] = [],
) {
  return useInfiniteQuery({
    queryKey: ["books", "search", "infinite", query, sortConfig.field, sortConfig.order, tagIds],
    queryFn: ({ pageParam, signal }) =>
      searchBooks({
        pageParam,
        query,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
        tagIds,
        signal,
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
export function useFlattenedBooks(
  searchQuery: string,
  sortConfig: SortConfig,
  tagIds: number[] = [],
) {
  const isSearching = searchQuery.trim().length > 0;
  const booksQuery = useBooksInfinite(sortConfig, tagIds);
  const searchQueryHook = useSearchInfinite(searchQuery, sortConfig, tagIds);
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
    queryFn: ({ signal }) =>
      fetchJson<{
        totalBooks: number;
        totalAuthors: number;
        totalSeries: number;
        totalTags: number;
      }>(`${API_BASE}/stats`, { signal }),
    staleTime: 1000 * 60 * 5,
  });
}

// Hook for all tags with counts (tag filter UI)
export function useTags() {
  return useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchJson<TagSummary[]>(`${API_BASE}/tags`, { signal }),
    staleTime: 1000 * 60 * 10,
  });
}

// Hook for single book
export function useBook(id: number) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: ({ signal }) => fetchJson<BookWithDetails>(`${API_BASE}/books/${id}`, { signal }),
    enabled: !Number.isNaN(id) && id > 0,
  });
}
