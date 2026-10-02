import type { SortField, SortOrder } from "@/hooks/useBooksInfinite";

export type LibraryView = "list" | "grid";

export interface LibrarySearch {
  q: string;
  view: LibraryView;
  sortBy: SortField;
  sortOrder: SortOrder;
  tag: string[];
  format: string[];
}

const SORT_FIELDS = new Set(["title", "author", "added", "rating"]);
const firstString = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : undefined;
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

/** Keep shared library URLs safe, deterministic, and equivalent across filter order. */
export function parseLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const tags = asList(search.tag)
    .filter(
      (value): value is string | number =>
        typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)),
    )
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const formats = asList(search.format)
    .filter(
      (value): value is string => typeof value === "string" && /^[A-Za-z0-9]{1,10}$/.test(value),
    )
    .map((value) => value.toUpperCase());
  const sort = firstString(search.sortBy);
  return {
    q:
      (typeof search.q === "number" && Number.isFinite(search.q)) || typeof search.q === "boolean"
        ? String(search.q)
        : (firstString(search.q) ?? ""),
    view: firstString(search.view) === "list" ? "list" : "grid",
    sortBy: sort && SORT_FIELDS.has(sort) ? (sort as SortField) : "added",
    sortOrder: firstString(search.sortOrder) === "asc" ? "asc" : "desc",
    tag: [...new Set(tags)].sort((a, b) => a - b).map(String),
    format: [...new Set(formats)].sort(),
  };
}
