import { useQuery } from "@tanstack/react-query";
import type { BookListItem, BookWithMetadata } from "@/types/calibre";
import { fetchJson } from "@/lib/http";

const API_BASE = "/api";

interface CursorResult<T> {
  items: T[];
}

async function fetchBooks(signal?: AbortSignal): Promise<BookListItem[]> {
  const result = await fetchJson<CursorResult<BookListItem>>(`${API_BASE}/books?limit=100`, {
    signal,
  });
  return result.items;
}

async function fetchBookById(id: number, signal?: AbortSignal): Promise<BookWithMetadata> {
  return fetchJson<BookWithMetadata>(`${API_BASE}/books/${id}`, { signal });
}

async function searchBooks(query: string, signal?: AbortSignal): Promise<BookListItem[]> {
  if (!query.trim()) {
    return fetchBooks(signal);
  }
  const result = await fetchJson<CursorResult<BookListItem>>(
    `${API_BASE}/books/search?q=${encodeURIComponent(query)}&limit=100`,
    { signal }
  );
  return result.items;
}

export function useBooks() {
  return useQuery({
    queryKey: ["books"],
    queryFn: ({ signal }) => fetchBooks(signal),
  });
}

export function useBook(id: number) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: ({ signal }) => fetchBookById(id, signal),
    enabled: !Number.isNaN(id),
  });
}

export function useSearchBooks(query: string) {
  return useQuery({
    queryKey: ["books", "search", query],
    queryFn: ({ signal }) => searchBooks(query, signal),
    enabled: true,
  });
}
