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

// Fetch saved progress for a book + format. Format is REQUIRED — the
// server is format-scoped (GET /api/user/progress/:id?format=X) so an EPUB
// position never restores into the PDF reader and vice versa. Returns null
// when not signed in or none.
export type ProgressFormat = "EPUB" | "PDF" | "CBZ" | "CBR";
export async function fetchBookProgress(
  bookId: number,
  format: ProgressFormat,
): Promise<ProgressRecord | null> {
  try {
    const res = await fetchJson<{ progress: ProgressRecord | null }>(
      `/api/user/progress/${bookId}?format=${encodeURIComponent(format)}`,
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

// R3: immutable operation captured at creation. saveBookProgress snapshots
// principal+library+mutation+ts into the pending entry immediately; flush and
// putProgress reuse that captured identity and never re-read lastKnownUserId.
export interface ProgressOp {
  bookId: number;
  data: PendingSave;
  mutationId: string;
  userId: number | null;
  libraryId: string;
  ts: number;
}

export interface PutProgressResult {
  ok: boolean;
  applied: boolean;
  reason?: string;
}

const SAVE_DEBOUNCE_MS = 1500;
const pending = new Map<number, ProgressOp>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

// R2: one ordered coordinator per identity. Drains for the same
// user+library+book+format are chained so overlapping flush/retry drains never
// run in parallel for the same identity.
const opChains = new Map<string, Promise<void>>();

function identityKey(userId: number | null, libraryId: string, bookId: number, format: string): string {
  return `${userId ?? "anon"}:${libraryId}:${bookId}:${format}`;
}

function chainIdentity(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = opChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  opChains.set(key, next);
  void next.finally(() => {
    if (opChains.get(key) === next) opChains.delete(key);
  });
  return next;
}

// F01/FUP2/FUP3: durable outbox for failed saves. Beacon/pagehide delivery
// is queue-only (never treated as acked); entries stay queued until a
// PUT/POST returns ok. Every entry carries its own mutationId plus the
// principal+library it belongs to, and the drain only replays entries that
// match the current principal+library — a different signed-in user never
// inherits another user's queued writes.
const OUTBOX_KEY = "caliber-progress-outbox";
const REJECTED_KEY = "caliber-progress-rejected";
const OUTBOX_MAX_ENTRIES = 200;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

export interface OutboxEntry {
  mutationId: string;
  userId: number | null;
  libraryId: string;
  bookId: number;
  format: string;
  data: PendingSave;
  attempts: number;
  ts: number;
}

export interface RejectedProgressEntry extends OutboxEntry {
  status: number;
  rejectedAt: number;
}

export type RejectedProgressCallback = (entry: RejectedProgressEntry) => void;

const rejectedCallbacks = new Set<RejectedProgressCallback>();

export function onProgressRejected(cb: RejectedProgressCallback): () => void {
  rejectedCallbacks.add(cb);
  return () => {
    rejectedCallbacks.delete(cb);
  };
}

// Principal that owns newly enqueued entries. Seeded from /api/user/me and
// refreshed by switchPrincipal; retryOutbox re-establishes it from the
// server before every drain.
let lastKnownUserId: number | null = null;

export function setOutboxPrincipal(userId: number | null): void {
  lastKnownUserId = typeof userId === "number" && Number.isInteger(userId) ? userId : null;
}

// Generation counter: switchPrincipal bumps it to abort in-flight drains so
// a previous principal's drain cannot write after the switch.
let outboxGeneration = 0;
// Set on 401: stop aggressive retries, keep everything queued.
let outboxSuspended = false;

function newMutationId(): string {
  try {
    const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {}
  return `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 52).toString(36)}`;
}

function normalizeOutboxEntry(raw: unknown): OutboxEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.bookId !== "number" || !Number.isInteger(e.bookId)) return null;
  const rawData = e.data as Record<string, unknown> | null | undefined;
  if (!rawData || typeof rawData !== "object" || typeof rawData.format !== "string") return null;
  const data: PendingSave = {
    format: String(rawData.format),
    location: rawData.location == null ? null : String(rawData.location),
    percentage: typeof rawData.percentage === "number" && Number.isFinite(rawData.percentage)
      ? rawData.percentage
      : 0,
    finished: rawData.finished === true,
  };
  return {
    mutationId:
      typeof e.mutationId === "string" && e.mutationId ? e.mutationId : newMutationId(),
    userId: typeof e.userId === "number" && Number.isInteger(e.userId) ? e.userId : null,
    libraryId: typeof e.libraryId === "string" && e.libraryId ? e.libraryId : "legacy",
    bookId: e.bookId,
    format: typeof e.format === "string" && e.format ? e.format : data.format,
    data,
    attempts: typeof e.attempts === "number" && e.attempts >= 0 ? Math.floor(e.attempts) : 0,
    ts: typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : 0,
  };
}

function readOutbox(): OutboxEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: OutboxEntry[] = [];
    for (const item of parsed) {
      const entry = normalizeOutboxEntry(item);
      if (entry) entries.push(entry);
    }
    return entries;
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

export function readRejectedProgress(): RejectedProgressEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(REJECTED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RejectedProgressEntry[]) : [];
  } catch {
    return [];
  }
}

