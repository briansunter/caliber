export const BOOK_GRID_COLUMN_GAP = 24;
export const BOOK_GRID_ROW_GAP = 28;
export const BOOK_GRID_METADATA_HEIGHT = 104;
const BOOK_GRID_MIN_WIDTH = 148;

export function bookGridLayout(width: number) {
  const safeWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const columns = Math.max(
    2,
    Math.floor((safeWidth + BOOK_GRID_COLUMN_GAP) / (BOOK_GRID_MIN_WIDTH + BOOK_GRID_COLUMN_GAP)),
  );
  const cardWidth = Math.max(0, (safeWidth - BOOK_GRID_COLUMN_GAP * (columns - 1)) / columns);
  return {
    columns,
    cardWidth,
    rowHeight: Math.ceil(cardWidth * 1.5 + BOOK_GRID_METADATA_HEIGHT + BOOK_GRID_ROW_GAP),
  };
}

export interface BookScrollAnchor {
  id: number;
  offset: number;
}

export function visibleBookAnchor(
  books: ReadonlyArray<{ id: number }>,
  columns: number,
  rowHeight: number,
  listOrigin: number,
  scrollTop: number,
  stickyOffset: number,
): BookScrollAnchor | null {
  const relativeTop = scrollTop + stickyOffset - listOrigin;
  if (relativeTop < 0 || books.length === 0 || columns < 1 || rowHeight <= 0) return null;
  const row = Math.min(Math.floor(relativeTop / rowHeight), Math.ceil(books.length / columns) - 1);
  const book = books[row * columns];
  if (!book) return null;
  return { id: book.id, offset: Math.min(relativeTop - row * rowHeight, rowHeight - 1) };
}

export function bookAnchorScrollTop(
  bookIndex: number,
  columns: number,
  rowHeight: number,
  listOrigin: number,
  stickyOffset: number,
  offset: number,
): number {
  const row = Math.floor(bookIndex / columns);
  const safeOffset = Math.min(Math.max(0, offset), Math.max(0, rowHeight - 1));
  return Math.max(0, listOrigin + row * rowHeight - stickyOffset + safeOffset);
}
