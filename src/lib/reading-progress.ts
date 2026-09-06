import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";
import { queryClient } from "./query-client";

export interface ProgressRecord {
  bookId: number;
  format: string;
  location: string | null;
  percentage: number;
  finished: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface ReadingListBook {
  id: number;
  title: string;
  authors: string[];
  series: string | null;
  series_index: number;
  formats: string[];
  has_cover: boolean;
}

export interface ReadingListItem {
  book: ReadingListBook;
  progress: {
    format: string;
    percentage: number;
    finished: boolean;
    updatedAt: number;
  };
}

export type ReadingSort = "recent" | "title" | "progress";

// F04: scope local position keys by library so switching libraries never
// restores another library's page. Cached synchronously; refreshed from
// /api/config/library when available, else falls back to 'default'.
const LIB_SCOPE_KEY = "caliber-library-id";

export function getLibraryScopeId(): string {
  try {
    if (typeof localStorage === "undefined") return "default";
    return localStorage.getItem(LIB_SCOPE_KEY) || "default";
  } catch {
    return "default";
  }
}

export function progressPosKey(bookId: number, kind: string): string {
  return `caliber-pos-${getLibraryScopeId()}-${bookId}-${kind}`;
}

// Legacy key fallback for positions saved before library scoping.
export function legacyPosKey(bookId: number, kind: string): string {
  return `caliber-pos-${bookId}-${kind}`;
}

export function readScopedPos<T>(bookId: number, kind: string, fallback: T): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const scoped = localStorage.getItem(progressPosKey(bookId, kind));
    if (scoped) return JSON.parse(scoped) as T;
    const legacy = localStorage.getItem(legacyPosKey(bookId, kind));
    return legacy ? (JSON.parse(legacy) as T) : fallback;
  } catch {
    return fallback;
  }
}

let libScopeRefreshInFlight = false;
export function refreshLibraryScopeId(): void {
  if (typeof window === "undefined" || libScopeRefreshInFlight) return;
  libScopeRefreshInFlight = true;
  fetch("/api/config/library", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { libraryPath?: unknown } | null) => {
      const p = typeof data?.libraryPath === "string" ? data.libraryPath : "";
      if (p) {
        try {
          localStorage.setItem(LIB_SCOPE_KEY, p);
        } catch {}
      }
    })
    .catch(() => {})
    .finally(() => {
      libScopeRefreshInFlight = false;
    });
}
refreshLibraryScopeId();

// --- Reader-side helpers (plain async, no hooks) -------------------------

// Fetch saved progress for a book. Returns null when not signed in or none.
export async function fetchBookProgress(bookId: number): Promise<ProgressRecord | null> {
  try {
    const res = await fetchJson<{ progress: ProgressRecord | null }>(
      `/api/user/progress/${bookId}`,
    );
    return res.progress ?? null;
  } catch {
    return null;
  }
}

interface PendingSave {
  format: string;
  location: string | null;
  percentage: number;
  finished: boolean;
}

const SAVE_DEBOUNCE_MS = 1500;
const pending = new Map<number, PendingSave>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

// F01: durable outbox for failed saves. Beacon/pagehide delivery is
// queue-only (never treated as acked); entries stay queued until a PUT/POST
// returns ok, with bounded retries so a dead server can't grow storage.
const OUTBOX_KEY = "caliber-progress-outbox";
const OUTBOX_MAX_ENTRIES = 200;
const OUTBOX_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;

interface OutboxEntry {
  bookId: number;
  data: PendingSave;
  attempts: number;
  ts: number;
}

function readOutbox(): OutboxEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OutboxEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, OUTBOX_MAX_ENTRIES)));
  } catch {}
}

export function enqueueProgressOutbox(bookId: number, data: PendingSave): void {
  const entries = readOutbox().filter((e) => e.bookId !== bookId);
  entries.push({ bookId, data, attempts: 0, ts: Date.now() });
  writeOutbox(entries);
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOutboxRetry(delayMs = RETRY_BASE_MS): void {
  if (typeof window === "undefined") return;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryOutbox();
  }, delayMs);
}

