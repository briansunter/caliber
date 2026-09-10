import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FileType, X, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FormatSummary } from "@/hooks/useBooksInfinite";
import { useDialogFocusTrap } from "./ReaderChrome";

interface FormatFilterProps {
  formats: FormatSummary[] | undefined;
  selected: string[];
  onChange: (formats: string[]) => void;
  isLoading?: boolean;
}

// Mobile bottom-sheet breakpoint — below this the panel renders as a sheet,
// at/above it renders as a desktop dropdown. Must match the `md:` classes below.
const MOBILE_MAX = "(max-width: 767px)";

export const FormatFilter = memo(function FormatFilter({
  formats,
  selected,
  onChange,
  isLoading,
}: FormatFilterProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selectedCount = selected.length;
  const active = open || selectedCount > 0;

  const close = useCallback(() => setOpen(false), []);

  // Modal dialog semantics: aria-modal + focus trap + Esc + return focus
  // to the trigger (shared trap with TagFilter).
  useDialogFocusTrap(open, panelRef, close, triggerRef);

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

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((x) => x !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  const clearAll = () => onChange([]);

  const triggerLabel = `${selectedCount > 0 ? `Filter by file type, ${selectedCount} selected` : "Filter by file type"}`;

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 sm:px-3.5 h-10 sm:h-[46px] min-w-[44px] text-sm font-medium transition-colors",
          active
            ? "bg-accent text-white border-accent"
            : "bg-surface text-ink-secondary border-ink hover:text-ink",
        )}
      >
        <FileType className="h-4 w-4" strokeWidth={1.75} />
        <span className="hidden sm:inline">Formats</span>
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
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Filter by file type"
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 flex flex-col bg-surface border border-ink shadow-xl",
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
              <h2 className="text-base font-semibold text-ink">Filter by file type</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close file type filter"
                className="p-1.5 -mr-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-parchment-dark transition-colors"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>

            {/* OR hint + selection summary */}
            <div className="flex items-center justify-between gap-2 px-4 pb-2.5">
              <p className="text-xs text-ink-tertiary">
                Match <span className="font-semibold text-ink-secondary">any</span> selected type
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

            {/* Scrollable format chips */}
            <div className="flex-1 overflow-y-auto px-4 pb-4 pt-0.5 overscroll-contain">
              {isLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-ink-muted">
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                  <span className="text-sm">Loading file types…</span>
                </div>
              ) : !formats || formats.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-tertiary">
                  No file types in your library.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {formats.map((format) => {
                    const isSelected = selected.includes(format.name);
                    return (
                      <button
                        key={format.name}
                        type="button"
                        onClick={() => toggle(format.name)}
                        aria-pressed={isSelected}
                        className={cn(
                          "inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
                          isSelected
                            ? "bg-accent text-white border-accent"
                            : "bg-surface text-ink-secondary border-ink hover:border-accent hover:text-ink",
                        )}
                      >
                        {isSelected ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                        <span className="font-mono uppercase">{format.name}</span>
                        <span
                          className={cn(
                            "text-xs tabular-nums",
                            isSelected ? "text-white/70" : "text-ink-muted",
                          )}
                        >
                          {format.bookCount.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
