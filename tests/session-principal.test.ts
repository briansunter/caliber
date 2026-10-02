import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { reconcileSessionPrincipal } from "../src/lib/user";
import {
  clearPendingProgressOutbox,
  fetchBookProgress,
  getLibraryScopeId,
  saveBookProgress,
  setLibraryScopeId,
  setOutboxPrincipal,
} from "../src/lib/reading-progress";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalScope = getLibraryScopeId();
const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];

function setup() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  setLibraryScopeId("lib-session-regression");
  const client = new QueryClient();
  clients.push(client);
  return { client, values };
}

afterEach(() => {
  clearPendingProgressOutbox();
  setOutboxPrincipal(null);
  setLibraryScopeId(originalScope);
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) client.clear();
});

describe("session principal reconciliation", () => {
  test("a refetched identity removes old shelf data and stamps subsequent writes correctly", async () => {
    const { client, values } = setup();
    await reconcileSessionPrincipal(client, 801);
    client.setQueryData(["reading-list"], { items: [{ book: { id: 1 } }] });
    client.setQueryData(["book", 1, 801], { title: "Previous profile" });
    client.setQueryData(["unrelated"], "keep");
    saveBookProgress(1, { format: "PDF", location: "12", percentage: 30, finished: false });
    await reconcileSessionPrincipal(client, 802);
    expect(client.getQueryData<unknown>(["reading-list"])).toBeUndefined();
    expect(client.getQueryData<unknown>(["book", 1, 801])).toBeUndefined();
    expect(client.getQueryData<unknown>(["unrelated"])).toBe("keep");
    saveBookProgress(2, { format: "PDF", location: "9", percentage: 20, finished: false });
    const entries = JSON.parse(values.get("caliber-progress-outbox") ?? "[]");
    expect(entries.find((entry: { bookId: number }) => entry.bookId === 1).userId).toBe(801);
    expect(entries.find((entry: { bookId: number }) => entry.bookId === 2).userId).toBe(802);
  });

  test("401 expiration reconciles anonymously while preserving stale /me data for the error UI", async () => {
    const { client, values } = setup();
    await reconcileSessionPrincipal(client, 803);
    client.setQueryData(["user", "me"], { user: { id: 803 }, authRequired: true });
    client.setQueryData(["reading-list"], { items: [{ book: { id: 3 } }] });
    await reconcileSessionPrincipal(client, null);
    expect(client.getQueryData<unknown>(["reading-list"])).toBeUndefined();
    expect(client.getQueryData<unknown>(["user", "me"])).toEqual({ user: { id: 803 }, authRequired: true });
    saveBookProgress(3, { format: "EPUB", location: "epubcfi(/6/2)", percentage: 4, finished: false });
    const entries = JSON.parse(values.get("caliber-progress-outbox") ?? "[]");
    expect(entries.at(-1).userId).toBeNull();
  });

  test("multiple observers and unchanged /me responses share work without wiping warm caches", async () => {
    const { client } = setup();
    const cancel = spyOn(client, "cancelQueries");
    const first = reconcileSessionPrincipal(client, 804);
    const second = reconcileSessionPrincipal(client, 804);
    expect(second).toBe(first);
    await first;
    client.setQueryData(["reading-list"], { items: ["current"] });
    await reconcileSessionPrincipal(client, 804);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<unknown>(["reading-list"])).toEqual({ items: ["current"] });
  });

  test("a delayed previous reconciliation cannot delete the next identity's fresh cache", async () => {
    const { client } = setup();
    let release!: () => void;
    spyOn(client, "cancelQueries")
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const old = reconcileSessionPrincipal(client, 805);
    expect(await reconcileSessionPrincipal(client, 806)).toBe(true);
    client.setQueryData(["reading-list"], { items: ["new profile"] });
    release();
    expect(await old).toBe(false);
    expect(client.getQueryData<unknown>(["reading-list"])).toEqual({ items: ["new profile"] });
  });

  test("an old reader request stays obsolete even when a session returns to the same user", async () => {
    const { client } = setup();
    await reconcileSessionPrincipal(client, 807);
    let respond!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as unknown as typeof fetch;
    const oldRequest = fetchBookProgress(4, "PDF");
    await reconcileSessionPrincipal(client, null);
    await reconcileSessionPrincipal(client, 807);
    respond(Response.json({ progress: { format: "PDF", location: "40", serverSeq: 9 } }));
    expect(await oldRequest).toBeNull();
  });
});
