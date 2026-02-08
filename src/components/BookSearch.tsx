import { useState, useEffect, useCallback, memo } from "react";
import { Search } from "lucide-react";

interface BookSearchProps {
  onSearch: (query: string) => void;
}

export const BookSearch = memo(function BookSearch({ onSearch }: BookSearchProps) {
  const [inputValue, setInputValue] = useState("");

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
      <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-muted" />
      <input
        type="text"
        placeholder="Search books by title, author, or series..."
        value={inputValue}
        onChange={handleChange}
        className="input pl-10"
        aria-label="Search books"
      />
    </div>
  );
});
