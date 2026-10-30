import { parseLibrarySearch, type LibrarySearch } from "./library-state";

export const LIBRARY_RETURN_KEY = "caliber-library-return";

export function libraryReturnSearch(value: string | null): LibrarySearch {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parseLibrarySearch(parsed as Record<string, unknown>);
    }
  } catch {}
  return parseLibrarySearch({});
}
