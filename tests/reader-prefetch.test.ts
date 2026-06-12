import { describe, expect, test } from "bun:test";
import { prefetchOrder } from "../src/components/reader-types";

describe("prefetchOrder", () => {
  test("closest first, forward before backward at equal distance", () => {
    expect(prefetchOrder(10, 1, 100, 6, 2)).toEqual([11, 9, 12, 8, 13, 14, 15, 16]);
  });

  test("clamps at the start of the book", () => {
    expect(prefetchOrder(1, 1, 100, 6, 2)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(prefetchOrder(2, 1, 100, 6, 2)).toEqual([3, 1, 4, 5, 6, 7, 8]);
  });

  test("clamps at the end of the book", () => {
    expect(prefetchOrder(100, 1, 100, 6, 2)).toEqual([99, 98]);
    expect(prefetchOrder(99, 1, 100, 6, 2)).toEqual([100, 98, 97]);
  });

  test("single-page book warms nothing", () => {
    expect(prefetchOrder(1, 1, 1, 6, 2)).toEqual([]);
  });

  test("never includes the current page or out-of-range pages", () => {
    for (let current = 1; current <= 10; current += 1) {
      const order = prefetchOrder(current, 1, 10);
      expect(order).not.toContain(current);
      for (const p of order) {
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(10);
      }
      expect(new Set(order).size).toBe(order.length);
    }
  });
});
