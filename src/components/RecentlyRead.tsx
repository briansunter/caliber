import { useEffect, useMemo, useState, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { X, ChevronDown, ChevronUp, Trash2, Undo2 } from "lucide-react";
import { BookCoverImage } from "./BookCoverImage";
import { isUnknownAuthor } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user";
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
  scope: string;
  key: number;
  message: string;
  items: ReadingListItem[];
}

export function RecentlyRead({ libraryId }: { libraryId?: string }) {
  const { data, isLoading, isError } = useReadingList();
  const { user } = useCurrentUser();
  const scope = `${user?.id ?? "anon"}:${libraryId ?? "default"}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const queryClient = useQueryClient();
  const remove = useRemoveFromReadingList();
  const clear = useClearReadingList();
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<ReadingSort>("recent");
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<UndoToast | null>(null);

  const items = useMemo(() => sortReadingList(data?.items ?? [], sort), [data?.items, sort]);

  // A profile switch must never carry an undo snapshot into the next shelf.
  // biome-ignore lint/correctness/useExhaustiveDependencies: profile changes intentionally clear local UI state.
  useEffect(() => {
    setToast(null);
    setConfirmClear(false);
  }, [scope]);

  // Auto-dismiss the undo toast after 8s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast((cur) => (cur?.key === toast.key ? null : cur));
    }, 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const undo = () => {
    const snapshot = toast;
    if (!snapshot || snapshot.scope !== scopeRef.current) {
      setToast(null);
      return;
    }
    setToast(null);
    // Restore the shelf optimistically, then re-save each entry. The
    // deletion sequence acknowledged by the mutation authorizes restoration
    // without losing the saved reader location.
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
          location: entry.progress.location ?? null,
          percentage: entry.progress.percentage,
          finished: entry.progress.finished,
        });
      } catch {}
    }
  };

  const busy = remove.isPending || clear.isPending;
  const handleRemove = (item: ReadingListItem) => {
    if (busy) return;
    const requestScope = scope;
    remove.mutate(item.book.id, {
      onSuccess: () => {
        if (requestScope !== scopeRef.current) return;
        setToast({
          scope: requestScope,
          key: Date.now(),
          message: `Removed “${item.book.title}”.`,
          items: [item],
        });
      },
    });
  };

  const handleClear = () => {
    if (busy) return;
    const snapshot = items;
    const requestScope = scope;
    clear.mutate(undefined, {
      onSuccess: () => {
        if (requestScope !== scopeRef.current) return;
        if (snapshot.length)
          setToast({
            scope: requestScope,
            key: Date.now(),
            message: `Cleared ${snapshot.length} recently read book${snapshot.length === 1 ? "" : "s"}.`,
            items: snapshot,
          });
        setConfirmClear(false);
        setExpanded(false);
      },
    });
  };

  const undoToast = toast && toast.scope === scope && (
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
  );
  const mutationError = remove.error || clear.error;
  const errorBanner = mutationError ? (
    <p role="alert" className="mb-3 text-sm text-error">
      Could not update your reading history. Please try again.
    </p>
  ) : null;

  // Loading skeleton keeps the shelf space stable while the reading list
  // resolves. Signed-out (error) stays hidden, as does an empty shelf.
  if (isLoading) {
    return (
      <section
        className="recently-read-section"
        aria-label="Loading recently read"
        aria-busy="true"
      >
        <div className="mb-2 flex items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-secondary">
            Recently read
          </h2>
        </div>
        <div className="recent-reading-grid" aria-hidden="true">
          {Array.from({ length: COLLAPSED_COUNT }, (_, i) => `recent-skeleton-${i}`).map((key) => (
            <div key={key} className="flex gap-3 rounded-lg border border-ink bg-surface p-3">
              <div className="h-24 w-16 flex-shrink-0 animate-pulse rounded bg-parchment-dark/70" />
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
  if (isError || items.length === 0)
    return (
      <>
        {errorBanner}
        {undoToast}
      </>
    );

  const visible = expanded ? items : items.slice(0, COLLAPSED_COUNT);
  const hasMore = items.length > COLLAPSED_COUNT;

  return (
    <section id="recently-read" className="recently-read-section" aria-label="Recently read">
      {errorBanner}
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
                disabled={busy}
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
              disabled={busy}
              className="flex items-center gap-1 rounded-md border border-ink px-2 py-1 text-xs text-ink-secondary hover:text-ink hover:bg-parchment-dark transition-colors"
              title="Clear recently read"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </div>

      <div className="recent-reading-grid">
        {visible.map((item) => (
          <ReadingCard
            key={item.book.id}
            item={item}
            busy={busy}
            libraryId={libraryId}
            onRemove={() => handleRemove(item)}
          />
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
      {undoToast}
    </section>
  );
}

function ReadingCard({
  item,
  onRemove,
  busy,
  libraryId,
}: {
  item: ReadingListItem;
  onRemove: () => void;
  busy: boolean;
  libraryId?: string;
}) {
  const { book, progress } = item;
  const unknown = isUnknownAuthor(book.authors);
  const pct = Math.max(0, Math.min(100, Math.round(progress.percentage)));
  return (
    <div className="group relative recent-reading-card">
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${book.title} from recently read`}
        title="Remove"
        className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full text-ink-tertiary hover:bg-parchment-dark hover:text-ink disabled:opacity-40"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.7} />
      </button>
      <Link
        to="/book/$id"
        params={{ id: String(book.id) }}
        aria-label={book.title}
        className="recent-reading-link hover:bg-parchment-dark/40 transition-colors"
      >
        <div className="recent-reading-cover">
          <BookCoverImage
            bookId={book.id}
            title={book.title}
            author={unknown ? undefined : book.authors?.join(", ")}
            hasCover={book.has_cover}
            authKey={libraryId}
            width={130}
            height={196}
          />
        </div>
        <div className="recent-reading-info">
          <span title={book.title} className="recent-reading-title line-clamp-2">
            {book.title}
          </span>
          {!unknown && (
            <span className="recent-reading-author truncate">{book.authors?.join(", ")}</span>
          )}
          <div className="recent-reading-progress">
            <span>{progress.finished ? "Finished" : `${pct}% complete`}</span>
            <div className="recent-reading-track">
              <div style={{ width: `${progress.finished ? 100 : pct}%` }} />
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}
