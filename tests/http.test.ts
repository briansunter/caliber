import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchJson, HttpError } from "../src/lib/http";

const fetchSpy = spyOn(globalThis, "fetch");
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterAll(() => fetchSpy.mockRestore());

afterEach(() => {
  fetchSpy.mockReset();
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("JSON request headers", () => {
  test("preserves Headers instances, caller Accept, and request options", async () => {
    const controller = new AbortController();
    const headers = new Headers({ Authorization: "Bearer example", Accept: "application/vnd.test+json" });
    fetchSpy.mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer example");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.test+json");
      expect(init?.signal).toBe(controller.signal);
      expect(init?.cache).toBe("no-cache");
      return Response.json({ value: 1 });
    }) as typeof fetch);
    expect(await fetchJson<{ value: number }>("/api/example", { headers, signal: controller.signal })).toEqual({ value: 1 });
    expect(headers.get("Accept")).toBe("application/vnd.test+json");
  });

  test("preserves tuple headers and supplies the default JSON Accept", async () => {
    fetchSpy.mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Example")).toBe("tuple-value");
      expect(headers.get("Accept")).toBe("application/json");
      return Response.json({ ok: true });
    }) as typeof fetch);
    await fetchJson("/api/example", { headers: [["X-Example", "tuple-value"]] });
  });
});

describe("malformed HTTP error responses", () => {
  test("a malformed 401 remains an auth error and dispatches session recovery once", async () => {
    const events = new EventTarget();
    let unauthorized = 0;
    events.addEventListener("caliber:unauthorized", () => { unauthorized += 1; });
    Object.defineProperty(globalThis, "window", { configurable: true, value: events });
    fetchSpy.mockResolvedValue(new Response("{\"error\":", { status: 401, headers: { "Content-Type": "application/json" } }));
    try {
      await fetchJson("/api/example");
      throw new Error("Expected an authentication failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(401);
      expect((error as HttpError).message).toBe("Request failed with status 401");
    }
    expect(unauthorized).toBe(1);
  });

  test("preserves server failure status and valid error messages", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not JSON", { status: 503, headers: { "Content-Type": "application/json" } }));
    await expect(fetchJson("/api/example")).rejects.toMatchObject({ name: "HttpError", status: 503 });
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "Invalid input" }, { status: 422 }));
    await expect(fetchJson("/api/example")).rejects.toMatchObject({ name: "HttpError", status: 422, message: "Invalid input" });
  });

  test("does not accept invalid successful JSON or hide cancellation", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not JSON", { headers: { "Content-Type": "application/json" } }));
    await expect(fetchJson("/api/example")).rejects.toBeInstanceOf(SyntaxError);
    fetchSpy.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    await expect(fetchJson("/api/example")).rejects.toMatchObject({ name: "AbortError" });
  });
});
