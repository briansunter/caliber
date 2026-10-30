import { expect, test } from "bun:test";
import { libraryReturnSearch } from "../src/lib/library-return";

test("restores valid library filters and view after reader navigation", () => {
  expect(libraryReturnSearch('{"q":"maps","view":"list","sortBy":"title","sortOrder":"asc","tag":["4"],"format":["EPUB"]}')).toEqual({ q: "maps", view: "list", sortBy: "title", sortOrder: "asc", tag: ["4"], format: ["EPUB"] });
  expect(libraryReturnSearch('{"view":"grid"}').view).toBe("grid");
});

test("falls back safely for direct links or untrusted stored destinations", () => {
  for (const value of [null, 'https://example.com', '{"to":"https://example.com"}', '[]']) {
    expect(libraryReturnSearch(value)).toEqual({ q: "", view: "grid", sortBy: "added", sortOrder: "desc", tag: [], format: [] });
  }
});
