import { memo, useEffect, useCallback, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useFlattenedBooks, type SortConfig, type SortField } from "@/hooks/useBooksInfinite";
import type { BookListItem } from "@/lib/calibre-optimized";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Star,
  Search,
  Loader2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
} from "lucide-react";
import { isUnknownAuthor } from "@/lib/utils";
import { BookCoverImage } from "./BookCoverImage";
import { useBookListLayout, useBookScrollRestoration } from "@/hooks/useBookListViewport";

interface BookTableInfiniteProps {
  searchQuery: string;
  sortConfig: SortConfig;
  tagIds?: number[];
  formats?: string[];
  onClearFilters?: () => void;
  stickyOffset?: number;
  rowHeight?: number;
  libraryId?: string;
}

// All flexible tracks use minmax(0, Nfr) so the grid can never exceed the
// viewport (an fr track's implicit min is auto = content width, which made
// long titles/authors force horizontal scroll on phones and iPads).
// Columns appear progressively: sm = title/author/rating, lg adds
// series/formats, xl adds tags.
const GRID_COLS_MOBILE = "grid-cols-[minmax(0,1fr)_minmax(0,35%)_40px]";
const GRID_COLS_DESKTOP =
  "sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_90px_48px] " +
  "lg:grid-cols-[minmax(0,3fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_90px_minmax(0,1fr)_48px] " +
  "xl:grid-cols-[minmax(0,3fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_90px_minmax(0,1fr)_60px]";

const ROW_HEIGHT = 72;
const SKELETON_ROW_KEYS = [
  "skeleton-1",
  "skeleton-2",
  "skeleton-3",
  "skeleton-4",
  "skeleton-5",
  "skeleton-6",
  "skeleton-7",
  "skeleton-8",
] as const;

// Star rating component
const StarRating = memo(function StarRating({ rating }: { rating?: number | null }) {
  if (!rating) return <span className="text-ink-muted">—</span>;

  const stars = [];
  const fullStars = Math.floor(rating / 2);
  const hasHalfStar = rating % 2 >= 1;

  for (let i = 0; i < 5; i++) {
    if (i < fullStars) {
      stars.push(<Star key={i} className="h-3.5 w-3.5 fill-accent text-accent" />);
    } else if (i === fullStars && hasHalfStar) {
      stars.push(
        <div key={i} className="relative">
          <Star className="h-3.5 w-3.5 text-ink" strokeWidth={1} />
          <div className="absolute inset-0 overflow-hidden w-1/2">
            <Star className="h-3.5 w-3.5 fill-accent text-accent" />
          </div>
        </div>,
      );
    } else {
      stars.push(<Star key={i} className="h-3.5 w-3.5 text-ink" strokeWidth={1} />);
    }
  }

  return (
    <div className="flex items-center gap-0.5" role="img" aria-label={`${rating} out of 10`}>
      <span aria-hidden="true" className="flex items-center gap-0.5">
        {stars}
      </span>
    </div>
  );
});

// Cell components
const TitleCell = memo(function TitleCell({
  title,
  id,
  hasCover,
  libraryId,
}: {
  title: string;
  id: number;
  hasCover?: boolean;
  libraryId?: string;
}) {
  return (
    <Link
      to="/book/$id"
      params={{ id: String(id) }}
      aria-label={title}
      className="group flex items-center gap-3 min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="relative flex-shrink-0 w-9 h-12 rounded bg-parchment-dark overflow-hidden flex items-center justify-center border border-ink">
        <BookCoverImage
          bookId={id}
          authKey={libraryId}
          title={title}
          hasCover={Boolean(hasCover)}
          size="sm"
          width={36}
          height={48}
        />
      </div>
      <span
        title={title}
        className="font-medium text-ink group-hover:text-accent transition-colors line-clamp-2"
      >
        {title}
      </span>
    </Link>
  );
});

const AuthorsCell = memo(function AuthorsCell({ authors }: { authors?: string[] }) {
  if (isUnknownAuthor(authors)) {
    return <span className="text-ink-muted">—</span>;
  }
  return <span className="text-ink-tertiary truncate">{authors?.join(", ")}</span>;
});

