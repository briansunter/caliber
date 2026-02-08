import { useQuery } from "@tanstack/react-query";
import type { BookListItem } from "@/types/calibre";

const API_BASE = "/api";

async function searchBooks(query: string): Promise<BookListItem[]> {
  if (!query.trim()) {
    const response = await fetch(`${API_BASE}/books`);
    if (!response.ok) {
      throw new Error("Failed to fetch books");
    }
    return response.json();
  }

  const response = await fetch(`${API_BASE}/books/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error("Failed to search books");
  }
  return response.json();
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ["books", "search", query],
    queryFn: () => searchBooks(query),
    enabled: true,
    staleTime: 1000 * 30, // 30 seconds
  });
}
