import { describe, expect, test } from "bun:test";
import { MAX_REQUEST_BODY_BYTES, readRequestJson, RequestBodyTooLargeError } from "../src/lib/request-body";

const encoder = new TextEncoder();

function streamedRequest(chunks: Uint8Array[], headers?: HeadersInit) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    request: new Request("http://localhost/api/example", { method: "POST", headers, body }),
    state: () => ({ reads, cancelled }),
  };
}

describe("bounded JSON request streams", () => {
  test("decodes UTF-8 split across tiny chunks at the exact byte limit", async () => {
    const expected = { text: "雪é" };
    const bytes = encoder.encode(JSON.stringify(expected));
    const stream = streamedRequest(Array.from(bytes, byte => new Uint8Array([byte])));
    expect(await readRequestJson(stream.request, bytes.length)).toEqual(expected);
    expect(stream.state().cancelled).toBe(false);
  });

  test("rejects unknown-length oversized chunks immediately and cancels the source", async () => {
    const stream = streamedRequest([new Uint8Array(700_000), new Uint8Array(700_000), encoder.encode("ignored")]);
    await expect(readRequestJson(stream.request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(stream.state()).toEqual({ reads: 2, cancelled: true });
  });

  test("a smaller Content-Length cannot bypass the actual byte limit", async () => {
    const stream = streamedRequest([encoder.encode('"é"')], { "Content-Length": "1" });
    await expect(readRequestJson(stream.request, 3)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(stream.state().cancelled).toBe(true);
  });

  test("rejects an oversized declared length without reading or parsing", async () => {
    const stream = streamedRequest([encoder.encode("{}")], { "Content-Length": String(MAX_REQUEST_BODY_BYTES + 1) });
    await expect(readRequestJson(stream.request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(stream.state()).toEqual({ reads: 0, cancelled: true });
  });

  test("keeps empty and malformed JSON failures separate from size failures", async () => {
    await expect(readRequestJson(new Request("http://localhost"))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readRequestJson(streamedRequest([encoder.encode("{")]).request)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("a slow source's cancel callback cannot hold up rejection", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(10)); },
      cancel() { return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost", { method: "POST", body });
    const result = await Promise.race([
      readRequestJson(request, 1).catch(error => error),
      Bun.sleep(100).then(() => "stalled"),
    ]);
    expect(result).toBeInstanceOf(RequestBodyTooLargeError);
  });
});
