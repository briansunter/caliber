import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BookListItem, BookWithDetails, CursorPaginatedResult } from "@/lib/calibre-optimized";
import { fetchJson, HttpError } from "@/lib/http";
import { flattenBookWindow, type WindowAnchor } from "@/lib/infinite-window";
import { useCurrentUser } from "@/lib/user";

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

export interface FormatSummary {
  name: string;
  bookCount: number;
}

export interface LibraryConfigStatus {
  libraryId?: string;
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

export function errorStageOf(
  error: unknown,
  hasData: boolean,
  isFetchNext: boolean,
): ErrorStage | null {
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
  formats?: string[];
}): EmptyReason {
  if (args.booksLength > 0 || args.isLoading) return null;
  if (args.error instanceof HttpError && args.error.status === 401) return "auth-expired";
  if (args.error instanceof TypeError) return "offline";
  if (args.error) return null;
  if (
    args.searchQuery.trim().length > 0 ||
    args.tagIds.length > 0 ||
    (args.formats?.length ?? 0) > 0
  )
    return "no-matches";
  return "empty-library";
}

function appendTagParams(params: URLSearchParams, tagIds: number[]): void {
  for (const id of tagIds) {
    params.append("tag", String(id));
  }
}

function appendFormatParams(params: URLSearchParams, formats: string[]): void {
  for (const format of formats) {
    params.append("format", format);
  }
}

function scopeSuffix(scope: InfiniteScope): (string | number)[] {
  return [scope.userId ?? "anon", scope.libraryId ?? "default-lib"];
}

function useLibraryScope(scope: InfiniteScope): InfiniteScope {
  const { user } = useCurrentUser();
  const { data: config } = useLibraryConfig();
  return {
    userId: scope.userId === undefined ? user?.id : scope.userId,
    libraryId: scope.libraryId === undefined ? config?.libraryId : scope.libraryId,
  };
}

async function fetchBooks({
  pageParam,
  sortBy,
  sortOrder,
  tagIds,
  formats,
  signal,
}: {
  pageParam?: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  tagIds: number[];
  formats: string[];
  signal?: AbortSignal;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  } else {
    // S7: request the cheap first-page total; later pages omit it.
    params.set("includeTotal", "1");
  }
  appendTagParams(params, tagIds);
  appendFormatParams(params, formats);

  return fetchJson<BooksResponse>(`${API_BASE}/books?${params}`, { signal });
}

async function searchBooks({
  pageParam,
  query,
  sortBy,
  sortOrder,
  tagIds,
  formats,
  signal,
}: {
  pageParam?: string;
  query: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  tagIds: number[];
  formats: string[];
  signal?: AbortSignal;
}): Promise<BooksResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("q", query);
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  if (pageParam) {
    params.set("cursor", pageParam);
  } else {
    // S7: request the cheap first-page total; later pages omit it.
    params.set("includeTotal", "1");
  }
  appendTagParams(params, tagIds);
  appendFormatParams(params, formats);

  return fetchJson<BooksResponse>(`${API_BASE}/books/search?${params}`, { signal });
}

