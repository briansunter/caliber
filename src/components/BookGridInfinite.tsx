import { memo, useEffect, useCallback, useRef } from "react";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useFlattenedBooks, type SortConfig } from "@/hooks/useBooksInfinite";
import type { BookListItem } from "@/lib/calibre-optimized";
import { Link } from "@tanstack/react-router";
import { BookOpen, Search, Loader2, Star } from "lucide-react";
import { isUnknownAuthor } from "@/lib/utils";
import { BookCoverImage } from "./BookCoverImage";
import { useBookListLayout, useBookScrollRestoration } from "@/hooks/useBookListViewport";
import {
  bookGridLayout,
  BOOK_GRID_COLUMN_GAP,
  BOOK_GRID_ROW_GAP,
  BOOK_GRID_METADATA_HEIGHT,
} from "@/lib/book-list-layout";

interface BookGridInfiniteProps {
  searchQuery: string;
  sortConfig: SortConfig;
  tagIds?: number[];
  formats?: string[];
  onClearFilters?: () => void;
  stickyOffset?: number;
  libraryId?: string;
}

const GridCard = memo(function GridCard({
  book,
  libraryId,
}: {
  book: BookListItem;
  libraryId?: string;
}) {
  const unknown = isUnknownAuthor(book.authors);
  const formats = book.formats?.map((format) => format.toUpperCase()) ?? [];
  const format = formats.includes("EPUB") ? "EPUB" : formats.includes("PDF") ? "PDF" : formats[0];
  const rating = book.rating ? Math.min(5, Math.max(0, book.rating / 2)) : null;
  return (
    <Link
      to="/book/$id"
      params={{ id: String(book.id) }}
      aria-label={`${book.title}${unknown ? "" : ` by ${book.authors?.join(", ")}`}`}
      className="group flex min-w-0 flex-col rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-4 focus-visible:ring-offset-parchment"
    >
      <div className="relative aspect-[2/3] w-full shrink-0 overflow-hidden rounded-lg bg-parchment-dark shadow-[0_4px_12px_-3px_rgba(35,45,35,0.20)] ring-1 ring-ink/10 transition-[box-shadow,transform] duration-200 group-hover:-translate-y-1 group-hover:shadow-[0_10px_20px_-6px_rgba(35,45,35,0.25)]">
        <BookCoverImage
          bookId={book.id}
          authKey={libraryId}
          title={book.title}
          hasCover={book.has_cover}
          width={240}
          height={360}
          className="transition-[filter] duration-200 group-hover:brightness-[1.04]"
        />
      </div>
      <div className="flex shrink-0 flex-col pt-3" style={{ height: BOOK_GRID_METADATA_HEIGHT }}>
        <span
          title={book.title}
          className="line-clamp-2 text-sm font-semibold leading-5 text-ink transition-colors group-hover:text-accent"
        >
          {book.title}
        </span>
        <span className="mt-1 truncate text-xs leading-4 text-ink-tertiary">
          {unknown ? "Unknown author" : book.authors?.join(", ")}
        </span>
        <div className="mt-2 flex min-h-5 items-center gap-2">
          {format && (
            <span className="rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              {format}
            </span>
          )}
          {rating !== null && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-tertiary"
              role="img"
              aria-label={`${rating} out of 5 stars`}
            >
              <Star className="h-3 w-3 fill-accent text-accent" aria-hidden="true" />
              {rating.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
});

export const BookGridInfinite = memo(function BookGridInfinite({
  searchQuery,
  sortConfig,
  tagIds,
  formats,
  onClearFilters,
  stickyOffset = 0,
  libraryId,
}: BookGridInfiniteProps) {
  const {
    books,
    totalCount,
    retainedCount,
    windowTruncated,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
    isError,
    error,
    errorStage,
    isPlaceholder,
    emptyReason,
    isAuthExpired,
    isOffline,
    refetch,
    queryKey,
  } = useFlattenedBooks(searchQuery, sortConfig, tagIds, { libraryId }, formats);
  const { width, scrollMargin, measured, setElement } = useBookListLayout();
  const { columns, rowHeight } = bookGridLayout(width);
  const rowCount = Math.ceil(books.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 5,
    scrollMargin,
    scrollPaddingStart: stickyOffset,
    // React 19 warns when the adapter flushes a virtualizer rerender while a
    // route transition is still rendering. Normal scheduling is sufficient
    // here and keeps grid view free of render-phase updates.
    useFlushSync: false,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    if (rowHeight > 0) virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const isRestoring = useBookScrollRestoration({
    identity: JSON.stringify([queryKey, "grid"]),
    books,
    columns,
    rowHeight,
    scrollMargin,
    stickyOffset,
    ready: measured && books.length > 0 && !isLoading && !isPlaceholder,
    hasNextPage,
    fetchNextPage,
    virtualizer,
  });

  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const shouldFetch = Boolean(
    lastVirtualItem &&
      lastVirtualItem.index >= rowCount - 5 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError &&
      !isPlaceholder &&
      !isRestoring,
  );
  const fetchRef = useRef(fetchNextPage);
  fetchRef.current = fetchNextPage;
  useEffect(() => {
    if (shouldFetch) void fetchRef.current({ cancelRefetch: false }).catch(() => {});
  }, [shouldFetch]);

  if (isLoading) {
    return (
      <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns * 2 }, (_, i) => `skeleton-${i}`).map((key, i) => (
          <div
            key={key}
            className="aspect-[2/3] bg-parchment-dark/70 rounded-lg animate-pulse"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    );
  }

  if (isError && errorStage === "initial") {
    const title = isAuthExpired
      ? "Session expired"
      : isOffline
        ? "You're offline"
        : "Failed to load books";
    const hint = isAuthExpired
      ? "Please sign in again to continue browsing."
      : isOffline
        ? "Check your connection and try again."
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-8">
        <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-3">
          <BookOpen className="h-5 w-5 text-error" strokeWidth={1.5} />
        </div>
        <h3 className="text-base font-semibold text-ink mb-1">{title}</h3>
        <p className="text-sm text-ink-tertiary">{hint}</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="mt-3 rounded-lg border border-ink px-3 py-1.5 text-sm font-medium text-ink hover:bg-parchment-dark"
        >
          Try again
        </button>
      </div>
    );
  }

  // Refresh failure with retained data: keep the list, show an inline banner.
  const refreshBanner =
    isError && errorStage === "refresh" ? (
      <div
        className="mx-4 mt-3 rounded-lg border border-ink px-3 py-2 text-sm text-ink-tertiary flex items-center justify-between gap-2"
        role="alert"
      >
        <span>Couldn't refresh — showing saved results.</span>
        <button type="button" onClick={() => refetch()} className="underline font-medium">
          Retry
        </button>
      </div>
    ) : null;

  if (books.length === 0 && !isPlaceholder) {
    const heading =
      emptyReason === "empty-library"
        ? "Your library is empty"
        : emptyReason === "offline"
          ? "You're offline"
          : emptyReason === "auth-expired"
            ? "Session expired"
            : "No books found";
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-8">
        <div className="w-14 h-14 rounded-full bg-parchment-dark flex items-center justify-center mb-3 border border-ink">
          <Search className="h-5 w-5 text-ink-muted" strokeWidth={1.5} />
        </div>
        <h3 className="text-base font-semibold text-ink mb-1">{heading}</h3>
        <p className="text-sm text-ink-tertiary">
          {searchQuery
            ? `No books match "${searchQuery}". Try a different search term.`
            : emptyReason === "empty-library"
              ? "Your library is empty. Add some books to get started."
              : emptyReason === "offline"
                ? "Check your connection and try again."
                : emptyReason === "auth-expired"
                  ? "Please sign in again to continue browsing."
                  : "No books match the current filters."}
        </p>
        {(searchQuery !== "" || (tagIds?.length ?? 0) > 0 || (formats?.length ?? 0) > 0) &&
          onClearFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              aria-label="Clear search and filters"
              className="mt-3 rounded-lg border border-ink px-3 py-1.5 text-sm font-medium text-ink hover:bg-parchment-dark transition-colors"
            >
              Clear search and filters
            </button>
          )}
      </div>
    );
  }

  const footerCount =
    totalCount !== null && windowTruncated
      ? `Showing ${retainedCount.toLocaleString()} of ${totalCount.toLocaleString()} (retained window)`
      : `${books.length.toLocaleString()} book${books.length !== 1 ? "s" : ""}`;
  // Forward-only window: once maxPages evicts leading pages there is NO
  // backward fetch, so a truncated window with an exhausted forward cursor
  // must NOT claim "All books loaded" — the earlier books are simply outside
  // the retained window.
  const endStatus =
    windowTruncated && !hasNextPage
      ? "Earlier books unavailable — use search/filters"
      : hasNextPage
        ? "Scroll to load more"
        : "All books loaded";

  return (
    <div>
      {refreshBanner}
      {/* List-origin container: sits in normal flow at the measured origin;
          rows below offset by (start - scrollMargin) so the margin applies
          exactly once. */}
      <div ref={setElement} style={{ height: `${totalSize}px`, position: "relative" }}>
        {virtualItems.map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowBooks = books.slice(startIndex, startIndex + columns);

          return (
            <div
              key={rowBooks[0]?.id ?? virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                height: `${rowHeight - BOOK_GRID_ROW_GAP}px`,
              }}
            >
              <div
                className="grid h-full"
                style={{
                  gridTemplateColumns: `repeat(${columns}, 1fr)`,
                  gap: `${BOOK_GRID_COLUMN_GAP}px`,
                }}
              >
                {rowBooks.map((book) => (
                  <GridCard key={book.id} book={book} libraryId={libraryId} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {isFetchingNextPage && (
        <div
          className="flex items-center justify-center py-4 border-t border-parchment"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            <span className="text-sm">Loading more…</span>
          </div>
        </div>
      )}

      {isFetchNextPageError && !isFetchingNextPage && (
        <div
          className="flex items-center justify-center gap-2 py-3 border-t border-parchment text-sm text-ink-tertiary"
          role="alert"
        >
          <span>Couldn't load more books.</span>
          <button type="button" onClick={() => fetchNextPage()} className="underline font-medium">
            Retry
          </button>
        </div>
      )}

      <div className="px-3 sm:px-4 py-3 border-t border-ink bg-parchment-dark flex items-center justify-between gap-2 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-4 w-4 text-accent flex-shrink-0" strokeWidth={2} />
          <span className="text-sm font-medium text-ink whitespace-nowrap">{footerCount}</span>
          <span className="text-sm text-ink-muted truncate">
            {searchQuery ? `matching "${searchQuery}"` : "loaded"}
          </span>
        </div>
        <div className="text-xs text-ink-muted whitespace-nowrap hidden sm:block">{endStatus}</div>
      </div>
    </div>
  );
});