export async function retryOutbox(): Promise<void> {
  const entries = readOutbox();
  if (entries.length === 0) return;
  const remaining: OutboxEntry[] = [];
  for (const entry of entries) {
    try {
      const res = await fetch(`/api/user/progress/${entry.bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.data),
        keepalive: true,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Acked: drop entry (do not re-add).
    } catch {
      const attempts = entry.attempts + 1;
      if (attempts < OUTBOX_MAX_ATTEMPTS) {
        remaining.push({ ...entry, attempts });
      }
      // Else drop: bounded retries.
    }
  }
  writeOutbox(remaining);
  if (remaining.length > 0) {
    scheduleOutboxRetry(Math.min(RETRY_BASE_MS * remaining.length, 30000));
  } else {
    void queryClient.invalidateQueries({ queryKey: ["reading-list"] });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void retryOutbox();
  });
  // Opportunistic drain on load (beacon-queued entries are not acked).
  scheduleOutboxRetry(RETRY_BASE_MS);
}

async function putProgress(bookId: number, data: PendingSave): Promise<boolean> {
  const url = `/api/user/progress/${bookId}`;
  const payload = JSON.stringify(data);
  // Server accepts both PUT and POST (beacon can only POST).
  for (const method of ["PUT", "POST"] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      });
      if (res.ok) return true;
      // POST fallback only helps on 404/405 (old server without the alias).
      if (method === "PUT" && (res.status === 404 || res.status === 405)) continue;
      return false;
    } catch {
      if (method === "PUT") continue;
      return false;
    }
  }
  return false;
}

function flush(bookId: number, useBeacon = false): void {
  const data = pending.get(bookId);
  if (!data) return;
  const timer = timers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(bookId);
  }
  const url = `/api/user/progress/${bookId}`;
  const payload = JSON.stringify(data);
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // sendBeacon POSTs; the server has a POST alias for this reason. Queueing
    // in the browser is NOT an ack: persist to the outbox so the next load
    // re-PUTs until the server confirms with response.ok.
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) {
        enqueueProgressOutbox(bookId, data);
        return;
      }
    } catch {}
  }
  // Keep pending until the server acks; only delete on response.ok.
  void putProgress(bookId, data).then((ok) => {
    if (ok) {
      // Only clear if no newer save arrived while the request was in flight.
      const current = pending.get(bookId);
      if (current === data || JSON.stringify(current) === payload) {
        pending.delete(bookId);
      }
      void queryClient.invalidateQueries({ queryKey: ["reading-list"] });
      // A successful flush also drains any outbox entry for this book.
      const rest = readOutbox().filter((e) => e.bookId !== bookId);
      writeOutbox(rest);
    } else {
      enqueueProgressOutbox(bookId, data);
      scheduleOutboxRetry();
    }
  });
}

// Debounced, fire-and-forget progress save. Safe to call on every page turn.
export function saveBookProgress(bookId: number, data: PendingSave): void {
  pending.set(bookId, data);
  const existing = timers.get(bookId);
  if (existing) clearTimeout(existing);
  timers.set(
    bookId,
    setTimeout(() => flush(bookId), SAVE_DEBOUNCE_MS),
  );
}

// Flush any pending progress immediately (e.g. on reader unmount).
export function flushBookProgress(bookId: number): void {
  flush(bookId);
}

// Drop all queued (not yet acknowledged) progress writes. Must be called on
// account switch/logout so one user's pending outbox never replays under a
// new user's cookie.
export function clearPendingProgressOutbox(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
}

let lifecycleBound = false;
function bindLifecycleFlush(): void {
  if (lifecycleBound || typeof window === "undefined") return;
  lifecycleBound = true;
  const flushAll = () => {
    for (const id of [...pending.keys()]) flush(id, true);
  };
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}
bindLifecycleFlush();

// --- Shelf hooks ---------------------------------------------------------

export function useReadingList() {
  return useQuery({
    queryKey: ["reading-list"],
    queryFn: () => fetchJson<{ items: ReadingListItem[] }>("/api/user/reading"),
    staleTime: 1000 * 30,
  });
}

export function useRemoveFromReadingList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bookId: number) =>
      fetchJson<{ removed: boolean }>(`/api/user/progress/${bookId}`, { method: "DELETE" }),
    onMutate: async (bookId: number) => {
      await qc.cancelQueries({ queryKey: ["reading-list"] });
      const prev = qc.getQueryData<{ items: ReadingListItem[] }>(["reading-list"]);
      if (prev) {
        qc.setQueryData(["reading-list"], {
          items: prev.items.filter((i) => i.book.id !== bookId),
        });
      }
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["reading-list"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}

export function useClearReadingList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson<{ removed: number }>("/api/user/reading", { method: "DELETE" }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["reading-list"] });
      const prev = qc.getQueryData<{ items: ReadingListItem[] }>(["reading-list"]);
      qc.setQueryData(["reading-list"], { items: [] });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["reading-list"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}

export function sortReadingList(items: ReadingListItem[], sort: ReadingSort): ReadingListItem[] {
  const copy = [...items];
  switch (sort) {
    case "title":
      return copy.sort((a, b) => a.book.title.localeCompare(b.book.title));
    case "progress":
      return copy.sort((a, b) => b.progress.percentage - a.progress.percentage);
    default:
      return copy.sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
  }
}