// Infinite scroll hook for all books
export function useBooksInfinite(
  sortConfig: SortConfig = { field: "title", order: "asc" },
  tagIds: number[] = [],
  enabled = true,
  options: InfiniteWindowOptions = {},
  formats: string[] = [],
) {
  const { maxPages = 50, userId, libraryId } = options;
  return useInfiniteQuery({
    queryKey: [
      "books",
      "infinite",
      sortConfig.field,
      sortConfig.order,
      tagIds,
      formats,
      ...scopeSuffix({ userId, libraryId }),
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchBooks({
        pageParam,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
        tagIds,
        formats,
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
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey.at(-2) === (userId ?? "anon") &&
      previousQuery.queryKey.at(-1) === (libraryId ?? "default-lib")
        ? previousData
        : undefined,
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
  formats: string[] = [],
) {
  const { maxPages = 20, userId, libraryId } = options;
  return useInfiniteQuery({
    queryKey: [
      "books",
      "search",
      "infinite",
      query,
      sortConfig.field,
      sortConfig.order,
      tagIds,
      formats,
      ...scopeSuffix({ userId, libraryId }),
    ],
    queryFn: ({ pageParam, signal }) =>
      searchBooks({
        pageParam,
        query,
        sortBy: sortConfig.field,
        sortOrder: sortConfig.order,
        tagIds,
        formats,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    getPreviousPageParam: (firstPage) => firstPage.prevCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey.at(-2) === (userId ?? "anon") &&
      previousQuery.queryKey.at(-1) === (libraryId ?? "default-lib")
        ? previousData
        : undefined,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    maxPages,
  });
}

// The API supports forward paging only. Preserve the initial page and its
// total under the full query identity, while bounding the retained page window.
export function useFlattenedBooks(
  searchQuery: string,
  sortConfig: SortConfig,
  tagIds: number[] = [],
  options: InfiniteWindowOptions = {},
  formats: string[] = [],
) {
  const scope = useLibraryScope(options);
  const scopedOptions = { ...options, ...scope };
  const normalizedSearch = searchQuery.trim();
  const isSearching = normalizedSearch.length > 0;
  const booksQuery = useBooksInfinite(sortConfig, tagIds, !isSearching, scopedOptions, formats);
  const searchQueryHook = useSearchInfinite(
    normalizedSearch,
    sortConfig,
    tagIds,
    isSearching,
    scopedOptions,
    formats,
  );
  const query = isSearching ? searchQueryHook : booksQuery;
  const keepFirstPageAnchor = options.keepFirstPageAnchor ?? true;

  const activeQueryKey = useMemo(
    () =>
      isSearching
        ? ([
            "books",
            "search",
            "infinite",
            normalizedSearch,
            sortConfig.field,
            sortConfig.order,
            tagIds,
            formats,
            ...scopeSuffix({ userId: scopedOptions.userId, libraryId: scopedOptions.libraryId }),
          ] as const)
        : ([
            "books",
            "infinite",
            sortConfig.field,
            sortConfig.order,
            tagIds,
            formats,
            ...scopeSuffix({ userId: scopedOptions.userId, libraryId: scopedOptions.libraryId }),
          ] as const),
    [
      isSearching,
      normalizedSearch,
      sortConfig.field,
      sortConfig.order,
      tagIds,
      formats,
      scopedOptions.userId,
      scopedOptions.libraryId,
    ],
  );
  const queryIdentityKey = JSON.stringify(activeQueryKey);
  const isPlaceholderData = query.isPlaceholderData ?? false;
  const [anchor, setAnchor] = useState<WindowAnchor<BookListItem> | null>(null);
  const firstPage =
    !isPlaceholderData && query.data?.pageParams[0] === undefined
      ? query.data?.pages[0]
      : undefined;
  useEffect(() => {
    if (firstPage) setAnchor({ identity: queryIdentityKey, page: firstPage });
  }, [firstPage, queryIdentityKey]);

  const { books, totalCount, windowTruncated } = useMemo(
    () =>
      flattenBookWindow(
        query.data?.pages,
        query.data?.pageParams,
        queryIdentityKey,
        // Placeholder data belongs to the previous query and cannot be anchored.
        isPlaceholderData ? null : anchor,
        keepFirstPageAnchor,
      ),
    [query.data, queryIdentityKey, isPlaceholderData, anchor, keepFirstPageAnchor],
  );
  const retainedCount = books.length;
  const maxPages = isSearching ? (options.maxPages ?? 20) : (options.maxPages ?? 50);

  // FUP8: backward fetch is NOT supported (forward-only server). No-op until
  // the server emits prevCursor — never claim it fetches.
  const fetchPreviousPageNoop = useCallback(
    async () => undefined as unknown as Awaited<ReturnType<typeof query.fetchPreviousPage>>,
    [],
  );

  const hasData = retainedCount > 0;
  const errorStage = errorStageOf(
    query.error,
    hasData,
    query.isFetchingNextPage || query.isFetchNextPageError,
  );
  const isPlaceholder = isPlaceholderData;
  const emptyReason = emptyReasonOf({
    booksLength: retainedCount,
    isLoading: query.isLoading,
    error: query.error,
    searchQuery,
    tagIds,
    formats,
  });
  const isAuthExpired = query.error instanceof HttpError && query.error.status === 401;
  const isOffline = !query.isLoading && !hasData && query.error instanceof TypeError;

  return {
    books,
    totalCount,
    retainedCount,
    windowTruncated,
    maxPages,
    keepFirstPageAnchor,
    queryKey: activeQueryKey,
    hasNextPage: query.hasNextPage ?? false,
    // Backward paging unsupported: always false until server prevCursor lands.
    hasPreviousPage: false as boolean,
    fetchNextPage: query.fetchNextPage,
    fetchPreviousPage: fetchPreviousPageNoop,
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
  const effectiveScope = useLibraryScope(scope);
  return useQuery({
    queryKey: ["stats", ...scopeSuffix(effectiveScope)],
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
  const effectiveScope = useLibraryScope(scope);
  return useQuery({
    queryKey: ["tags", ...scopeSuffix(effectiveScope)],
    queryFn: ({ signal }) => fetchJson<TagSummary[]>(`${API_BASE}/tags`, { signal }),
    enabled,
    staleTime: 1000 * 60 * 10,
  });
}

// Hook for all formats with counts (format filter UI)
export function useFormats(enabled = true, scope: InfiniteScope = {}) {
  const effectiveScope = useLibraryScope(scope);
  return useQuery({
    queryKey: ["formats", ...scopeSuffix(effectiveScope)],
    queryFn: ({ signal }) => fetchJson<FormatSummary[]>(`${API_BASE}/formats`, { signal }),
    enabled,
    staleTime: 1000 * 60 * 10,
  });
}

export function useLibraryConfig() {
  const { user } = useCurrentUser();
  return useQuery({
    queryKey: ["library-config", user?.id ?? "anon"],
    queryFn: ({ signal }) =>
      fetchJson<LibraryConfigStatus>(`${API_BASE}/config/library`, { signal }),
    retry: false,
    staleTime: 0,
  });
}

// Hook for single book
export function useBook(id: number, scope: InfiniteScope = {}) {
  const effectiveScope = useLibraryScope(scope);
  return useQuery({
    queryKey: ["book", id, ...scopeSuffix(effectiveScope)],
    queryFn: ({ signal }) => fetchJson<BookWithDetails>(`${API_BASE}/books/${id}`, { signal }),
    enabled: Number.isSafeInteger(id) && id > 0,
  });
}
