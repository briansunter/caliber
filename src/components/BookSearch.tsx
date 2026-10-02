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
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composingRef = useRef(false);
  const submittedValueRef = useRef<string | null>(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // URL navigation cancels pending typing so an older draft cannot overwrite
  // the restored search. Only direct edits schedule an outward search update.
  useEffect(() => {
    const isOwnUpdate = initialValue === submittedValueRef.current;
    submittedValueRef.current = null;
    // A URL echo must not erase text typed after the previous debounce fired.
    if (isOwnUpdate) return;
    cancelPending();
    setInputValue(initialValue);
  }, [initialValue, cancelPending]);
  useEffect(() => cancelPending, [cancelPending]);

  const submitSearch = useCallback((value: string) => {
    submittedValueRef.current = value;
    onSearchRef.current(value);
  }, []);

  const scheduleSearch = useCallback(
    (value: string) => {
      cancelPending();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        submitSearch(value);
      }, 300);
    },
    [cancelPending, submitSearch],
  );

  const handleClear = () => {
    cancelPending();
    setInputValue("");
    submitSearch("");
    inputRef.current?.focus();
  };

  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-[18px] w-[18px] text-ink-muted"
        strokeWidth={1.75}
      />
      <input
        ref={inputRef}
        type="search"
        name="q"
        autoComplete="off"
        inputMode="search"
        placeholder="Search title, author, series…"
        value={inputValue}
        onChange={(event) => {
          const value = event.target.value;
          setInputValue(value);
          if (!composingRef.current) scheduleSearch(value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
          cancelPending();
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          scheduleSearch(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && !composingRef.current) {
            event.preventDefault();
            cancelPending();
            submitSearch(inputValue);
          }
        }}
        className="input min-h-11 pl-11 pr-11 py-2.5 text-base"
        aria-label="Search books by title, author or series"
      />
      {inputValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-parchment-dark transition-colors"
          aria-label="Clear search"
        >
          <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
});
