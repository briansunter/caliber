import { describe, expect, test } from "bun:test";
import {
  bookGridLayout,
  bookAnchorScrollTop,
  visibleBookAnchor,
  BOOK_GRID_COLUMN_GAP,
  BOOK_GRID_ROW_GAP,
  BOOK_GRID_METADATA_HEIGHT,
} from "../src/lib/book-list-layout";

describe("virtual bookshelf geometry", () => {
  test("columns fit the real content width, including every horizontal gap", () => {
    for (const width of [288, 320, 375, 620, 840, 1024, 1280, 1580]) {
      const { columns, cardWidth, rowHeight } = bookGridLayout(width);
      expect(columns).toBeGreaterThanOrEqual(2);
      expect(cardWidth * columns + BOOK_GRID_COLUMN_GAP * (columns - 1)).toBeCloseTo(width);
      expect(rowHeight - cardWidth * 1.5 - BOOK_GRID_METADATA_HEIGHT).toBeGreaterThanOrEqual(
        BOOK_GRID_ROW_GAP,
      );
    }
  });

  test("a sidebar width change reflows the grid and its row size together", () => {
    const wide = bookGridLayout(1024);
    const narrow = bookGridLayout(792);
    expect(narrow.columns).toBeLessThan(wide.columns);
    expect(narrow.rowHeight).not.toBe(wide.rowHeight);
  });
});

describe("book scroll anchors", () => {
  const books = Array.from({ length: 40 }, (_, index) => ({ id: index + 1 }));

  test("an anchor round trip accounts for document origin and sticky chrome exactly once", () => {
    const scrollTop = 300 + 2 * 320 - 150 + 17;
    const anchor = visibleBookAnchor(books, 4, 320, 300, scrollTop, 150);
    expect(anchor).toEqual({ id: 9, offset: 17 });
    expect(bookAnchorScrollTop(8, 4, 320, 300, 150, anchor!.offset)).toBe(scrollTop);
  });

  test("the same book restores to its new row after a responsive column change", () => {
    expect(bookAnchorScrollTop(8, 3, 280, 300, 150, 17)).toBe(727);
  });

  test("a position above the list has no stale book anchor", () => {
    expect(visibleBookAnchor(books, 4, 320, 300, 0, 150)).toBeNull();
    expect(visibleBookAnchor([], 4, 320, 300, 500, 150)).toBeNull();
  });

  test("footer positions and old oversized offsets stay within the final row", () => {
    expect(visibleBookAnchor(books, 4, 320, 300, 10000, 150)).toEqual({ id: 37, offset: 319 });
    expect(bookAnchorScrollTop(39, 4, 280, 300, 150, 1000)).toBe(2949);
    expect(bookAnchorScrollTop(0, 4, 280, 20, 150, -20)).toBe(0);
  });
});
