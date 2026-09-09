import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { X, Check, ChevronDown, ChevronUp, Trash2, Undo2 } from "lucide-react";
import { BookCoverImage } from "./BookCoverImage";
import { isUnknownAuthor } from "@/lib/utils";
import {
  useReadingList,
  useRemoveFromReadingList,
  useClearReadingList,
  saveBookProgress,
  sortReadingList,
  type ReadingListItem,
  type ReadingSort,
} from "@/lib/reading-progress";

const COLLAPSED_COUNT = 6;

const SORT_OPTIONS: { value: ReadingSort; label: string }[] = [
  { value: "recent", label: "Last read" },
  { value: "title", label: "Title" },
  { value: "progress", label: "Progress" },
];

interface UndoToast {
  key: number;
  message: string;
  items: ReadingListItem[];
}

export function RecentlyRead() {
  const { data, isLoading, isError } = useReadingList();
  const queryClient = useQueryClient();
  const remove = useRemoveFromReadingList();
  const clear = useClearReadingList();
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<ReadingSort>("recent");
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<UndoToast | null>(null);

  const items = useMemo(() => sortReadingList(data?.items ?? [], sort), [data?.items, sort]);

  // Auto-dismiss the undo toast after 6s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast((cur) => (cur?.key === toast.key ? null : cur));
    }, 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const undo = () => {
    const snapshot = toast;
    if (!snapshot) return;
    setToast(null);
    // Restore the shelf optimistically, then re-save each entry. The
    // re-save lands after the deletion tombstone (ts >= deletedAt), so the
    // documented last-writer-wins policy resurrects the rows server-side.
    try {
      const current = queryClient.getQueryData<{ items: ReadingListItem[] }>(["reading-list"]);
      const seen = new Set((current?.items ?? []).map((i) => i.book.id));
      const missing = snapshot.items.filter((i) => !seen.has(i.book.id));
      if (missing.length > 0) {
        queryClient.setQueryData(["reading-list"], {
          items: [...(current?.items ?? []), ...missing],
        });
      }
    } catch {}
    for (const entry of snapshot.items) {
      try {
        saveBookProgress(entry.book.id, {
          format: entry.progress.format,
          location: null,
          percentage: entry.progress.percentage,
          finished: entry.progress.finished,
        });
      } catch {}
    }
  };

  const handleRemove = (item: ReadingListItem) => {
    setToast({
      key: Date.now(),
      message: `Removed “${item.book.title}”.`,
      items: [item],
    });
    remove.mutate(item.book.id);
  };

  const handleClear = () => {
    if (items.length > 0) {
      setToast({
        key: Date.now(),
        message: `Cleared ${items.length} recently read book${items.length === 1 ? "" : "s"}.`,
        items,
      });
    }
    clear.mutate();
    setConfirmClear(false);
    setExpanded(false);
  };

  // Loading skeleton keeps the shelf space stable while the reading list
  // resolves. Signed-out (error) stays hidden, as does an empty shelf.
  if (isLoading) {
    return (
      <section className="mb-4 sm:mb-6" aria-label="Loading recently read" aria-busy="true">
        <div className="mb-2 flex items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-secondary">
            Recently read
          </h2>
        </div>
        <div
          className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-6"
          aria-hidden="true"
        >
          {Array.from({ length: COLLAPSED_COUNT }, (_, i) => `recent-skeleton-${i}`).map((key) => (
            <div key={key} className="overflow-hidden rounded-lg border border-ink bg-surface">
              <div className="aspect-[2/3] w-full animate-pulse bg-parchment-dark/70" />
              <div className="flex min-h-[52px] flex-col gap-1.5 p-1.5">
                <div className="h-3 w-4/5 animate-pulse rounded bg-parchment-dark/70" />
                <div className="h-2.5 w-3/5 animate-pulse rounded bg-parchment-dark/70" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Hidden entirely when signed out or nothing read yet.
  if (isError || items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, COLLAPSED_COUNT);
  const hasMore = items.length > COLLAPSED_COUNT;

  return (
    <section className="mb-4 sm:mb-6">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-secondary">
          Recently read
        </h2>
        <span className="text-xs text-ink-tertiary">{items.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <label htmlFor="reading-sort" className="text-xs text-ink-tertiary">
            Sort
          </label>
          <select
            id="reading-sort"
            name="reading-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as ReadingSort)}
            className="rounded-md border border-ink bg-surface px-1.5 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {confirmClear ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleClear}
                className="rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-md border border-ink px-2 py-1 text-xs text-ink hover:bg-parchment-dark transition-colors"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1 rounded-md border border-ink px-2 py-1 text-xs text-ink-secondary hover:text-ink hover:bg-parchment-dark transition-colors"
              title="Clear recently read"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-6">
        {visible.map((item) => (
          <ReadingCard key={item.book.id} item={item} onRemove={() => handleRemove(item)} />
        ))}
      </div>

      {hasMore && (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-ink hover:bg-ink/5 transition-colors"
          >
            {expanded ? (
              <>
                Show less <ChevronUp className="h-4 w-4" strokeWidth={1.5} />
              </>
            ) : (
              <>
                Show all {items.length} <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
              </>
            )}
          </button>
        </div>
      )}
      {toast && (
        <output
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-ink bg-surface px-3 py-2 shadow-xl"
        >
          <span className="max-w-[50vw] truncate text-sm text-ink">{toast.message}</span>
          <button
            type="button"
            onClick={undo}
            aria-label="Undo remove from recently read"
            className="flex flex-shrink-0 items-center gap-1 rounded-md bg-ink px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Undo2 className="h-3.5 w-3.5" strokeWidth={2} />
            Undo
          </button>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="flex-shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-parchment-dark hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </output>
      )}
    </section>
  );
}

function ReadingCard({ item, onRemove }: { item: ReadingListItem; onRemove: () => void }) {
  const { book, progress } = item;
  const unknown = isUnknownAuthor(book.authors);
  const pct = Math.round(progress.percentage);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove ${book.title} from recently read`}
        title="Remove"
        className="absolute right-1 top-1 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-ink/80 text-white shadow-sm transition-opacity hover:bg-ink sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
      >
        <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" strokeWidth={2} />
      </button>

      <Link
        to="/book/$id"
        params={{ id: String(book.id) }}
        aria-label={book.title}
            className="flex flex-col overflow-hidden rounded-lg border border-ink bg-surface transition-[box-shadow,border-color] hover:border-accent/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-parchment-dark">
          <BookCoverImage
            bookId={book.id}
            title={book.title}
            hasCover={book.has_cover}
            width={240}
            height={360}
          />
          {progress.finished ? (
            <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-emerald-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              <Check className="h-3 w-3" strokeWidth={2.5} /> Read
            </span>
          ) : (
            pct > 0 && (
              <span className="absolute bottom-1 left-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {pct}%
              </span>
            )
          )}
          {/* Progress bar */}
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div
              className={`h-full ${progress.finished ? "bg-emerald-500" : "bg-accent"}`}
              style={{ width: `${progress.finished ? 100 : pct}%` }}
            />
          </div>
        </div>
        <div className="flex min-h-[52px] flex-col gap-0.5 p-1.5">
          <span
            title={book.title}
            className="line-clamp-2 text-[12px] font-semibold leading-snug text-ink"
          >
            {book.title}
          </span>
          {!unknown && (
            <span className="truncate text-[11px] text-ink-tertiary">
              {book.authors?.join(", ")}
            </span>
          )}
        </div>
      </Link>
    </div>
  );
}
