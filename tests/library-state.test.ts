import { describe, expect, test } from "bun:test";
import { defaultParseSearch } from "@tanstack/react-router";
import { parseLibrarySearch } from "../src/lib/library-state";

describe("shared library URLs", () => {
  test("accepts numeric search and tag values parsed by the router", () => {
    expect(parseLibrarySearch(defaultParseSearch("?q=1984&tag=2&tag=3"))).toMatchObject({ q: "1984", tag: ["2", "3"] });
    expect(parseLibrarySearch(defaultParseSearch("?q=true&tag=2"))).toMatchObject({ q: "true", tag: ["2"] });
  });
  test("defaults to the bookshelf with the newest books first", () => {
    expect(parseLibrarySearch({})).toEqual({
      q: "", view: "grid", sortBy: "added", sortOrder: "desc", tag: [], format: [],
    });
  });
  test("normalizes equivalent filter URLs without unsafe tag IDs", () => {
    expect(parseLibrarySearch({
      tag: ["003", "2", "3", "0", "-1", "9007199254740993", {}, null],
      format: ["epub", "PDF", "EPUB", "../", "toolongformat"],
    })).toMatchObject({ tag: ["2", "3"], format: ["EPUB", "PDF"] });
  });
  test("preserves valid shareable searches and rejects malformed sorting", () => {
    expect(parseLibrarySearch({ q: "日本語 & books", view: "list", sortBy: "author", sortOrder: "asc" }))
      .toMatchObject({ q: "日本語 & books", view: "list", sortBy: "author", sortOrder: "asc" });
    expect(parseLibrarySearch({ q: {}, view: "invalid", sortBy: "__proto__", sortOrder: null }))
      .toMatchObject({ q: "", view: "grid", sortBy: "added", sortOrder: "desc" });
  });
});
