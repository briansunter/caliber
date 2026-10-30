import { expect, test } from "bun:test";
import { preferredDownloadFormat, createDownloadAction } from "../src/lib/quick-download";

test("chooses an available preferred format", () => {
  expect(preferredDownloadFormat(["PDF", "EPUB"])).toBe("EPUB");
  expect(preferredDownloadFormat(["CBZ"])).toBe("CBZ");
  expect(preferredDownloadFormat([])).toBeUndefined();
});

test("prevents repeated requests and reports HTTP failure", async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const request = (() => { calls++; return new Promise<Response>((r) => { resolve = r; }); });
  const action = createDownloadAction(request);
  const first = action(42, "EPUB");
  expect(await action(42, "EPUB")).toBeNull();
  expect(calls).toBe(1);
  resolve(new Response("failed", { status: 500 }));
  await expect(first).rejects.toThrow("Download failed");
});

test("returns the downloaded bytes and requests the existing endpoint", async () => {
  let url = "";
  const request = (async (input: string) => { url = String(input); return new Response("fixture"); });
  const blob = await createDownloadAction(request)(42, "EPUB");
  expect(url).toBe("/api/books/42/download/EPUB");
  expect(await blob?.text()).toBe("fixture");
});
