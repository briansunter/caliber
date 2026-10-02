import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPathContentType } from "../src/lib/book-files";
import { matchesEntityTag, parseByteRange, serveLocalFile } from "../src/lib/file-response";
import { JobSemaphore } from "../src/lib/job-semaphore";
import { isPageCacheMeta } from "../src/lib/page-cache-meta";
import { ByteLruCache } from "../src/lib/byte-lru-cache";

describe("file responses", () => {
  test("rejects trailing syntax and offsets outside safe integer precision", () => {
    for (const range of ["bytes=0-10-20", "bytes=-", "bytes=0-1,2-3", "bytes=0-9007199254740992"]) {
      expect(parseByteRange(range, 100)).toBeNull();
    }
    expect(parseByteRange("bytes=0-99", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=-200", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  test("matches weak and multiple If-None-Match validators", () => {
    expect(matchesEntityTag('"other", W/"current"', '"current"')).toBe(true);
    expect(matchesEntityTag("*", '"current"')).toBe(true);
    expect(matchesEntityTag('W/"other"', '"current"')).toBe(false);
  });

  test("does not reuse another source's validator when file metadata matches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caliber-file-identity-"));
    const firstPath = join(directory, "first.pdf");
    const secondPath = join(directory, "second.pdf");
    const modified = new Date("2020-01-01T00:00:00Z");
    writeFileSync(firstPath, "first book");
    writeFileSync(secondPath, "other book");
    utimesSync(firstPath, modified, modified);
    utimesSync(secondPath, modified, modified);
    try {
      const first = await serveLocalFile(new Request("http://localhost/book"), firstPath, {
        contentType: "application/pdf",
      });
      const oldTag = first.headers.get("etag") ?? "";
      await first.arrayBuffer();
      const second = await serveLocalFile(new Request("http://localhost/book", {
        headers: { "If-None-Match": oldTag },
      }), secondPath, { contentType: "application/pdf" });
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).not.toBe(oldTag);
      expect(await second.text()).toBe("other book");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("streams a complete file when If-Range is stale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caliber-file-response-"));
    const path = join(directory, "book.pdf");
    const bytes = Buffer.alloc(256 * 1024, 0x41);
    writeFileSync(path, bytes);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => serveLocalFile(req, path, { contentType: "application/pdf" }),
    });
    try {
      const response = await fetch(server.url, {
        headers: { Range: "bytes=0-99", "If-Range": '"stale"' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
      const etag = response.headers.get("etag") ?? "";
      const conditional = await fetch(server.url, {
        headers: { Range: "bytes=0-99", "If-None-Match": `W/${etag}` },
      });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("reader cache metadata", () => {
  const meta = {
    source: { size: 123, mtimeMs: 1000 },
    pageCount: 1,
    pages: [{ index: 1, name: "Page 1", fileName: "00001.png", contentType: "image/png" }],
  };

  test("accepts valid metadata without requiring lazy page files to exist", () => {
    expect(isPageCacheMeta(meta)).toBe(true);
    expect(getPathContentType("page.avif")).toBe("image/avif");
  });

  test("rejects corrupt page arrays, source signatures, and paths", () => {
    expect(isPageCacheMeta({ ...meta, pages: null })).toBe(false);
    expect(isPageCacheMeta({ ...meta, source: null })).toBe(false);
    expect(isPageCacheMeta({ ...meta, pageCount: 2 })).toBe(false);
    expect(isPageCacheMeta({ ...meta, pages: [{ ...meta.pages[0], index: 2 }] })).toBe(false);
    expect(isPageCacheMeta({ ...meta, pages: [{ ...meta.pages[0], fileName: "../secret.png" }] })).toBe(false);
  });
});

describe("archive concurrency", () => {
  test("reserves released slots for queued jobs without allowing newcomers to overtake", async () => {
    const semaphore = new JobSemaphore(1);
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = semaphore.run(() => gate);
    const queued = semaphore.run(async () => { order.push("queued"); });
    // This callback runs after the first job releases its slot but before
    // the queued await resumes, reproducing the old handoff race.
    const newcomer = gate.then(() => semaphore.run(async () => { order.push("newcomer"); }));
    releaseFirst();
    await Promise.all([first, queued, newcomer]);
    expect(order).toEqual(["queued", "newcomer"]);
  });

  test("releases the slot when a job fails", async () => {
    const semaphore = new JobSemaphore(1);
    await expect(semaphore.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await semaphore.run(async () => "next job")).toBe("next job");
  });
});

describe("archive memory limits", () => {
  test("evicts the least recently used archive to honor aggregate bytes", () => {
    const cache = new ByteLruCache<string, string>(3, 128);
    cache.set("first", "first archive", 50);
    cache.set("second", "second archive", 50);
    expect(cache.get("first")).toBe("first archive");
    cache.set("third", "third archive", 50);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("first archive");
    expect(cache.get("third")).toBe("third archive");
  });

  test("does not retain oversized archives and releases replaced byte accounting", () => {
    const cache = new ByteLruCache<string, string>(3, 128);
    cache.set("first", "small archive", 20);
    cache.set("first", "oversized replacement", 200);
    cache.set("second", "fits remaining quota", 120);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe("fits remaining quota");
    cache.delete("second");
    cache.set("third", "fits full quota", 128);
    expect(cache.get("third")).toBe("fits full quota");
  });

  test("honors entry capacity independently of bytes", () => {
    const cache = new ByteLruCache<string, string>(2, 128);
    cache.set("first", "first", 1);
    cache.set("second", "second", 1);
    cache.set("third", "third", 1);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe("second");
    expect(cache.get("third")).toBe("third");
  });
});
