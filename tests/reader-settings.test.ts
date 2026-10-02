import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  normalizeReaderSettings,
  resetReaderSettings,
  saveReaderSettings,
} from "../src/lib/reader-settings";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  resetReaderSettings();
});

describe("reader settings", () => {
  test("clamps memory settings and replaces nonfinite values with safe defaults", () => {
    expect(
      normalizeReaderSettings({ prefetchAhead: 100, prefetchBehind: -4, maxRenderScale: 8 }),
    ).toEqual({ ...DEFAULT_READER_SETTINGS, prefetchAhead: 8, prefetchBehind: 0, maxRenderScale: 3 });
    expect(
      normalizeReaderSettings({
        prefetchAhead: Number.NaN,
        prefetchBehind: Number.POSITIVE_INFINITY,
        maxRenderScale: Number.NaN,
      }),
    ).toEqual(DEFAULT_READER_SETTINGS);
  });

  test("partial updates preserve other preferences", () => {
    resetReaderSettings();
    saveReaderSettings({ defaultLoadMode: "full", prefetchAhead: 4 });
    expect(saveReaderSettings({ maxRenderScale: 1.5 })).toEqual({
      ...DEFAULT_READER_SETTINGS,
      defaultLoadMode: "full",
      prefetchAhead: 4,
      maxRenderScale: 1.5,
    });
  });

  test("keeps in-memory preferences when localStorage access is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    });
    resetReaderSettings();
    const saved = saveReaderSettings({ prefetchAhead: 5, defaultLoadMode: "full" });
    expect(loadReaderSettings()).toBe(saved);
    expect(loadReaderSettings().prefetchAhead).toBe(5);
  });

  test("uses a stable snapshot between changes and restores defaults", () => {
    const saved = saveReaderSettings({ prefetchAhead: 7 });
    expect(loadReaderSettings()).toBe(saved);
    expect(loadReaderSettings()).toBe(loadReaderSettings());
    expect(resetReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });
});
