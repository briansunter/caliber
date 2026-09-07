import { memo, useEffect, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useFlattenedBooks, type SortConfig } from "@/hooks/useBooksInfinite";
import type { BookListItem } from "@/lib/calibre-optimized";
import { Link } from "@tanstack/react-router";
import { BookOpen, Search, Loader2 } from "lucide-react";
import { isUnknownAuthor } from "@/lib/utils";
import { BookCoverImage } from "./BookCoverImage";

interface BookGridInfiniteProps {
  searchQuery: string;
  sortConfig: SortConfig;
  tagIds?: number[];
}

const CARD_GAP = 16;
const CARD_MIN_WIDTH = 140;

// Fallback scroll margin used before the runtime measurement below runs.
// Devtools-measured sticky chrome above the grid ~120px (desktop + mobile:
// search bar ~64px + section/filter header ~56px); the measured list origin
// replaces this fallback at mount and on resize.
const GRID_SCROLL_MARGIN_FALLBACK = 120;

const GridCard = memo(function GridCard({ book }: { book: BookListItem }) {
  const unknown = isUnknownAuthor(book.authors);
  return (
    <Link
      to="/book/$id"
      params={{ id: String(book.id) }}
      aria-label={book.title}
      className="group flex flex-col overflow-hidden rounded-lg border border-ink bg-surface hover:shadow-md hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-[box-shadow,border-color]"
    >
      <div className="relative w-full aspect-[2/3] bg-parchment-dark flex items-center justify-center overflow-hidden">
        <BookCoverImage
          bookId={book.id}
          title={book.title}
          hasCover={book.has_cover}
          width={240}
          height={360}
          className="group-hover:brightness-[1.04] transition-[filter] duration-200"
        />
      </div>
      <div className="flex flex-col gap-0.5 p-2 min-h-[76px]">
        <span
          title={book.title}
          className="text-[13px] font-semibold text-ink leading-snug line-clamp-3 group-hover:text-accent transition-colors"
        >
          {book.title}
        </span>
        {!unknown && (
          <span className="text-xs text-ink-tertiary truncate">{book.authors?.join(", ")}</span>
        )}
      </div>
    </Link>
  );
});

