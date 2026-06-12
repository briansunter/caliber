import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, Check, ChevronDown, ChevronUp } from "lucide-react";
import { CoverFallback } from "./CoverFallback";
import { isUnknownAuthor } from "@/lib/utils";
import {
  useReadingList,
  useRemoveFromReadingList,
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

export function RecentlyRead() {
  const { data, isLoading } = useReadingList();
  const remove = useRemoveFromReadingList();
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<ReadingSort>("recent");

  const items = useMemo(() => sortReadingList(data?.items ?? [], sort), [data?.items, sort]);

  // Hidden entirely when signed out or nothing read yet.
  if (isLoading || items.length === 0) return null;

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
            value={sort}
            onChange={(e) => setSort(e.target.value as ReadingSort)}
            className="rounded-md border border-ink bg-white px-1.5 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-6">
        {visible.map((item) => (
          <ReadingCard
            key={item.book.id}
            item={item}
            onRemove={() => remove.mutate(item.book.id)}
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
        className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-ink/70 text-white opacity-0 transition-opacity hover:bg-ink focus:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      <Link
        to="/book/$id"
        params={{ id: String(book.id) }}
        aria-label={book.title}
        className="flex flex-col overflow-hidden rounded-lg border border-ink bg-white transition-all hover:border-accent/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-parchment-dark">
          {book.has_cover ? (
            <img
              src={`/api/books/${book.id}/thumb`}
              alt={book.title}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <CoverFallback title={book.title} size="lg" />
          )}
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
