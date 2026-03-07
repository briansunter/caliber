import { memo, useEffect, useState, useCallback, useRef } from "react";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useFlattenedBooks, type SortConfig } from "@/hooks/useBooksInfinite";
import type { BookListItem } from "@/lib/calibre-optimized";
import { Link } from "@tanstack/react-router";
import { BookOpen, Search, Loader2 } from "lucide-react";

interface BookGridInfiniteProps {
  searchQuery: string;
  sortConfig: SortConfig;
}

const CARD_GAP = 16;
const CARD_MIN_WIDTH = 140;

const GridCard = memo(function GridCard({ book }: { book: BookListItem }) {
  return (
    <Link
      to="/book/$id"
      params={{ id: String(book.id) }}
      className="group flex flex-col overflow-hidden rounded-lg border border-ink bg-white hover:shadow-md transition-shadow"
    >
      <div className="relative w-full aspect-[2/3] bg-parchment-dark flex items-center justify-center overflow-hidden">
        {book.has_cover ? (
          <img
            src={`/api/books/${book.id}/thumb`}
            alt=""
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        ) : (
          <BookOpen className="h-10 w-10 text-ink-muted" strokeWidth={1} />
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2 min-h-[60px]">
        <span className="text-sm font-medium text-ink leading-tight line-clamp-2 group-hover:text-accent transition-colors">
          {book.title}
        </span>
        <span className="text-xs text-ink-tertiary truncate">
          {book.authors?.length ? book.authors.join(", ") : "Unknown"}
        </span>
      </div>
    </Link>
  );
});

export function BookGridInfinite({ searchQuery, sortConfig }: BookGridInfiniteProps) {
  const {
    books,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useFlattenedBooks(searchQuery, sortConfig);

  const [columns, setColumns] = useState(() => {
    const available = Math.min(window.innerWidth - 48, 1280 - 48);
    return Math.max(2, Math.floor((available + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  });
  const [cardHeight, setCardHeight] = useState(320);

  useEffect(() => {
    function updateLayout() {
      const available = Math.min(window.innerWidth - 48, 1280 - 48);
      const cols = Math.max(2, Math.floor((available + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
      setColumns(cols);
      const cardWidth = (available - CARD_GAP * (cols - 1)) / cols;
      setCardHeight(Math.round(cardWidth * 1.5 + 60 + CARD_GAP));
    }
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  const rowCount = Math.ceil(books.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: useCallback(() => cardHeight, [cardHeight]),
    overscan: 5,
    scrollPaddingStart: 200,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Infinite scroll — just use isFetchingNextPage, no extra state
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const shouldFetch = lastVirtualItem && lastVirtualItem.index >= rowCount - 5
    && hasNextPage && !isFetchingNextPage;

  const fetchRef = useRef(fetchNextPage);
  fetchRef.current = fetchNextPage;

  useEffect(() => {
    if (shouldFetch) {
      fetchRef.current();
    }
  }, [shouldFetch]);

  // Scroll to top on search/sort change (skip initial mount for scroll restoration)
  const hasMountedGrid = useRef(false);
  useEffect(() => {
    if (hasMountedGrid.current) {
      window.scrollTo({ top: 0 });
    }
    hasMountedGrid.current = true;
  }, []);

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns * 2 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] bg-parchment-dark/70 rounded-lg animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
        ))}
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
  }

  return (
    <div>
      <div style={{ height: `${totalSize}px`, position: "relative" }}>
        {virtualItems.map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowBooks = books.slice(startIndex, startIndex + columns);

          return (
            <div
              key={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                height: `${cardHeight}px`,
                padding: `0 16px`,
              }}
            >
              <div
                className="grid h-full"
                style={{
                  gridTemplateColumns: `repeat(${columns}, 1fr)`,
                  gap: `${CARD_GAP}px`,
                }}
              >
                {rowBooks.map((book) => (
                  <GridCard key={book.id} book={book} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {isFetchingNextPage && (
        <div className="flex items-center justify-center py-4 border-t border-parchment">
          <div className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            <span className="text-sm">Loading more...</span>
          </div>
        </div>
      )}

      <div className="px-3 sm:px-4 py-3 border-t border-ink bg-parchment-dark flex items-center justify-between gap-2 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-4 w-4 text-accent flex-shrink-0" strokeWidth={2} />
          <span className="text-sm font-medium text-ink whitespace-nowrap">
            {books.length.toLocaleString()} book{books.length !== 1 ? "s" : ""}
          </span>
          <span className="text-sm text-ink-muted truncate">
            {searchQuery ? `matching "${searchQuery}"` : "loaded"}
          </span>
        </div>
        <div className="text-xs text-ink-muted whitespace-nowrap hidden sm:block">
          {hasNextPage ? "Scroll to load more" : "All books loaded"}
        </div>
      </div>
    </div>
  );
}
