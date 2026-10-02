import { describe, expect, test } from "bun:test";
import { getEpubRestoreCfi, getReaderKeyboardAction } from "../src/components/reader-types";

const keyboard = (key: string, flags: Partial<Parameters<typeof getReaderKeyboardAction>[0]> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...flags,
});

describe("reader keyboard shortcuts", () => {
  test("Space advances while Shift+Space goes to the preceding page", () => {
    expect(getReaderKeyboardAction(keyboard(" "))).toBe("next");
    expect(getReaderKeyboardAction(keyboard(" ", { shiftKey: true }))).toBe("previous");
    expect(getReaderKeyboardAction(keyboard("ArrowLeft"))).toBe("previous");
    expect(getReaderKeyboardAction(keyboard("ArrowDown"))).toBe("next");
  });

  test("browser find, history, and platform shortcuts are not intercepted", () => {
    expect(getReaderKeyboardAction(keyboard("f", { ctrlKey: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("f", { metaKey: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("ArrowLeft", { altKey: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("ArrowRight", { shiftKey: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("F", { shiftKey: true }))).toBe("immersive");
  });

  test("composition and already handled events never turn a page", () => {
    expect(getReaderKeyboardAction(keyboard(" ", { isComposing: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("ArrowDown", { defaultPrevented: true }))).toBeNull();
    expect(getReaderKeyboardAction(keyboard("Tab"))).toBeNull();
  });
});

describe("EPUB restore response validation", () => {
  const cfi = "epubcfi(/6/2[chapter]!/4/2/1:0)";

  test("malformed server fields are rejected without throwing or losing a local fallback", () => {
    for (const progress of [null, [], 2, { location: 2, format: "EPUB" }, { location: cfi, format: 7 }, { location: cfi, format: "PDF" }]) {
      expect(getEpubRestoreCfi(progress)).toBeNull();
      expect(getEpubRestoreCfi(progress) ?? getEpubRestoreCfi({ cfi })).toBe(cfi);
    }
  });

  test("accepts matching server positions and legacy local CFI checkpoints", () => {
    expect(getEpubRestoreCfi({ location: cfi, format: "epub" })).toBe(cfi);
    expect(getEpubRestoreCfi({ location: cfi })).toBe(cfi);
    expect(getEpubRestoreCfi({ cfi })).toBe(cfi);
    expect(getEpubRestoreCfi({ location: "epubcfi(/6/2" })).toBeNull();
    expect(getEpubRestoreCfi({ location: "9", format: "EPUB" })).toBeNull();
  });
});
