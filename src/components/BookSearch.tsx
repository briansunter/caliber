import { useState, useEffect, useCallback, memo } from "react";
import { Search } from "lucide-react";

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

  return (
    <div className="relative">
      <Search className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-ink-muted" strokeWidth={1.5} />
      <input
        type="text"
        placeholder="Search books..."
        value={inputValue}
        onChange={handleChange}
        className="input pl-9 sm:pl-11 py-2 sm:py-3 text-sm sm:text-base"
        aria-label="Search books"
      />
    </div>
  );
});
