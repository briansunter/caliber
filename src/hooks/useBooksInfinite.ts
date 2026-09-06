import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BookListItem, BookWithDetails, CursorPaginatedResult } from "@/lib/calibre-optimized";
import { fetchJson, HttpError } from "@/lib/http";

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

export interface LibraryConfigStatus {
  libraryPath: string;
  dbName: string;
  databasePath: string;
  configuredDatabasePath: string;
  defaultDatabasePath: string;
  databaseExists: boolean;
  configuredDatabaseExists: boolean;
  environmentOverride: boolean;
  configFilePath: string;
  ready: boolean;
}

interface BooksResponse extends CursorPaginatedResult<BookListItem> {
  // Forward-compatible: the server currently only emits nextCursor.
  // When it starts emitting prevCursor we pick it up for backward paging.
  prevCursor?: string | null;
}

export interface InfiniteScope {
  userId?: number | string | null;
  libraryId?: string | null;
}

export interface InfiniteWindowOptions extends InfiniteScope {
  maxPages?: number;
  // Keep the first page anchored while maxPages evicts later pages, so
  // "back to top" and anchor restore always have a stable window.
  keepFirstPageAnchor?: boolean;
}

export type ErrorStage = "initial" | "refresh" | "next-page";
export type EmptyReason = "empty-library" | "no-matches" | "offline" | "auth-expired" | null;

export function errorStageOf(error: unknown, hasData: boolean, isFetchNext: boolean): ErrorStage | null {
  if (!error) return null;
  if (isFetchNext && hasData) return "next-page";
  if (hasData) return "refresh";
  return "initial";
}

export function emptyReasonOf(args: {
  booksLength: number;
  isLoading: boolean;
  error: unknown;
  searchQuery: string;
  tagIds: number[];
}): EmptyReason {
  if (args.booksLength > 0 || args.isLoading || args.error) return null;
  if (args.error instanceof HttpError && args.error.status === 401) return "auth-expired";
  if (args.error instanceof TypeError) return "offline";
  if (args.searchQuery.trim().length > 0 || args.tagIds.length > 0) return "no-matches";
  return "empty-library";
}

function appendTagParams(params: URLSearchParams, tagIds: number[]): void {
  for (const id of tagIds) {
    params.append("tag", String(id));
  }
}

