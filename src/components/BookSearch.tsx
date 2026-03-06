import { useState, useEffect, useCallback, memo } from "react";
import { Search, X } from "lucide-react";

interface BookSearchProps {
  onSearch: (query: string) => void;
  initialValue?: string;
}

export const BookSearch = memo(function BookSearch({ onSearch, initialValue = "" }: BookSearchProps) {
  const [inputValue, setInputValue] = useState(initialValue);

  useEffect(() => {
    const timer = setTimeout(() => {
      onSearch(inputValue);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputValue, onSearch]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleClear = useCallback(() => {
    setInputValue("");
  }, []);

  return (
    <div className="relative">
      <Search className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-ink-muted" strokeWidth={1.5} />
      <input
        type="text"
        placeholder="Search books..."
        value={inputValue}
        onChange={handleChange}
        className="input pl-9 sm:pl-11 pr-9 sm:pr-11 py-2 sm:py-3 text-base"
        aria-label="Search books"
      />
      {inputValue && (
        <button
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
