import type { BookListItem } from "./calibre-optimized";

export function formatBook(book: BookListItem): string {
  const parts = [
    `"${book.title}"`,
    book.authors.length > 0 ? `by ${book.authors.join(", ")}` : "",
    book.series ? `(Book ${book.series_index} in ${book.series})` : "",
    book.formats.length > 0 ? `[${book.formats.join(", ")}]` : "",
  ];
  return parts.filter(Boolean).join(" ");
}
