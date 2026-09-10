import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
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

export interface FormatSummary {
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
  if (args.booksLength > 0 || args.isLoading || args.error) return null;
  if (args.error instanceof HttpError && args.error.status === 401) return "auth-expired";
  if (args.error instanceof TypeError) return "offline";
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
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    maxPages,
  });
}

// Shared hook: flattens pages and exposes fetch controls.
//
// Forward-only contract (documented, do NOT claim otherwise):
// - The server is forward-only: it emits only nextCursor, never prevCursor.
//   There is NO server backward fetch, so fetchPreviousPage is a no-op that
//   returns undefined until the server adds prevCursor support. The retained
//   window is therefore NEVER continuous once maxPages evicts leading pages:
//   footers must say "retained window" / "earlier books unavailable" and must
//   never claim "all books loaded" while windowTruncated, even when the
//   forward cursor is exhausted.
// - The client keeps all loaded pages in the TanStack cache up to maxPages
//   (no manual eviction besides TanStack's maxPages window). windowTruncated
//   is derived from cached data length vs totalCount once the window is full.
// - keepFirstPageAnchor retains the first page's items keyed by query
//   identity and prepends them ONLY when eviction is proven
//   (window full while retained < total when total is present; window full
//   alone when later pages omit total). Otherwise rawBooks are
//   returned untouched, so a search/sort/tag/user/library change can never
//   inherit a stale anchor from a previous query. keepPreviousData
//   placeholder pages are never captured as the anchor.
// - S7 totals are first-page-only: later pages omit `total`, so the
//   first-page total is preserved in totalForIdentityRef alongside the anchor
//   items and survives eviction of the first page from the window.
export function useFlattenedBooks(
  searchQuery: string,
  sortConfig: SortConfig,
  tagIds: number[] = [],
  options: InfiniteWindowOptions = {},
  formats: string[] = [],
) {
  const isSearching = searchQuery.trim().length > 0;
  const booksQuery = useBooksInfinite(sortConfig, tagIds, !isSearching, options, formats);
  const searchQueryHook = useSearchInfinite(
    searchQuery,
    sortConfig,
    tagIds,
    isSearching,
    options,
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
            searchQuery,
            sortConfig.field,
            sortConfig.order,
            tagIds,
            formats,
            ...scopeSuffix({ userId: options.userId, libraryId: options.libraryId }),
          ] as const)
        : ([
            "books",
            "infinite",
            sortConfig.field,
            sortConfig.order,
            tagIds,
            formats,
            ...scopeSuffix({ userId: options.userId, libraryId: options.libraryId }),
          ] as const),
    [
      isSearching,
      searchQuery,
      sortConfig.field,
      sortConfig.order,
      tagIds,
      formats,
      options.userId,
      options.libraryId,
    ],
  );
  // R6: bind the anchor to the query identity. Key covers the full
  // activeQueryKey (search text + sort + tags + formats + user + library).
  const queryIdentityKey = JSON.stringify(activeQueryKey);

  // R6: retain the first page keyed by query identity so maxPages eviction
  // never loses the top anchor — and a query change never inherits a stale
  // anchor. Stored in a ref (not state) to avoid extra renders; reset when
  // the identity key changes. The first-page `total` rides alongside the
  // anchor items (totalForIdentity) so "Showing X of Y" survives eviction of
  // the first page itself.
  // S7: keepPreviousData placeholder pages are NEVER captured — while
  // isPlaceholderData is true, query.data still holds the PREVIOUS query's
  // first page, which must not be anchored under the new identity key.
  const isPlaceholderData = query.isPlaceholderData ?? false;
  const firstPageDataRef = useRef<{
    key: string;
    items: BookListItem[];
    total: number | null;
  } | null>(null);
  const firstPageSeen = !isPlaceholderData ? query.data?.pages[0]?.items : undefined;
  const firstPageTotalSeen = !isPlaceholderData ? query.data?.pages[0]?.total : undefined;
  useEffect(() => {
    if (!isPlaceholderData && firstPageSeen && firstPageSeen.length > 0) {
      if (!firstPageDataRef.current || firstPageDataRef.current.key !== queryIdentityKey) {
        firstPageDataRef.current = {
          key: queryIdentityKey,
          items: firstPageSeen,
          total: typeof firstPageTotalSeen === "number" ? firstPageTotalSeen : null,
        };
      } else if (
        firstPageDataRef.current.total === null &&
        typeof firstPageTotalSeen === "number"
      ) {
        // Backfill: the anchor was captured on a render where the first
        // page had no total yet; adopt it now while the identity matches.
        firstPageDataRef.current.total = firstPageTotalSeen;
      }
    }
  }, [firstPageSeen, firstPageTotalSeen, queryIdentityKey, isPlaceholderData]);

  const rawBooks = useMemo(() => {
    return query.data?.pages.flatMap((page) => page.items) ?? [];
  }, [query.data]);

  const maxPagesForAnchor = isSearching ? (options.maxPages ?? 20) : (options.maxPages ?? 50);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pages.length is the eviction signal; rawBooks identity alone does not change when maxPages drops leading pages.
  const books = useMemo(() => {
    // R6: prepend the anchor ONLY when it belongs to the current query
    // identity AND eviction is proven. The effective total prefers the live
    // window, then falls back to the preserved first-page total
    // (totalForIdentity) once the first page is evicted. When no total is
    // known at all, the full window (pages.length >= maxPages) alone proves
    // eviction. Otherwise return rawBooks untouched — forward-only, no
    // backward fetch.
    if (!keepFirstPageAnchor) return rawBooks;
    const stored = firstPageDataRef.current;
    if (!stored || stored.key !== queryIdentityKey) return rawBooks;
    const anchor = stored.items;
    if (anchor.length === 0 || rawBooks.length === 0) return rawBooks;
    const pagesLength = query.data?.pages.length ?? 0;
    const total = (() => {
      const pages = query.data?.pages;
      if (pages) {
        for (const p of pages) {
          if (typeof p.total === "number") return p.total;
        }
      }
      return stored.key === queryIdentityKey ? stored.total : null;
    })();
    const windowFull = pagesLength >= maxPagesForAnchor;
    const evictionProven = windowFull && (total === null || rawBooks.length < total);
    if (!evictionProven) return rawBooks;
    if (rawBooks[0]?.id === anchor[0]?.id) return rawBooks;
    const seen = new Set(rawBooks.map((b) => b.id));
    const missing = anchor.filter((b) => !seen.has(b.id));
    if (missing.length === 0) return rawBooks;
    return [...missing, ...rawBooks];
  }, [rawBooks, keepFirstPageAnchor, queryIdentityKey, query.data?.pages.length]);

  const totalCount = useMemo(() => {
    const pages = query.data?.pages;
    if (pages && pages.length > 0) {
      for (const page of pages) {
        if (typeof page.total === "number") return page.total;
      }
    }
    // Evicted window: fall back to the preserved first-page total for this
    // query identity so the footer keeps "Showing X of Y (retained window)".
    const stored = firstPageDataRef.current;
    if (stored && stored.key === queryIdentityKey && typeof stored.total === "number") {
      return stored.total;
    }
    return null;
  }, [query.data, queryIdentityKey]);

  const retainedCount = books.length;
  const maxPages = maxPagesForAnchor;
  // FUP8: windowTruncated reflects maxPages eviction. S7: when total is
  // present (first page), the window is truncated while retained < total;
  // when total is absent (later pages omit it), the full window
  // (pages.length >= maxPages) alone signals truncation.
  const pagesLength = query.data?.pages.length ?? 0;
  const windowTruncated =
    pagesLength >= maxPages && (totalCount === null || retainedCount < totalCount);

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

// Hook for all formats with counts (format filter UI)
export function useFormats(enabled = true, scope: InfiniteScope = {}) {
  return useQuery({
    queryKey: ["formats", ...scopeSuffix(scope)],
    queryFn: ({ signal }) => fetchJson<FormatSummary[]>(`${API_BASE}/formats`, { signal }),
    enabled,
    staleTime: 1000 * 60 * 10,
  });
}

export function useLibraryConfig() {
  return useQuery({
    queryKey: ["library-config"],
    queryFn: ({ signal }) =>
      fetchJson<LibraryConfigStatus>(`${API_BASE}/config/library`, { signal }),
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