function appendRejected(entries: RejectedProgressEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const merged = [...entries, ...readRejectedProgress()].slice(0, OUTBOX_MAX_ENTRIES);
    localStorage.setItem(REJECTED_KEY, JSON.stringify(merged));
  } catch {}
}

export function clearRejectedProgress(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(REJECTED_KEY);
  } catch {}
}

// Enqueue cap: never drop the newest entry. Victims are picked among the
// older entries, highest attempt count (most retried) and oldest first.
function pickEvictionIndex(entries: OutboxEntry[], newestIdx: number): number {
  let best = -1;
  for (let i = 0; i < entries.length; i++) {
    if (i === newestIdx) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const candidate = entries[i] as OutboxEntry;
    const current = entries[best] as OutboxEntry;
    if (
      candidate.attempts !== current.attempts
        ? candidate.attempts > current.attempts
        : candidate.ts < current.ts
    ) {
      best = i;
    }
  }
  return best === -1 ? 0 : best;
}

export function enqueueProgressOutbox(
  bookId: number,
  data: PendingSave,
  opts?: { mutationId?: string; userId?: number | null; libraryId?: string; ts?: number },
): string {
  const mutationId = opts?.mutationId ?? newMutationId();
  const userId =
    opts && "userId" in opts
      ? opts.userId ?? null
      : lastKnownUserId;
  const libraryId = opts?.libraryId ?? getLibraryScopeId();
  const ts = typeof opts?.ts === "number" && Number.isFinite(opts.ts) ? opts.ts : Date.now();
  const entries = readOutbox().filter((e) => e.mutationId !== mutationId);
  entries.push({
    mutationId,
    userId,
    libraryId,
    bookId,
    format: data.format,
    data,
    attempts: 0,
    ts,
  });
  while (entries.length > OUTBOX_MAX_ENTRIES) {
    entries.splice(pickEvictionIndex(entries, entries.length - 1), 1);
  }
  writeOutbox(entries);
  return mutationId;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOutboxRetry(delayMs = RETRY_BASE_MS): void {
  if (typeof window === "undefined") return;
  if (outboxSuspended) return;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryOutbox();
  }, delayMs);
}

export function scheduleProgressOutboxRetry(delayMs = RETRY_BASE_MS): void {
  scheduleOutboxRetry(delayMs);
}

