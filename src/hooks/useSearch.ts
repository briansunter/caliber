import { useQuery } from "@tanstack/react-query";
import type { BookListItem } from "@/types/calibre";
import { fetchJson } from "@/lib/http";

const API_BASE = "/api";

interface CursorResult<T> {
  items: T[];
}

async function searchBooks(query: string, signal?: AbortSignal): Promise<BookListItem[]> {
  if (!query.trim()) {
    const result = await fetchJson<CursorResult<BookListItem>>(`${API_BASE}/books?limit=100`, {
      signal,
    });
    return result.items;
  }

  const result = await fetchJson<CursorResult<BookListItem>>(
    `${API_BASE}/books/search?q=${encodeURIComponent(query)}&limit=100`,
    { signal }
  );
  return result.items;
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ["books", "search", query],
    queryFn: ({ signal }) => searchBooks(query, signal),
    enabled: true,
    staleTime: 1000 * 30, // 30 seconds
  });
}
