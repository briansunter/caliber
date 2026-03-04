import { useMemo, memo, useEffect, useState, useCallback } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useBooksInfinite, useSearchInfinite, type SortConfig, type SortField } from "@/hooks/useBooksInfinite";
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

interface BookTableInfiniteProps {
  searchQuery: string;
  sortConfig: SortConfig;
}

const COLUMN_WIDTHS = {
  title: "minmax(300px, 3fr)",
  authors: "minmax(160px, 1.5fr)",
  series: "minmax(140px, 1.2fr)",
  tags: "minmax(180px, 1.5fr)",
  rating: "90px",
  formats: "minmax(100px, 1fr)",
  actions: "60px",
};

export const GRID_TEMPLATE = `${COLUMN_WIDTHS.title} ${COLUMN_WIDTHS.authors} ${COLUMN_WIDTHS.series} ${COLUMN_WIDTHS.tags} ${COLUMN_WIDTHS.rating} ${COLUMN_WIDTHS.formats} ${COLUMN_WIDTHS.actions}`;

const ROW_HEIGHT = 72;

// Flatten infinite query pages into a single array
function useFlattenedBooks(searchQuery: string, sortConfig: SortConfig) {
  const booksQuery = useBooksInfinite(sortConfig);
  const searchQueryHook = useSearchInfinite(searchQuery, sortConfig);

  const query = searchQuery.trim() ? searchQueryHook : booksQuery;

  const flattenedBooks = useMemo(() => {
    return query.data?.pages.flatMap((page) => page.items) ?? [];
  }, [query.data]);

  const hasNextPage = query.hasNextPage;
  const fetchNextPage = query.fetchNextPage;
  const isFetchingNextPage = query.isFetchingNextPage;
  const isLoading = query.isLoading;
  const isError = query.isError;
  const error = query.error;

  return {
    books: flattenedBooks,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  };
}

// Star rating component
const StarRating = memo(function StarRating({
  rating,
}: {
  rating?: number | null;
}) {
  if (!rating) return <span className="text-ink-muted">—</span>;

  const stars = [];
  const fullStars = Math.floor(rating / 2);
  const hasHalfStar = rating % 2 >= 1;

  for (let i = 0; i < 5; i++) {
    if (i < fullStars) {
      stars.push(
        <Star key={i} className="h-3.5 w-3.5 fill-accent text-accent" />
      );
    } else if (i === fullStars && hasHalfStar) {
      stars.push(
        <div key={i} className="relative">
          <Star className="h-3.5 w-3.5 text-ink" strokeWidth={1} />
          <div className="absolute inset-0 overflow-hidden w-1/2">
            <Star className="h-3.5 w-3.5 fill-accent text-accent" />
          </div>
        </div>
      );
    } else {
      stars.push(<Star key={i} className="h-3.5 w-3.5 text-ink" strokeWidth={1} />);
    }
  }

  return <div className="flex items-center gap-0.5">{stars}</div>;
});

// Cell components
const TitleCell = memo(function TitleCell({
  title,
  id,
  hasCover,
}: {
  title: string;
  id: number;
  hasCover?: boolean;
}) {
  return (
    <Link
      to="/book/$id"
      params={{ id: String(id) }}
      className="group flex items-center gap-3 min-w-0"
    >
      <div
        className="relative flex-shrink-0 w-9 h-12 rounded bg-parchment-dark overflow-hidden flex items-center justify-center border border-ink"
      >
        <BookOpen className="h-4 w-4 text-ink-muted" strokeWidth={1.5} />
        {hasCover && <div className="absolute bottom-0 left-0 right-0 h-1 bg-accent" />}
      </div>
      <span className="font-medium text-ink-secondary group-hover:text-accent transition-colors line-clamp-2">
        {title}
      </span>
    </Link>
  );
});

