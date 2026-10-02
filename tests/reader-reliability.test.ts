import { afterEach, describe, expect, test } from "bun:test";
import { normalizeReaderPage, pdfRenderRatio } from "../src/components/reader-types";
import { waitForReaderImage } from "../src/lib/reader-image";
import {
  fetchBookProgress,
  getLibraryScopeId,
  getKnownDeletionSeq,
  getKnownServerSeq,
  progressPosKey,
  readScopedPos,
  setOutboxPrincipal,
  setLibraryScopeId,
} from "../src/lib/reading-progress";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = globalThis.fetch;
const originalLibraryScope = getLibraryScopeId();

function installStorage(): Map<string, string> {
  const values = new Map<string, string>([["caliber-library-id", "lib-reader-test"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

afterEach(() => {
  setLibraryScopeId(originalLibraryScope);
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  globalThis.fetch = originalFetch;
  setOutboxPrincipal(null);
});

describe("reader positions", () => {
  test("canonical library identity survives blocked or full local storage", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage blocked", "SecurityError"); },
    });
    setLibraryScopeId("lib-storage-blocked");
    expect(getLibraryScopeId()).toBe("lib-storage-blocked");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "lib-old-quota",
        setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
      },
    });
    setLibraryScopeId("lib-new-quota");
    expect(getLibraryScopeId()).toBe("lib-new-quota");
    expect(getLibraryScopeId()).toBe("lib-new-quota");
  });
  test("invalid checkpoints fall back and oversized positions clamp to the current book", () => {
    for (const value of [null, undefined, {}, [], -4, 0, 2.5, Number.NaN, Infinity, "12junk", ""]) {
      expect(normalizeReaderPage(value, 20)).toBe(1);
    }
    expect(normalizeReaderPage(999, 12)).toBe(12);
    expect(normalizeReaderPage("12", 30)).toBe(12);
    expect(normalizeReaderPage(1, 0)).toBe(1);
  });

  test("malformed and non-object local positions never escape the fallback", () => {
    const storage = installStorage();
    const fallback = { page: 1 };
    const key = progressPosKey(41, "pdf");
    for (const raw of ["null", "[]", '"page12"', "42", "{broken"]) {
      storage.set(key, raw);
      expect(readScopedPos(41, "pdf", fallback)).toEqual(fallback);
    }
    storage.set(key, '{"page":12}');
    expect(readScopedPos(41, "pdf", fallback)).toEqual({ page: 12 });
  });

  test("a progress request cannot restore the previous account after a switch", async () => {
    installStorage();
    setOutboxPrincipal(7101);
    let respond!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as unknown as typeof fetch;
    const request = fetchBookProgress(142, "PDF");
    setOutboxPrincipal(7102);
    respond(Response.json({ progress: { format: "PDF", location: "9", serverSeq: 33 }, deletionSeq: 4 }));
    expect(await request).toBeNull();
    expect(getKnownServerSeq(7102, "lib-reader-test", 142, "PDF")).toBeNull();
    expect(getKnownDeletionSeq(7102, "lib-reader-test", 142, "PDF")).toBeNull();
  });

  test("a progress request cannot seed revision data into a different library", async () => {
    const storage = installStorage();
    setOutboxPrincipal(7103);
    let respond!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as unknown as typeof fetch;
    const request = fetchBookProgress(143, "EPUB");
    storage.set("caliber-library-id", "lib-another-reader-test");
    respond(Response.json({ progress: { format: "EPUB", location: "epubcfi(/6/2)", serverSeq: 34 }, deletionSeq: 5 }));
    expect(await request).toBeNull();
    expect(getKnownServerSeq(7103, "lib-another-reader-test", 143, "EPUB")).toBeNull();
  });
});

describe("reader image loading", () => {
  test("a failed complete image is rejected on browsers without decode", async () => {
    const image = { complete: true, naturalWidth: 0 } as HTMLImageElement;
    await expect(waitForReaderImage(image)).rejects.toThrow("Image failed to load");
  });

  test("successful images support both decode and the legacy load event", async () => {
    let decoded = false;
    const modern = { decode: async () => { decoded = true; } } as HTMLImageElement;
    await waitForReaderImage(modern);
    expect(decoded).toBe(true);
    const legacy = Object.assign(new EventTarget(), { complete: false, naturalWidth: 300 });
    const waiting = waitForReaderImage(legacy as unknown as HTMLImageElement);
    legacy.dispatchEvent(new Event("load"));
    await waiting;
  });

  test("legacy image errors reject rather than being checkpointed as displayed", async () => {
    const image = Object.assign(new EventTarget(), { complete: false, naturalWidth: 0 });
    const waiting = waitForReaderImage(image as unknown as HTMLImageElement);
    image.dispatchEvent(new Event("error"));
    await expect(waiting).rejects.toThrow("Image failed to load");
  });
});

describe("PDF canvas limits", () => {
  test("ordinary pages retain retina resolution", () => {
    expect(pdfRenderRatio(800, 1100, 2)).toBe(2);
  });

  test("very large PDFs stay inside dimension and memory limits", () => {
    for (const [width, height] of [[20000, 30000], [500, 80000], [9000, 9000]]) {
      const ratio = pdfRenderRatio(width!, height!, 3);
      expect(width! * ratio).toBeLessThanOrEqual(8192);
      expect(height! * ratio).toBeLessThanOrEqual(8192);
      expect(width! * height! * ratio * ratio).toBeLessThanOrEqual(16_777_216.01);
    }
  });
});
