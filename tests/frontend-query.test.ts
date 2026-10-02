import { describe, expect, test } from "bun:test";
import { flattenBookWindow, type WindowPage } from "../src/lib/infinite-window";
import { shouldRetryQuery } from "../src/lib/query-client";
import { HttpError } from "../src/lib/http";
import { emptyReasonOf, errorStageOf } from "../src/hooks/useBooksInfinite";

type Item = { id: number; title?: string };
const page = (ids: number[], nextCursor: string | null, total?: number): WindowPage<Item> => ({
  items: ids.map((id) => ({ id })), nextCursor, total,
});

describe("retained book windows", () => {
  test("reaching the page limit before eviction does not report missing books", () => {
    const first = page([1, 2], "second", 12);
    const result = flattenBookWindow([first, page([3, 4], "third")], [undefined, "second"], "query", { identity: "query", page: first }, true);
    expect(result.books.map((book) => book.id)).toEqual([1, 2, 3, 4]);
    expect(result.windowTruncated).toBe(false);
    expect(result.totalCount).toBe(12);
  });

  test("the first anchor fills one eviction and retains the first-page-only total", () => {
    const first = page([1, 2], "second", 12);
    const result = flattenBookWindow([page([3, 4], "third")], ["second"], "query", { identity: "query", page: first }, true);
    expect(result.books.map((book) => book.id)).toEqual([1, 2, 3, 4]);
    expect(result.windowTruncated).toBe(false);
    expect(result.totalCount).toBe(12);
  });

  test("later evictions report a gap between the anchor and retained pages", () => {
    const first = page([1, 2], "second", 12);
    const result = flattenBookWindow([page([5, 6], "fourth")], ["third"], "query", { identity: "query", page: first }, true);
    expect(result.books.map((book) => book.id)).toEqual([1, 2, 5, 6]);
    expect(result.windowTruncated).toBe(true);
  });

  test("filters and accounts cannot inherit another query's anchor or total", () => {
    const result = flattenBookWindow([page([5, 6], null)], ["third"], "new-query", { identity: "old-query", page: page([1, 2], "second", 12) }, true);
    expect(result.books.map((book) => book.id)).toEqual([5, 6]);
    expect(result.totalCount).toBeNull();
    expect(result.windowTruncated).toBe(true);
  });

  test("disabling the anchor exposes only the retained window", () => {
    const first = page([1, 2], "second", 12);
    const result = flattenBookWindow([page([3, 4], "third")], ["second"], "query", { identity: "query", page: first }, false);
    expect(result.books.map((book) => book.id)).toEqual([3, 4]);
    expect(result.totalCount).toBe(12);
    expect(result.windowTruncated).toBe(true);
  });

  test("overlapping pages show each book once and favor current metadata", () => {
    const anchor = { identity: "query", page: { items: [{ id: 1, title: "old" }], nextCursor: "second", total: 2 } };
    const result = flattenBookWindow([{ items: [{ id: 1, title: "new" }, { id: 2 }], nextCursor: null }], ["second"], "query", anchor, true);
    expect(result.books).toEqual([{ id: 1, title: "new" }, { id: 2 }]);
    expect(result.windowTruncated).toBe(false);
  });

  test("a refreshed total, including an empty library, overrides the old anchor", () => {
    const result = flattenBookWindow([page([], null, 0)], [undefined], "query", { identity: "query", page: page([1, 2], "second", 12) }, true);
    expect(result.books).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.windowTruncated).toBe(false);
  });
});

describe("query recovery", () => {
  test("auth and validation errors fail immediately instead of repeating requests", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetryQuery(0, new HttpError("error", status, ""))).toBe(false);
    }
  });

  test("transient failures retry at most twice; cancellation never retries", () => {
    for (const error of [new TypeError("Network error"), new HttpError("busy", 503, ""), new HttpError("rate limited", 429, ""), new HttpError("timeout", 408, "")]) {
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(1, error)).toBe(true);
      expect(shouldRetryQuery(2, error)).toBe(false);
    }
    expect(shouldRetryQuery(0, new DOMException("Cancelled", "AbortError"))).toBe(false);
  });

  test("empty-state reasons distinguish unavailable data from empty results", () => {
    const args = { booksLength: 0, isLoading: false, error: null, searchQuery: "", tagIds: [] };
    expect(emptyReasonOf(args)).toBe("empty-library");
    expect(emptyReasonOf({ ...args, formats: ["EPUB"] })).toBe("no-matches");
    expect(emptyReasonOf({ ...args, error: new HttpError("Expired session", 401, "") })).toBe("auth-expired");
    expect(emptyReasonOf({ ...args, error: new TypeError("Failed to fetch") })).toBe("offline");
    expect(emptyReasonOf({ ...args, error: new HttpError("Server failure", 500, "") })).toBeNull();
    expect(emptyReasonOf({ ...args, booksLength: 1, error: new TypeError("Failed to fetch") })).toBeNull();
    expect(errorStageOf(new Error("failed"), true, true)).toBe("next-page");
  });
});