function scopeSuffix(scope: InfiniteScope): (string | number)[] {
  return [scope.userId ?? "anon", scope.libraryId ?? "default-lib"];
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
  enabled = true,
  options: InfiniteWindowOptions = {},
) {
  const { maxPages = 50, userId, libraryId } = options;
  return useInfiniteQuery({
    queryKey: ["books", "infinite", sortConfig.field, sortConfig.order, tagIds, ...scopeSuffix({ userId, libraryId })],
    queryFn: ({ pageParam, signal }) =>
      fetchBooks({
        pageParam,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
        tagIds,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Explicit backward-pagination support: the current API is forward-only,
    // so this returns undefined (first-page anchor fallback) until the server
    // emits prevCursor. Wired so bidirectional window restore works without
    // further client changes once the backend supports it.
    getPreviousPageParam: (firstPage) => firstPage.prevCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    maxPages,
  });
}

// Infinite scroll hook for search
export function useSearchInfinite(
  query: string,
  sortConfig: SortConfig = { field: "title", order: "asc" },
  tagIds: number[] = [],
  enabled = query.trim().length > 0,
  options: InfiniteWindowOptions = {},
) {
  const { maxPages = 20, userId, libraryId } = options;
  return useInfiniteQuery({
    queryKey: ["books", "search", "infinite", query, sortConfig.field, sortConfig.order, tagIds, ...scopeSuffix({ userId, libraryId })],
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
    getPreviousPageParam: (firstPage) => firstPage.prevCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    maxPages,
  });
}

// Shared hook: flattens pages and exposes fetch controls
export function useFlattenedBooks(
  searchQuery: string,
  sortConfig: SortConfig,
  tagIds: number[] = [],
  options: InfiniteWindowOptions = {},
) {
  const isSearching = searchQuery.trim().length > 0;
  const booksQuery = useBooksInfinite(sortConfig, tagIds, !isSearching, options);
  const searchQueryHook = useSearchInfinite(searchQuery, sortConfig, tagIds, isSearching, options);
  const query = isSearching ? searchQueryHook : booksQuery;

  const books = useMemo(() => {
    return query.data?.pages.flatMap((page) => page.items) ?? [];
  }, [query.data]);

  const totalCount = useMemo(() => {
    const pages = query.data?.pages;
    if (!pages || pages.length === 0) return null;
    for (const page of pages) {
      if (typeof page.total === "number") return page.total;
    }
    return null;
  }, [query.data]);

  const retainedCount = books.length;
  const maxPages = isSearching ? (options.maxPages ?? 20) : (options.maxPages ?? 50);
  const windowTruncated =
    totalCount !== null && retainedCount < totalCount && (query.data?.pages.length ?? 0) >= maxPages;

  const hasData = retainedCount > 0;
  const errorStage = errorStageOf(query.error, hasData, query.isFetchingNextPage || query.isFetchNextPageError);
  const isPlaceholder = query.isPlaceholderData ?? false;
  const emptyReason = emptyReasonOf({
    booksLength: retainedCount,
    isLoading: query.isLoading,
    error: query.error,
    searchQuery,
    tagIds,
  });
  const isAuthExpired =
    query.error instanceof HttpError && query.error.status === 401;
  const isOffline =
    !query.isLoading && !hasData && query.error instanceof TypeError;

  return {
    books,
    totalCount,
    retainedCount,
    windowTruncated,
    maxPages,
    keepFirstPageAnchor: options.keepFirstPageAnchor ?? true,
    hasNextPage: query.hasNextPage ?? false,
    hasPreviousPage: query.hasPreviousPage ?? false,
    fetchNextPage: query.fetchNextPage,
    fetchPreviousPage: query.fetchPreviousPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchingPreviousPage: query.isFetchingPreviousPage,
    isFetchNextPageError: query.isFetchNextPageError,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    errorStage,
    isPlaceholder,
    emptyReason,
    isAuthExpired,
    isOffline,
    refetch: query.refetch,
  };
}

// Hook for library stats
export function useLibraryStats(enabled = true, scope: InfiniteScope = {}) {
  return useQuery({
    queryKey: ["stats", ...scopeSuffix(scope)],
    queryFn: ({ signal }) =>
      fetchJson<{
        totalBooks: number;
        totalAuthors: number;
        totalSeries: number;
        totalTags: number;
    }>(`${API_BASE}/stats`, { signal }),
    enabled,
    staleTime: 1000 * 60 * 5,
  });
}

// Hook for all tags with counts (tag filter UI)
export function useTags(enabled = true, scope: InfiniteScope = {}) {
  return useQuery({
    queryKey: ["tags", ...scopeSuffix(scope)],
    queryFn: ({ signal }) => fetchJson<TagSummary[]>(`${API_BASE}/tags`, { signal }),
    enabled,
    staleTime: 1000 * 60 * 10,
  });
}

export function useLibraryConfig() {
  return useQuery({
    queryKey: ["library-config"],
    queryFn: ({ signal }) => fetchJson<LibraryConfigStatus>(`${API_BASE}/config/library`, { signal }),
    retry: false,
    staleTime: 0,
  });
}

// Hook for single book
export function useBook(id: number, scope: InfiniteScope = {}) {
  return useQuery({
    queryKey: ["book", id, ...scopeSuffix(scope)],
    queryFn: ({ signal }) => fetchJson<BookWithDetails>(`${API_BASE}/books/${id}`, { signal }),
    enabled: !Number.isNaN(id) && id > 0,
  });
}