const SeriesCell = memo(function SeriesCell({
  series,
  seriesIndex,
}: {
  series?: string | null;
  seriesIndex?: number;
}) {
  if (!series) return <span className="text-ink-muted">—</span>;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-ink-tertiary truncate">{series}</span>
      <span className="text-xs text-ink-muted">Book {seriesIndex ?? 1}</span>
    </div>
  );
});

const TagsCell = memo(function TagsCell({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return <span className="text-ink-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.slice(0, 2).map((tag) => (
        <span key={tag} className="badge">
          {tag}
        </span>
      ))}
      {tags.length > 2 && <span className="text-xs text-ink-muted">+{tags.length - 2}</span>}
    </div>
  );
});

const FormatsCell = memo(function FormatsCell({
  formats,
  bookId,
}: {
  formats?: string[];
  bookId: number;
}) {
  if (!formats || formats.length === 0) return <span className="text-ink-muted">—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {formats.slice(0, 3).map((fmt) => (
        <a
          key={fmt}
          href={`/api/books/${bookId}/download/${encodeURIComponent(fmt)}`}
          download
          className="format-tag"
          title={`Download ${fmt}`}
        >
          {fmt}
        </a>
      ))}
      {formats.length > 3 && <span className="text-xs text-ink-muted">+{formats.length - 3}</span>}
    </div>
  );
});

const ActionsCell = memo(function ActionsCell({ id }: { id: number }) {
  return (
    <Link
      to="/book/$id"
      params={{ id: String(id) }}
      aria-label="View book details"
      className="p-2 rounded-md hover:bg-parchment-dark text-ink-muted hover:text-ink transition-colors inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
    </Link>
  );
});

// Preferred "read" format for the mobile compact badge: EPUB first, then
// PDF, otherwise the first available format (uppercased for display).
function preferredReadFormat(formats: string[]): string {
  const upper = formats.map((f) => f.toUpperCase());
  if (upper.includes("EPUB")) return "EPUB";
  if (upper.includes("PDF")) return "PDF";
  return upper[0] ?? "";
}

// Virtual row component - rendered as a normal row in the flow
interface TableRowProps {
  book: BookListItem;
  rowHeight: number;
  libraryId?: string;
}

