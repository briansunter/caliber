import { useState, useEffect, useCallback, useRef, memo } from "react";
import { Search, X } from "lucide-react";

interface BookSearchProps {
  onSearch: (query: string) => void;
  initialValue?: string;
}

export const BookSearch = memo(function BookSearch({
  onSearch,
  initialValue = "",
}: BookSearchProps) {
  const [inputValue, setInputValue] = useState(initialValue);
  const isMounted = useRef(false);

  // Keep the input in sync when initialValue changes from outside (e.g.
  // back-navigation restores a different ?q= from the URL). Typing only
  // flows outward through the debounced onSearch below.
  useEffect(() => {
    setInputValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    // The URL is the source of truth: when the input already matches it
    // (e.g. a remount that adopted a transiently stale initialValue during
    // a history pop, or the echo of our own just-committed write) there is
    // nothing to propagate. Without this guard a stale "" would be
    // debounce-written back to the URL and permanently clear ?q=.
    if (inputValue === initialValue) return;
    const timer = setTimeout(() => {
      onSearch(inputValue);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputValue, initialValue, onSearch]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleClear = useCallback(() => {
    setInputValue("");
    // Clearing is explicit intent: notify immediately instead of waiting
    // out the debounce so results reset without a laggy round-trip.
    onSearch("");
  }, [onSearch]);

  return (
    <div className="relative">
      <Search
        className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-ink-muted"
        strokeWidth={1.5}
      />
      <input
        type="search"
        name="q"
        autoComplete="off"
        inputMode="search"
        placeholder="Search books…"
        value={inputValue}
        onChange={handleChange}
        className="input pl-9 sm:pl-11 pr-9 sm:pr-11 py-2 sm:py-3 text-base"
        aria-label="Search books"
      />
      {inputValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-ink-muted hover:text-ink hover:bg-parchment-dark transition-colors"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
});