const AuthorsCell = memo(function AuthorsCell({
  authors,
}: {
  authors?: string[];
}) {
  if (!authors || authors.length === 0) {
    return <span className="text-ink-muted italic">Unknown</span>;
  }
  return (
    <span className="text-ink-tertiary truncate">{authors.join(", ")}</span>
  );
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
      <span className="text-xs text-ink-muted">Book {seriesIndex || 1}</span>
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
      {tags.length > 2 && (
        <span className="text-xs text-ink-muted">+{tags.length - 2}</span>
      )}
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

  const handleDownload = (format: string) => {
    const link = document.createElement("a");
    link.href = `/api/books/${bookId}/download/${format}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-wrap gap-1">
      {formats.slice(0, 3).map((fmt) => (
        <button
          key={fmt}
          onClick={() => handleDownload(fmt)}
          className="format-tag"
          title={`Download ${fmt}`}
        >
          {fmt}
        </button>
      ))}
      {formats.length > 3 && (
        <span className="text-xs text-ink-muted">+{formats.length - 3}</span>
      )}
    </div>
  );
});

const ActionsCell = memo(function ActionsCell({ id }: { id: number }) {
  return (
    <Link to="/book/$id" params={{ id: String(id) }}>
      <button className="p-2 rounded-md hover:bg-parchment-dark text-ink-muted hover:text-ink transition-colors">
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </Link>
  );
});

// Virtual row component - rendered as a normal row in the flow
interface TableRowProps {
  book: BookListItem;
}

const TableRow = memo(function TableRow({ book }: TableRowProps) {
  return (
    <div
      className="flex items-center px-4 border-b border-parchment hover:bg-parchment-dark transition-colors"
      style={{ height: `${ROW_HEIGHT}px` }}
    >
      <div
        className="w-full h-full items-center"
        style={{ display: "grid", gridTemplateColumns: GRID_TEMPLATE, gap: "1rem" }}
      >
        <div className="flex items-center min-w-0 py-3 overflow-hidden">
          <TitleCell
            title={book.title}
            id={book.id}
            hasCover={book.has_cover}
          />
        </div>
        <div className="flex items-center min-w-0 py-3 overflow-hidden">
          <AuthorsCell authors={book.authors} />
        </div>
        <div className="flex items-center min-w-0 py-3 overflow-hidden">
          <SeriesCell series={book.series} seriesIndex={book.series_index} />
        </div>
        <div className="flex items-center min-w-0 py-3 overflow-hidden">
          <TagsCell tags={book.tags} />
        </div>
        <div className="flex items-center min-w-0 py-3">
          <StarRating rating={book.rating} />
        </div>
        <div className="flex items-center min-w-0 py-3 overflow-hidden">
          <FormatsCell formats={book.formats} bookId={book.id} />
        </div>
        <div className="flex items-center justify-end py-3">
          <ActionsCell id={book.id} />
        </div>
      </div>
    </div>
  );
});

// Empty state
const EmptyState = memo(function EmptyState({
  searchQuery,
}: {
  searchQuery: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-8">
      <div className="w-14 h-14 rounded-full bg-parchment-dark flex items-center justify-center mb-3 border border-ink">
        <Search className="h-5 w-5 text-ink-muted" strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold text-ink mb-1">No books found</h3>
      <p className="text-sm text-ink-tertiary">
        {searchQuery
          ? `No books match "${searchQuery}". Try a different search term.`
          : "Your library is empty. Add some books to get started."}
      </p>
    </div>
  );
});

// Loading skeleton
const TableSkeleton = memo(function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
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

  return (
    <button
      onClick={() => onSort(field)}
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

export const TableHeader = memo(function TableHeader({ sortConfig, onSortChange }: TableHeaderProps) {
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
    [sortConfig, onSortChange]
  );

  return (
    <div className="px-4 h-12 items-center border-b border-ink" style={{ display: "grid", gridTemplateColumns: GRID_TEMPLATE, gap: "1rem" }}>
      <SortHeader
        label="Title"
        field="title"
        currentSort={sortConfig}
        onSort={handleSort}
      />
      <SortHeader
        label="Author"
        field="author"
        currentSort={sortConfig}
        onSort={handleSort}
      />
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Series</span>
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Tags</span>
      <SortHeader
        label="Rating"
        field="rating"
        currentSort={sortConfig}
        onSort={handleSort}
      />
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Formats</span>
      <span></span>
    </div>
  );
});

export function BookTableInfinite({
  searchQuery,
  sortConfig,
}: BookTableInfiniteProps) {
  const {
    books,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useFlattenedBooks(searchQuery, sortConfig);

  const [isAutoFetching, setIsAutoFetching] = useState(false);

  // Set up window virtualizer - uses window scroll
  const virtualizer = useWindowVirtualizer({
    count: books.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollPaddingStart: 200, // Offset for fixed header
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Infinite scroll: fetch more when near bottom
  useEffect(() => {
    if (!virtualItems.length || !hasNextPage || isFetchingNextPage) return;

    const lastItem = virtualItems[virtualItems.length - 1];
    if (!lastItem) return;

    const isNearBottom = lastItem.index >= books.length - 20;

    if (isNearBottom && !isAutoFetching) {
      setIsAutoFetching(true);
      fetchNextPage().finally(() => {
        setIsAutoFetching(false);
      });
    }
  }, [virtualItems, books.length, hasNextPage, isFetchingNextPage, fetchNextPage, isAutoFetching]);

  // Scroll to top when search or sort changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    virtualizer.scrollToIndex(0);
  }, [searchQuery, sortConfig, virtualizer]);

  if (isLoading) {
    return (
      <div className="overflow-hidden">
        <div className="table-header">
          <div className="px-4 h-12 items-center" style={{ display: "grid", gridTemplateColumns: GRID_TEMPLATE, gap: "1rem" }}>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Title</span>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Author</span>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Series</span>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Tags</span>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Rating</span>
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Formats</span>
            <span></span>
          </div>
        </div>
        <TableSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-8">
        <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-3">
          <BookOpen className="h-5 w-5 text-error" strokeWidth={1.5} />
        </div>
        <h3 className="text-base font-semibold text-ink mb-1">Failed to load books</h3>
        <p className="text-sm text-ink-tertiary">{error instanceof Error ? error.message : "Unknown error"}</p>
      </div>
    );
  }

  if (books.length === 0) {
    return <EmptyState searchQuery={searchQuery} />;
  }

  return (
    <div>
      {/* Virtual list container - no internal scroll, uses window */}
      <div style={{ height: `${totalSize}px`, position: "relative" }}>
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
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <TableRow book={book} />
            </div>
          );
        })}
      </div>

      {/* Loading indicator at bottom */}
      {(isFetchingNextPage || isAutoFetching) && (
        <div className="flex items-center justify-center py-4 border-t border-parchment">
          <div className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            <span className="text-sm">Loading more...</span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-3 border-t border-ink bg-parchment-dark flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-accent" strokeWidth={2} />
          <span className="text-sm font-medium text-ink">
            {books.length.toLocaleString()} book{books.length !== 1 ? "s" : ""}
          </span>
          <span className="text-sm text-ink-muted">
            {searchQuery ? `matching "${searchQuery}"` : "loaded"}
          </span>
          {hasNextPage && (
            <span className="text-xs text-ink-muted">(more available)</span>
          )}
        </div>
        <div className="text-xs text-ink-muted">
          {hasNextPage ? "Scroll to load more" : "All books loaded"}
        </div>
      </div>
    </div>
  );
}