export const BookGridInfinite = memo(function BookGridInfinite({ searchQuery, sortConfig, tagIds }: BookGridInfiniteProps) {
  const {
    books, totalCount, retainedCount, windowTruncated, hasNextPage, fetchNextPage,
    isFetchingNextPage, isFetchNextPageError, isLoading, isError, error, errorStage,
    isPlaceholder, emptyReason, isAuthExpired, isOffline, refetch, queryKey,
  } = useFlattenedBooks(searchQuery, sortConfig, tagIds);
  const queryClient = useQueryClient();

  // FUP8: callback-ref container so the ResizeObserver re-attaches when the
  // node mounts/changes (plain useRef + once-on-mount misses remounts).
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => {
    if (typeof window === "undefined") return 1232;
    return Math.min(window.innerWidth - 48, 1280 - 48);
  });
  const [columns, setColumns] = useState(() => {
    const available = Math.min(typeof window === "undefined" ? 1232 : window.innerWidth - 48, 1280 - 48);
    return Math.max(2, Math.floor((available + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  });
  const [cardHeight, setCardHeight] = useState(320);

  // S7: REAL scrollMargin measurement. The callback ref (setContainerEl)
  // captures the list container; its document-relative origin (viewport top
  // + scroll offset, which is scroll-invariant) is measured at mount and
  // re-measured on resize via ResizeObserver (+ a window resize fallback).
  // The measured value is passed to the virtualizer as scrollMargin, which
  // the React adapter picks up dynamically on re-render — no constant
  // assertion.
  const [measuredScrollMargin, setMeasuredScrollMargin] = useState(GRID_SCROLL_MARGIN_FALLBACK);
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const measureOrigin = () => {
      const origin = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
      setMeasuredScrollMargin((prev) => (prev === origin ? prev : origin));
    };
    measureOrigin();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measureOrigin);
      ro.observe(el);
    }
    window.addEventListener("resize", measureOrigin);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measureOrigin);
    };
  }, [containerEl]);

  // Measure the container (not the window) so grid sizing tracks the real
  // layout width, including sidebars and padding.
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const apply = (width: number) => {
      if (width > 0) setContainerWidth(width);
    };
    apply(el.clientWidth);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver((entries) => {
        apply(entries[0]?.contentRect.width ?? el.clientWidth);
      });
      ro.observe(el);
    }
    // Window-resize fallback (kept): covers environments where ResizeObserver
    // misses a layout change.
    const onResize = () => apply(el.clientWidth);
    window.addEventListener("resize", onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [containerEl]);

  useEffect(() => {
    const cols = Math.max(2, Math.floor((containerWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
    setColumns(cols);
    const cardWidth = (containerWidth - CARD_GAP * (cols - 1)) / cols;
    setCardHeight(Math.round(cardWidth * 1.5 + 76 + CARD_GAP));
  }, [containerWidth]);

  const rowCount = Math.ceil(books.length / columns);

  // scrollMargin is the MEASURED list origin (see above); it keeps the
  // restored/focused row from sliding under the sticky search + header.
  // TanStack contract: keep scrollMargin on the virtualizer AND do NOT
  // manually offset rows — rows use translateY(virtualRow.start) verbatim
  // and the virtualizer applies the margin internally. scrollPaddingStart
  // (200px below) is separate breathing room for scrollToIndex, NOT part of
  // the measured origin.
  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: useCallback(() => cardHeight, [cardHeight]),
    overscan: 5,
    scrollMargin: measuredScrollMargin,
    scrollPaddingStart: 200,
    // React 19 warns when the adapter flushes a virtualizer rerender while a
    // route transition is still rendering. Normal scheduling is sufficient
    // here and keeps grid view free of render-phase updates.
    useFlushSync: false,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Re-measure when the row size changes: cardHeight derives from the column
  // count, and columns is listed explicitly so a width-only change that
  // re-flows columns also invalidates cached measurements.
  // biome-ignore lint/correctness/useExhaustiveDependencies: columns intentionally included to invalidate measurements on re-flow.
  useEffect(() => {
    if (cardHeight > 0) virtualizer.measure();
  }, [cardHeight, columns, virtualizer]);

  // Infinite scroll — just use isFetchingNextPage, no extra state
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const shouldFetch =
    lastVirtualItem && lastVirtualItem.index >= rowCount - 5 && hasNextPage && !isFetchingNextPage;

  const fetchRef = useRef(fetchNextPage);
  fetchRef.current = fetchNextPage;

  useEffect(() => {
    if (shouldFetch) {
      fetchRef.current();
    }
  }, [shouldFetch]);

  // Persist the top-visible book anchor (id + offset) so back-navigation
  // restores by content, not by raw pixel offset which shifts as pages load.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          const range = virtualizer.range;
          const startRow = range?.startIndex ?? 0;
          const anchor = books[startRow * columns];
          if (anchor) {
            sessionStorage.setItem(
              "caliber-scroll",
              JSON.stringify({ id: anchor.id, offset: window.scrollY % Math.max(cardHeight, 1), columns }),
            );
          }
        } catch {}
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [books, columns, cardHeight, virtualizer]);

  // Anchor restore: fetch the required window first, then scroll. The retry
  // chain is cancelled on unmount or when search/sort/tags change.
  // FUP8: deps include books.length/hasNextPage readiness; the loop re-reads
  // the latest books from the queryClient cache after each fetchNextPage
  // (never the captured array, which goes stale across awaits).
  const restoreKey = `${searchQuery}|${sortConfig.field}|${sortConfig.order}|${(tagIds ?? []).join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore intentionally reads fresh books via queryClient after each fetch; captured books/fetchNextPage would go stale across awaits.
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const readFreshBooks = (): typeof books => {
      try {
        const data = queryClient.getQueryData<{ pages: { items: typeof books }[] }>(queryKey);
        if (data?.pages) return data.pages.flatMap((p) => p.items);
      } catch {}
      return books;
    };
    const run = async () => {
      let anchorId: number | null = null;
      let anchorOffset = 0;
      try {
        const raw = sessionStorage.getItem("caliber-scroll");
        const saved = raw ? (JSON.parse(raw) as { id?: unknown; offset?: unknown }) : null;
        if (saved && typeof saved.id === "number") anchorId = saved.id;
        if (saved && typeof saved.offset === "number") anchorOffset = saved.offset;
      } catch { anchorId = null; }
      let fresh = readFreshBooks();
      if (anchorId === null || fresh.length === 0) return;
      const wanted = anchorId;
      // Fetch forward until the anchor id is in the retained window.
      let guard = 0;
      let latestHasNext = hasNextPage;
      while (!cancelled && guard < 10 && latestHasNext && !fresh.some((b) => b.id === wanted)) {
        guard++;
        try {
          const result = await fetchNextPage();
          latestHasNext = (result.data?.pages.length ?? 0) > 0 ? (result.hasNextPage ?? latestHasNext) : latestHasNext;
        } catch { break; }
        fresh = readFreshBooks();
        if (fresh.some((b) => b.id === wanted)) break;
      }
      if (cancelled) return;
      fresh = readFreshBooks();
      const idx = fresh.findIndex((b) => b.id === wanted);
      if (idx >= 0) {
        const row = Math.floor(idx / columns);
        const off = anchorOffset;
        raf = requestAnimationFrame(() => {
          if (cancelled) return;
          try {
            // Single offset adjust only: scrollToIndex already accounts for
            // scrollMargin; apply the saved intra-row offset once.
            virtualizer.scrollToIndex(row, { align: "start" });
            if (off > 0) window.scrollBy({ top: off });
          } catch {}
          try { sessionStorage.removeItem("caliber-scroll"); } catch {}
        });
      }
    };
    void run();
    return () => { cancelled = true; cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreKey, books.length, hasNextPage, columns, queryClient, queryKey]);

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
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
    const title = isAuthExpired ? "Session expired" : isOffline ? "You're offline" : "Failed to load books";
    const hint = isAuthExpired
      ? "Please sign in again to continue browsing."
      : isOffline
        ? "Check your connection and try again."
        : error instanceof Error ? error.message : "Unknown error";
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
  const refreshBanner = isError && errorStage === "refresh" ? (
    <div className="mx-4 mt-3 rounded-lg border border-ink px-3 py-2 text-sm text-ink-tertiary flex items-center justify-between gap-2" role="alert">
      <span>Couldn't refresh — showing saved results.</span>
      <button type="button" onClick={() => refetch()} className="underline font-medium">Retry</button>
    </div>
  ) : null;

  if (books.length === 0 && !isPlaceholder) {
    const heading = emptyReason === "empty-library"
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
      </div>
    );
  }

  const footerCount = totalCount !== null && windowTruncated
    ? `Showing ${retainedCount.toLocaleString()} of ${totalCount.toLocaleString()} (retained window)`
    : `${books.length.toLocaleString()} book${books.length !== 1 ? "s" : ""}`;

  return (
    <div ref={setContainerEl}>
      {refreshBanner}
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
        <div className="flex items-center justify-center py-4 border-t border-parchment" aria-live="polite">
          <div className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            <span className="text-sm">Loading more…</span>
          </div>
        </div>
      )}

      {isFetchNextPageError && !isFetchingNextPage && (
        <div className="flex items-center justify-center gap-2 py-3 border-t border-parchment text-sm text-ink-tertiary" role="alert">
          <span>Couldn't load more books.</span>
          <button type="button" onClick={() => fetchNextPage()} className="underline font-medium">Retry</button>
        </div>
      )}

      <div className="px-3 sm:px-4 py-3 border-t border-ink bg-parchment-dark flex items-center justify-between gap-2 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-4 w-4 text-accent flex-shrink-0" strokeWidth={2} />
          <span className="text-sm font-medium text-ink whitespace-nowrap">
            {footerCount}
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
});