export async function retryOutbox(): Promise<void> {
  const generation = outboxGeneration;
  const snapshot = readOutbox();
  if (snapshot.length === 0) return;
  // Establish the current principal from the server before replaying
  // anything: without a principal no entry can match, so nothing drains.
  let currentUserId: number | null = null;
  try {
    const me = await fetchJson<{ user: { id: number } | null }>("/api/user/me");
    currentUserId = typeof me?.user?.id === "number" ? me.user.id : null;
  } catch (error) {
    // No signed-in principal (401): keep everything queued, no retries.
    if (error instanceof Error && /401/.test(error.message)) return;
    // Network failure before any attempt: keep everything, back off.
    scheduleOutboxRetry(RETRY_BASE_MS);
    return;
  }
  if (generation !== outboxGeneration) return;
  if (currentUserId !== null) setOutboxPrincipal(currentUserId);
  const currentLibrary = getLibraryScopeId();
  // Gate: only replay entries belonging to the current principal+library.
  // Foreign entries stay queued for their own principal/library.
  if (currentUserId === null) return;
  const eligible = snapshot.filter(
    (e) => e.userId !== null && e.userId === currentUserId && e.libraryId === currentLibrary,
  );
  if (eligible.length === 0) return;

  type Outcome =
    | { kind: "acked" }
    | { kind: "retry" }
    | { kind: "rejected"; status: number }
    | { kind: "suspended" };
  const outcomes = new Map<string, Outcome>();
  let suspended = false;
  // R2: ordered drain per identity — sorted by client ts so older mutations
  // apply first; the loop awaits each PUT sequentially (never parallel) for
  // the same book+format identity.
  const queue = [...eligible].sort((a, b) => a.ts - b.ts);
  for (const entry of queue) {
    if (generation !== outboxGeneration) break; // principal switched: abort drain
    if (suspended) break;
    try {
      const res = await fetch(`/api/user/progress/${entry.bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // R2: per-(user,library,book,format) ordering fields.
        body: JSON.stringify({ ...entry.data, mutationId: entry.mutationId, clientTs: entry.ts }),
        keepalive: true,
      });
      if (res.ok) {
        // R2: applied:false (stale) is still processed — drop only that
        // mutation without clobbering UI (no refetch of stale state).
        try {
          const body = (await res.clone().json()) as { applied?: unknown };
          if (body && body.applied === false) {
            outcomes.set(entry.mutationId, { kind: "acked" });
            continue;
          }
        } catch {}
        outcomes.set(entry.mutationId, { kind: "acked" });
        continue;
      }
      if (res.status === 401) {
        // Auth lost: suspend retries, keep queued, invalidate auth state.
        outcomes.set(entry.mutationId, { kind: "suspended" });
        suspended = true;
        outboxSuspended = true;
        void queryClient.invalidateQueries({ queryKey: ["user"] });
        break;
      }
      if (res.status === 400 || res.status === 422) {
        outcomes.set(entry.mutationId, { kind: "rejected", status: res.status });
        continue;
      }
      outcomes.set(entry.mutationId, { kind: "retry" });
      if (res.status === 429) break; // rate-limited: back off, keep queued
    } catch {
      // Network error / 5xx path handled below as retry (never deleted).
      outcomes.set(entry.mutationId, { kind: "retry" });
    }
  }
  const aborted = generation !== outboxGeneration;
  // Merge with current storage instead of overwriting the pre-drain
  // snapshot: remove only acked/rejected IDs, bump attempts only for
  // attempted IDs, and keep newcomers that arrived mid-drain.
  const fresh = readOutbox();
  const now = Date.now();
  const rejectedNow: RejectedProgressEntry[] = [];
  const merged: OutboxEntry[] = [];
  for (const e of fresh) {
    const outcome = outcomes.get(e.mutationId);
    if (outcome?.kind === "acked") continue;
    if (outcome?.kind === "rejected") {
      rejectedNow.push({ ...e, status: outcome.status, rejectedAt: now });
      continue;
    }
    if (outcome?.kind === "retry") merged.push({ ...e, attempts: e.attempts + 1 });
    else merged.push(e);
  }
  writeOutbox(merged);
  if (rejectedNow.length > 0) {
    appendRejected(rejectedNow);
    for (const cb of [...rejectedCallbacks]) {
      try {
        for (const r of rejectedNow) cb(r);
      } catch {}
    }
  }
  if (aborted) return;
  // Attempts never delete entries: the cap only slows the schedule down to
  // the maximum backoff. Only 401 suspends and 400/422 rejects.
  if (suspended || outboxSuspended) return;
  const remaining = merged.filter(
    (e) => e.userId !== null && e.userId === currentUserId && e.libraryId === currentLibrary,
  );
  if (remaining.length > 0) {
    const maxAttempts = remaining.reduce((m, e) => Math.max(m, e.attempts), 0);
    scheduleOutboxRetry(
      Math.min(RETRY_BASE_MS * 2 ** Math.min(maxAttempts, 5), RETRY_MAX_MS),
    );
  } else if (merged.length === 0) {
    void queryClient.invalidateQueries({ queryKey: ["reading-list"] });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void retryOutbox();
  });
  // Seed the principal, then drain only entries that match the established
  // principal+library (no blind auto-drain of foreign entries).
  void (async () => {
    try {
      const me = await fetchJson<{ user: { id: number } | null }>("/api/user/me");
      if (typeof me?.user?.id === "number") {
        setOutboxPrincipal(me.user.id);
      }
    } catch {}
    await retryOutbox();
  })();
}

async function putProgress(op: ProgressOp): Promise<PutProgressResult> {
  const url = `/api/user/progress/${op.bookId}`;
  // R2+R3: same captured identity on both attempts.
  const payload = JSON.stringify({ ...op.data, mutationId: op.mutationId, clientTs: op.ts });
  // Server accepts both PUT and POST (beacon can only POST).
  for (const method of ["PUT", "POST"] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      });
      if (res.ok) {
        try {
          const body = (await res.clone().json()) as { applied?: unknown; reason?: unknown };
          if (body && body.applied === false) {
            return { ok: true, applied: false, reason: typeof body.reason === "string" ? body.reason : "stale" };
          }
        } catch {}
        return { ok: true, applied: true };
      }
      // POST fallback only helps on 404/405 (old server without the alias).
      if (method === "PUT" && (res.status === 404 || res.status === 405)) continue;
      return { ok: false, applied: false };
    } catch {
      if (method === "PUT") continue;
      return { ok: false, applied: false };
    }
  }
  return { ok: false, applied: false };
}

function flush(bookId: number, useBeacon = false): void {
  const op = pending.get(bookId);
  if (!op) return;
  const timer = timers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(bookId);
  }
  // R3: capture generation at flush start; the completion callback aborts if
  // it changed (account switch) instead of enqueueing under a new principal.
  const generationAtStart = outboxGeneration;
  const url = `/api/user/progress/${bookId}`;
  const payload = JSON.stringify({ ...op.data, mutationId: op.mutationId, clientTs: op.ts });
  const payloadDataJson = JSON.stringify(op.data);
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // sendBeacon POSTs; the server has a POST alias for this reason. Queueing
    // in the browser is NOT an ack: persist to the outbox so the next load
    // re-PUTs until the server confirms with response.ok.
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) {
        enqueueProgressOutbox(bookId, op.data, {
          mutationId: op.mutationId,
          userId: op.userId,
          libraryId: op.libraryId,
          ts: op.ts,
        });
        return;
      }
    } catch {}
  }
  // R2: serialize drains per book+format identity; never parallel overlapping
  // drains for the same identity.
  const key = identityKey(op.userId, op.libraryId, op.bookId, op.data.format);
  void chainIdentity(key, async () => {
    // Keep pending until the server acks; only delete on response.ok.
    const result = await putProgress(op);
    if (generationAtStart !== outboxGeneration) return;
    if (result.ok) {
      // Only clear if no newer save arrived while the request was in flight.
      const current = pending.get(bookId);
      if (current === op || (current && JSON.stringify(current.data) === payloadDataJson)) {
        pending.delete(bookId);
      }
      // R2: applied:false is processed (remove only that mutation) without
      // clobbering UI — no reading-list invalidation for stale acks.
      if (result.applied === false) {
        writeOutbox(readOutbox().filter((e) => e.mutationId !== op.mutationId));
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["reading-list"] });
      // Remove only the acknowledged mutation: this attempt plus any queued
      // entry carrying the identical payload. Newer queued mutations for the
      // same book (concurrent writes) are preserved.
      const rest = readOutbox().filter(
        (e) =>
          e.mutationId !== op.mutationId &&
          !(
            e.bookId === bookId &&
            e.format === op.data.format &&
            JSON.stringify(e.data) === payloadDataJson
          ),
      );
      writeOutbox(rest);
    } else {
      // R3: failure reuses the SAME captured identity, never re-reads principal.
      enqueueProgressOutbox(bookId, op.data, {
        mutationId: op.mutationId,
        userId: op.userId,
        libraryId: op.libraryId,
        ts: op.ts,
      });
      scheduleOutboxRetry();
    }
  });
}

// Debounced, fire-and-forget progress save. Safe to call on every page turn.
// R3: captures {userId, libraryId, mutationId, ts} into the pending entry
// immediately (not at enqueue-after-failure).
export function saveBookProgress(bookId: number, data: PendingSave): void {
  const op: ProgressOp = {
    bookId,
    data: { ...data },
    mutationId: newMutationId(),
    userId: lastKnownUserId,
    libraryId: getLibraryScopeId(),
    ts: Date.now(),
  };
  pending.set(bookId, op);
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

// Drop all in-memory queued (not yet acknowledged) progress writes. Must be
// called on account switch/logout so one user's in-flight timers and drains
// never replay under a new principal's cookie. The persisted outbox is
// intentionally NOT deleted: entries belong to possibly different
// principals and stay queued until a gated drain replays only entries that
// match the current principal+library.
export function clearPendingProgressOutbox(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  outboxGeneration += 1;
  outboxSuspended = false;
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