const TableRow = memo(function TableRow({ book, rowHeight, libraryId }: TableRowProps) {
  const compact = rowHeight < ROW_HEIGHT;
  return (
    <div
      className="flex items-center px-3 sm:px-4 border-b border-parchment hover:bg-parchment-dark focus-within:bg-parchment-dark transition-colors"
      style={{ height: `${rowHeight}px` }}
    >
      {/* Mobile layout */}
      <div className={`w-full h-full items-center gap-2 grid sm:!hidden ${GRID_COLS_MOBILE}`}>
        <div className={`flex items-center min-w-0 ${compact ? "py-1" : "py-2"} overflow-hidden`}>
          <TitleCell
            title={book.title}
            id={book.id}
            hasCover={book.has_cover}
            libraryId={libraryId}
          />
        </div>
        <div className={`flex items-center min-w-0 ${compact ? "py-1" : "py-2"} overflow-hidden`}>
          <div className="flex min-w-0 flex-col justify-center gap-0.5">
            <span className="text-xs text-ink-tertiary truncate">
              {isUnknownAuthor(book.authors) ? "—" : book.authors?.[0]}
            </span>
            {(book.rating != null || (book.formats && book.formats.length > 0)) && (
              <span className="flex items-center gap-1.5">
                {book.rating != null && book.rating > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-ink-secondary"
                    role="img"
                    aria-label={`Rated ${book.rating} out of 10`}
                  >
                    <Star className="h-3 w-3 fill-accent text-accent" aria-hidden="true" />
                    {Number.isInteger(book.rating / 2)
                      ? String(book.rating / 2)
                      : (book.rating / 2).toFixed(1)}
                  </span>
                )}
                {book.formats && book.formats.length > 0 && (
                  <span
                    title={`Available as ${preferredReadFormat(book.formats)}`}
                    className="rounded border border-ink bg-parchment-dark px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-secondary"
                  >
                    {preferredReadFormat(book.formats)}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className={`flex items-center justify-end ${compact ? "py-1" : "py-2"}`}>
          <ActionsCell id={book.id} />
        </div>
      </div>
      {/* Tablet/desktop layout */}
      <div
        className={`w-full h-full items-center gap-2 lg:gap-4 hidden sm:!grid ${GRID_COLS_DESKTOP}`}
      >
        <div className={`flex items-center min-w-0 ${compact ? "py-1" : "py-3"} overflow-hidden`}>
          <TitleCell
            title={book.title}
            id={book.id}
            hasCover={book.has_cover}
            libraryId={libraryId}
          />
        </div>
        <div className={`flex items-center min-w-0 ${compact ? "py-1" : "py-3"} overflow-hidden`}>
          <AuthorsCell authors={book.authors} />
        </div>
        <div
          className={`hidden lg:flex items-center min-w-0 ${compact ? "py-1" : "py-3"} overflow-hidden`}
        >
          <SeriesCell series={book.series} seriesIndex={book.series_index} />
        </div>
        <div
          className={`hidden xl:flex items-center min-w-0 ${compact ? "py-1" : "py-3"} overflow-hidden`}
        >
          <TagsCell tags={book.tags} />
        </div>
        <div className={`flex items-center min-w-0 ${compact ? "py-1" : "py-3"}`}>
          <StarRating rating={book.rating} />
        </div>
        <div
          className={`hidden lg:flex items-center min-w-0 ${compact ? "py-1" : "py-3"} overflow-hidden`}
        >
          <FormatsCell formats={book.formats} bookId={book.id} />
        </div>
        <div className={`flex items-center justify-end ${compact ? "py-1" : "py-3"}`}>
          <ActionsCell id={book.id} />
        </div>
      </div>
    </div>
  );
});

// Empty state
const EmptyState = memo(function EmptyState({
  searchQuery,
  reason,
  hasActiveFilters,
  onClearFilters,
}: {
  searchQuery: string;
  reason?: string | null;
  hasActiveFilters: boolean;
  onClearFilters?: () => void;
}) {
  const heading =
    reason === "empty-library"
      ? "Your library is empty"
      : reason === "offline"
        ? "You're offline"
        : reason === "auth-expired"
          ? "Session expired"
          : "No books found";
  const hint = searchQuery
    ? `No books match "${searchQuery}". Try a different search term.`
    : reason === "empty-library"
      ? "Your library is empty. Add some books to get started."
      : reason === "offline"
        ? "Check your connection and try again."
        : reason === "auth-expired"
          ? "Please sign in again to continue browsing."
          : "No books match the current filters.";
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-8">
      <div className="w-14 h-14 rounded-full bg-parchment-dark flex items-center justify-center mb-3 border border-ink">
        <Search className="h-5 w-5 text-ink-muted" strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold text-ink mb-1">{heading}</h3>
      <p className="text-sm text-ink-tertiary">{hint}</p>
      {hasActiveFilters && onClearFilters && (
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
});

// Loading skeleton
const TableSkeleton = memo(function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {SKELETON_ROW_KEYS.map((rowKey, i) => (
        <div
          key={rowKey}
          className="h-16 bg-parchment-dark/70 rounded animate-pulse"
          style={{ animationDelay: `${i * 50}ms` }}
        />
      ))}
    </div>
  );
});

// Sort indicator component
interface SortHeaderProps {
  label: string;
  field: SortField;
  currentSort: SortConfig;
  onSort: (field: SortField) => void;
  className?: string;
}

export const SortHeader = memo(function SortHeader({
  label,
  field,
  currentSort,
  onSort,
  className = "",
}: SortHeaderProps) {
  const isActive = currentSort.field === field;
  const ariaLabel = isActive
    ? `Sort by ${label}, currently ${currentSort.order === "asc" ? "ascending" : "descending"}`
    : `Sort by ${label}`;

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={ariaLabel}
      className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider hover:text-ink transition-colors ${
        isActive ? "text-accent" : "text-ink-muted"
      } ${className}`}
    >
      {label}
      <span className="inline-flex flex-col">
        {isActive ? (
          currentSort.order === "asc" ? (
            <ChevronUp className="h-3 w-3" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3 w-3" strokeWidth={2} />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" strokeWidth={2} />
        )}
      </span>
    </button>
  );
});

// Table Header component for use in parent
interface TableHeaderProps {
  sortConfig: SortConfig;
  onSortChange: (config: SortConfig) => void;
}

export const TableHeader = memo(function TableHeader({
  sortConfig,
  onSortChange,
}: TableHeaderProps) {
  const handleSort = useCallback(
    (field: SortField) => {
      if (sortConfig.field === field) {
        onSortChange({
          field,
          order: sortConfig.order === "asc" ? "desc" : "asc",
        });
      } else {
        onSortChange({ field, order: "asc" });
      }
    },
    [sortConfig, onSortChange],
  );

  return (
    <>
      {/* Mobile header */}
      <div
        className={`px-3 h-10 items-center gap-2 border-b border-ink grid sm:!hidden ${GRID_COLS_MOBILE}`}
      >
        <SortHeader label="Title" field="title" currentSort={sortConfig} onSort={handleSort} />
        <SortHeader label="Author" field="author" currentSort={sortConfig} onSort={handleSort} />
        <span></span>
      </div>
      {/* Tablet/desktop header */}
      <div
        className={`px-4 h-12 items-center gap-2 lg:gap-4 border-b border-ink hidden sm:!grid ${GRID_COLS_DESKTOP}`}
      >
        <SortHeader label="Title" field="title" currentSort={sortConfig} onSort={handleSort} />
        <SortHeader label="Author" field="author" currentSort={sortConfig} onSort={handleSort} />
        <span className="hidden lg:block text-xs font-semibold text-ink-muted uppercase tracking-wider">
          Series
        </span>
        <span className="hidden xl:block text-xs font-semibold text-ink-muted uppercase tracking-wider">
          Tags
        </span>
        <SortHeader label="Rating" field="rating" currentSort={sortConfig} onSort={handleSort} />
        <span className="hidden lg:block text-xs font-semibold text-ink-muted uppercase tracking-wider">
          Formats
        </span>
        <span></span>
      </div>
    </>
  );
});

export const BookTableInfinite = memo(function BookTableInfinite({
  searchQuery,
  sortConfig,
  tagIds,
  formats,
  onClearFilters,
  stickyOffset = 0,
  rowHeight = ROW_HEIGHT,
  libraryId,
}: BookTableInfiniteProps) {
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
  const { scrollMargin, measured, setElement } = useBookListLayout();

  const virtualizer = useWindowVirtualizer({
    count: books.length,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 20,
    scrollMargin,
    scrollPaddingStart: stickyOffset,
    useFlushSync: false,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    if (rowHeight > 0) virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const isRestoring = useBookScrollRestoration({
    identity: JSON.stringify([queryKey, "table"]),
    books,
    columns: 1,
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
      lastVirtualItem.index >= books.length - 30 &&
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
    return <TableSkeleton />;
  }

  if (isError && errorStage === "initial") {
    const title = isAuthExpired
      ? "Session expired"
      : isOffline
        ? "You're offline"
        : "Failed to load books";
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-8">
        <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-3">
          <BookOpen className="h-5 w-5 text-error" strokeWidth={1.5} />
        </div>
        <h3 className="text-base font-semibold text-ink mb-1">{title}</h3>
        <p className="text-sm text-ink-tertiary">
          {isAuthExpired
            ? "Please sign in again to continue browsing."
            : isOffline
              ? "Check your connection and try again."
              : error instanceof Error
                ? error.message
                : "Unknown error"}
        </p>
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
    return (
      <EmptyState
        searchQuery={searchQuery}
        reason={emptyReason}
        hasActiveFilters={
          searchQuery !== "" || (tagIds?.length ?? 0) > 0 || (formats?.length ?? 0) > 0
        }
        onClearFilters={onClearFilters}
      />
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
      {/* Virtual list container at the list origin in normal flow (no
          internal scroll, uses window); rows offset by (start -
          scrollMargin) so the margin applies exactly once. */}
      <div ref={setElement} style={{ height: `${totalSize}px`, position: "relative" }}>
        {virtualItems.map((virtualItem) => {
          const book = books[virtualItem.index];
          if (!book) return null;

          return (
            <div
              key={book.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <TableRow book={book} rowHeight={rowHeight} libraryId={libraryId} />
            </div>
          );
        })}
      </div>

      {/* Loading indicator at bottom */}
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

      {/* Footer */}
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
