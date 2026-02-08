import { useQuery } from "@tanstack/react-query";
import type { BookListItem, BookWithMetadata } from "@/types/calibre";

const API_BASE = "/api";

async function fetchBooks(): Promise<BookListItem[]> {
  const response = await fetch(`${API_BASE}/books`);
  if (!response.ok) {
    throw new Error("Failed to fetch books");
  }
  return response.json();
}

async function fetchBookById(id: number): Promise<BookWithMetadata> {
  const response = await fetch(`${API_BASE}/books/${id}`);
  if (!response.ok) {
    throw new Error("Failed to fetch book");
  }
  return response.json();
}

async function searchBooks(query: string): Promise<BookListItem[]> {
  if (!query.trim()) {
    return fetchBooks();
  }
  const response = await fetch(`${API_BASE}/books/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error("Failed to search books");
  }
  return response.json();
}

export function useBooks() {
  return useQuery({
    queryKey: ["books"],
    queryFn: fetchBooks,
  });
}

export function useBook(id: number) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: () => fetchBookById(id),
    enabled: !isNaN(id),
  });
}

export function useSearchBooks(query: string) {
  return useQuery({
    queryKey: ["books", "search", query],
    queryFn: () => searchBooks(query),
    enabled: true,
  });
}
