import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Tags, X, Check, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TagSummary } from "@/hooks/useBooksInfinite";

interface TagFilterProps {
  tags: TagSummary[] | undefined;
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  isLoading?: boolean;
}

// Mobile bottom-sheet breakpoint — below this the panel renders as a sheet,
// at/above it renders as a desktop dropdown. Must match the `md:` classes below.
const MOBILE_MAX = "(max-width: 767px)";

export const TagFilter = memo(function TagFilter({
  tags,
  selectedIds,
  onChange,
  isLoading,
}: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedCount = selectedIds.length;
  const active = open || selectedCount > 0;

  const close = () => setOpen(false);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll only while the mobile sheet is open (avoid layout shift / blocking
  // background scroll on desktop where the dropdown is small).
  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia(MOBILE_MAX).matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus the name filter on open, but only on desktop (no keyboard pop on mobile)
  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia(MOBILE_MAX).matches) {
      inputRef.current?.focus();
    }
  }, [open]);

  const filteredTags = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !tags) return tags ?? [];
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, filter]);

  // Cap the number of chips rendered at once so libraries with hundreds/thousands
  // of tags stay snappy. With no filter active the list is already sorted by
  // popularity (count desc), so showing the top slice surfaces the most useful
  // tags; typing in the search box narrows past the cap.
  const RENDER_CAP = 300;
  const isFiltering = filter.trim().length > 0;
  const visibleTags =
    !isFiltering && filteredTags.length > RENDER_CAP ? filteredTags.slice(0, RENDER_CAP) : filteredTags;
  const hiddenCount = filteredTags.length - visibleTags.length;

  const toggle = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const clearAll = () => onChange([]);

  const triggerLabel = `${selectedCount > 0 ? `Filter by tags, ${selectedCount} selected` : "Filter by tags"}`;

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 sm:px-3.5 h-10 sm:h-[46px] min-w-[44px] text-sm font-medium transition-colors",
          active
            ? "bg-accent text-white border-accent"
            : "bg-white text-ink-secondary border-ink hover:text-ink",
        )}
      >
        <Tags className="h-4 w-4" strokeWidth={1.75} />
        <span className="hidden sm:inline">Tags</span>
        {selectedCount > 0 && (
          <span
            className={cn(
              "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold",
              open ? "bg-white/25 text-white" : "bg-accent text-white",
            )}
          >
            {selectedCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-catcher backdrop: faint on desktop, transparent scrim on mobile */}
          <div
            className="fixed inset-0 z-40 bg-black/20 md:bg-black/10"
            onClick={close}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Filter by tags"
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 flex flex-col bg-white border border-ink shadow-xl",
              "rounded-t-2xl md:rounded-lg",
              "max-h-[85vh] md:max-h-[30rem] md:w-80",
              "md:absolute md:right-0 md:left-auto md:bottom-auto md:top-full md:mt-2",
            )}
          >
            {/* Mobile drag handle */}
            <div className="md:hidden flex justify-center pt-2.5 pb-1">
              <span className="block w-10 h-1 rounded-full bg-ink/15" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3 md:pt-3.5 pb-2">
              <h2 className="text-base font-semibold text-ink">Filter by tags</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close tag filter"
                className="p-1.5 -mr-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-parchment-dark transition-colors"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>

            {/* OR hint + selection summary */}
            <div className="flex items-center justify-between gap-2 px-4 pb-2.5">
              <p className="text-xs text-ink-tertiary">
                Match <span className="font-semibold text-ink-secondary">any</span> selected tag
              </p>
              {selectedCount > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors"
                >
                  Clear all ({selectedCount})
                </button>
              ) : (
                <span className="text-xs text-ink-muted">None selected</span>
              )}
            </div>

            {/* Name filter */}
            <div className="px-4 pb-2.5">
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted"
                  strokeWidth={1.5}
                />
                <input
                  ref={inputRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter tags…"
                  className="input pl-9 pr-9 py-2 text-sm"
                  aria-label="Filter tags by name"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter("")}
                    aria-label="Clear tag filter"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-ink-muted hover:text-ink hover:bg-parchment-dark transition-colors"
                  >
                    <X className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable tag chips */}
            <div className="flex-1 overflow-y-auto px-4 pb-4 pt-0.5 overscroll-contain">
              {isLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-ink-muted">
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                  <span className="text-sm">Loading tags…</span>
                </div>
              ) : filteredTags.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-tertiary">
                  {tags && tags.length > 0
                    ? `No tags match "${filter.trim()}".`
                    : "No tags in your library."}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {visibleTags.map((tag) => {
                      const selected = selectedIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggle(tag.id)}
                          aria-pressed={selected}
                          className={cn(
                            "inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
                            selected
                              ? "bg-accent text-white border-accent"
                              : "bg-white text-ink-secondary border-ink hover:border-accent hover:text-ink",
                          )}
                        >
                          {selected ? (
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                          ) : null}
                          <span className="truncate max-w-[180px]">{tag.name}</span>
                          <span
                            className={cn(
                              "text-xs tabular-nums",
                              selected ? "text-white/70" : "text-ink-muted",
                            )}
                          >
                            {tag.bookCount.toLocaleString()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {hiddenCount > 0 && (
                    <p className="mt-3 text-xs text-ink-tertiary">
                      Showing the {visibleTags.length} most-used tags.{" "}
                      {hiddenCount.toLocaleString()} more hidden — use the search box above to find them.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
