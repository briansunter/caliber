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
  serverSeq?: number | null;
  // Backward-compat alias for the snake_case DB column as serialized.
  server_seq?: number | null;
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
    const res = await fetchJson<{ progress: ProgressRecord | null; serverSeq?: unknown }>(
      `/api/user/progress/${bookId}?format=${encodeURIComponent(format)}`,
    );
    const progress = res.progress ?? null;
    // S2: persist last known server_seq per identity for baseRevision.
    const seq = serverSeqOfProgress(progress) ?? (typeof res.serverSeq === "number" ? res.serverSeq : null);
    if (progress && seq !== null) {
      setKnownServerSeq(lastKnownUserId, getLibraryScopeId(), bookId, format, seq);
    }
    return progress;
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
// sendProgressOp reuse that captured identity and never re-read lastKnownUserId.
export interface ProgressOp {
  bookId: number;
  data: PendingSave;
  mutationId: string;
  userId: number | null;
  libraryId: string;
  ts: number;
  baseRevision: number | null;
}

export interface PutProgressResult {
  ok: boolean;
  applied: boolean;
  reason?: string;
  serverSeq?: number | null;
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

// S3: per-identity coordinator. All sends go through sendProgressOp (which
// chains here), so overlapping flush/retry drains for the same
// user:library:book:format never run in parallel.
function chainIdentityResult<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = opChains.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const next: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  opChains.set(key, next);
  void next.finally(() => {
    if (opChains.get(key) === next) opChains.delete(key);
  });
  return result;
}

// S2: last known server_seq per identity, persisted client-side so
// baseRevision survives reloads. Updated from every GET progress response
// and every PUT/POST response.
const SEQ_KEY = "caliber-progress-seq";
const seqCache = new Map<string, number>();

function seqStoreKey(userId: number | null, libraryId: string, bookId: number, format: string): string {
  return identityKey(userId, libraryId, bookId, format);
}

function loadSeqStore(): Record<string, number> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(SEQ_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

let seqLoaded = false;
function ensureSeqLoaded(): void {
  if (seqLoaded) return;
  seqLoaded = true;
  try {
    for (const [k, v] of Object.entries(loadSeqStore())) seqCache.set(k, v);
  } catch {}
}

function persistSeqStore(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const obj: Record<string, number> = {};
    for (const [k, v] of seqCache) obj[k] = v;
    localStorage.setItem(SEQ_KEY, JSON.stringify(obj));
  } catch {}
}

export function getKnownServerSeq(
  userId: number | null,
  libraryId: string,
  bookId: number,
  format: string,
): number | null {
  ensureSeqLoaded();
  const v = seqCache.get(seqStoreKey(userId, libraryId, bookId, format));
  return typeof v === "number" ? v : null;
}

export function setKnownServerSeq(
  userId: number | null,
  libraryId: string,
  bookId: number,
  format: string,
  seq: number | null | undefined,
): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return;
  ensureSeqLoaded();
  seqCache.set(seqStoreKey(userId, libraryId, bookId, format), Math.floor(seq));
  persistSeqStore();
}

function serverSeqOfProgress(p: unknown): number | null {
  if (typeof p !== "object" || p === null) return null;
  const r = p as Record<string, unknown>;
  const raw = (r.serverSeq ?? r.server_seq) as unknown;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
}

// S4: deletion tombstones. DELETE progress / clear reading-list records
// deletedAt per identity; retry/flush skips (drops) queued ops with
// ts < deletion ts for that identity.
//
// Resurrection policy: a write created AFTER the deletion (op.ts >
// deletedAt) resurrects the row (last-writer-wins); writes created before
// the deletion are dropped and never resurrect. A format-less book delete
// records a book-level wildcard tombstone covering all formats; a
// reading-list clear records a library-level tombstone covering all books.
const TOMBSTONE_KEY = "caliber-progress-tombstones";

interface TombstoneMap {
  [key: string]: number;
}

function readTombstones(): TombstoneMap {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: TombstoneMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeTombstones(map: TombstoneMap): void {
  try {
    if (typeof localStorage === "undefined") return;
    const keys = Object.keys(map).slice(-500);
    const trimmed: TombstoneMap = {};
    for (const k of keys) trimmed[k] = map[k] as number;
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(trimmed));
  } catch {}
}

function bookTombstoneKey(userId: number | null, libraryId: string, bookId: number): string {
  return `${userId ?? "anon"}:${libraryId}:${bookId}:*`;
}

function libraryTombstoneKey(userId: number | null, libraryId: string): string {
  return `${userId ?? "anon"}:${libraryId}:*:*`;
}

function tombstoneTsFor(
  userId: number | null,
  libraryId: string,
  bookId: number,
  format: string,
): number | null {
  const map = readTombstones();
  const exact = map[identityKey(userId, libraryId, bookId, format)];
  const book = map[bookTombstoneKey(userId, libraryId, bookId)];
  const lib = map[libraryTombstoneKey(userId, libraryId)];
  let best: number | null = null;
  for (const v of [exact, book, lib]) {
    if (typeof v === "number" && Number.isFinite(v)) best = Math.max(best ?? v, v);
  }
  return best;
}

/** True when the op predates a recorded deletion and must be dropped. */
export function isOpSupersededByDeletion(op: {
  userId: number | null;
  libraryId: string;
  bookId: number;
  format?: string;
  ts: number;
}): boolean {
  const tomb = tombstoneTsFor(op.userId, op.libraryId, op.bookId, op.format ?? "*");
  if (tomb === null) {
    // A caller passing format "*" checks only book/library wildcards.
    if (op.format === undefined) {
      const map = readTombstones();
      const book = map[bookTombstoneKey(op.userId, op.libraryId, op.bookId)];
      const lib = map[libraryTombstoneKey(op.userId, op.libraryId)];
      const best = Math.max(book ?? -Infinity, lib ?? -Infinity);
      return Number.isFinite(best) && op.ts < best;
    }
    return false;
  }
  return op.ts < tomb;
}

export function recordProgressDeletion(
  userId: number | null,
  libraryId: string,
  bookId: number,
  format?: string,
): void {
  const now = Date.now();
  const map = readTombstones();
  if (format) map[identityKey(userId, libraryId, bookId, format)] = now;
  else map[bookTombstoneKey(userId, libraryId, bookId)] = now;
  writeTombstones(map);
  // Cancel in-memory + persisted queued ops for the removed book that
  // predate the deletion; newer ops (created after) may resurrect.
  for (const [id, op] of [...pending]) {
    if (id !== bookId) continue;
    if (format && op.data.format !== format) continue;
    if (op.ts < now) {
      pending.delete(id);
      const t = timers.get(id);
      if (t) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }
  const kept = readOutbox().filter((e) => {
    if (e.bookId !== bookId) return true;
    if (format && e.format !== format) return true;
    if (e.userId !== userId || e.libraryId !== libraryId) return true;
    return e.ts >= now;
  });
  writeOutbox(kept);
}

export function recordReadingListClear(userId: number | null, libraryId: string): void {
  const now = Date.now();
  const map = readTombstones();
  map[libraryTombstoneKey(userId, libraryId)] = now;
  writeTombstones(map);
  for (const [id, op] of [...pending]) {
    if (op.userId === userId && op.libraryId === libraryId && op.ts < now) {
      pending.delete(id);
      const t = timers.get(id);
      if (t) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }
  writeOutbox(
    readOutbox().filter(
      (e) => !(e.userId === userId && e.libraryId === libraryId && e.ts < now),
    ),
  );
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
  baseRevision: number | null;
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
    baseRevision:
      typeof e.baseRevision === "number" && Number.isFinite(e.baseRevision)
        ? Math.floor(e.baseRevision)
        : null,
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
  opts?: { mutationId?: string; userId?: number | null; libraryId?: string; ts?: number; baseRevision?: number | null },
): string {
  const mutationId = opts?.mutationId ?? newMutationId();
  const userId =
    opts && "userId" in opts
      ? opts.userId ?? null
      : lastKnownUserId;
  const libraryId = opts?.libraryId ?? getLibraryScopeId();
  const ts = typeof opts?.ts === "number" && Number.isFinite(opts.ts) ? opts.ts : Date.now();
  const baseRevision =
    typeof opts?.baseRevision === "number" && Number.isFinite(opts.baseRevision)
      ? Math.floor(opts.baseRevision)
      : null;
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
    baseRevision,
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
  // S4: drop entries predating a recorded deletion before draining.
  const afterTombstones = snapshot.filter((e) => {
    if (e.userId !== currentUserId || e.libraryId !== currentLibrary) return true;
    return !isOpSupersededByDeletion({ userId: e.userId, libraryId: e.libraryId, bookId: e.bookId, format: e.format, ts: e.ts });
  });
  if (afterTombstones.length !== snapshot.length) {
    const liveIds = new Set(afterTombstones.map((e) => e.mutationId));
    writeOutbox(readOutbox().filter((e) => liveIds.has(e.mutationId) || e.userId !== currentUserId || e.libraryId !== currentLibrary));
  }
  const eligible = afterTombstones.filter(
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
  // S2: ordered drain per identity — sorted by client ts so older mutations
  // apply first; each send goes through the shared coordinator (which
  // serializes per identity and rebases on conflict), so an offline queue of
  // page10(ts1000)+page20(ts2000) ends at page20.
  const queue = [...eligible].sort((a, b) => a.ts - b.ts);
  for (const entry of queue) {
    if (generation !== outboxGeneration) break; // principal switched: abort drain
    if (suspended) break;
    // S4: re-check the tombstone right before sending (a removal may have
    // landed mid-drain); tombstoned ops are dropped, never sent.
    if (isOpSupersededByDeletion({ userId: entry.userId, libraryId: entry.libraryId, bookId: entry.bookId, format: entry.format, ts: entry.ts })) {
      outcomes.set(entry.mutationId, { kind: "acked" });
      continue;
    }
    // S3: retry replays through the SAME coordinator, never direct fetch.
    const op: ProgressOp = {
      bookId: entry.bookId,
      data: { ...entry.data },
      mutationId: entry.mutationId,
      userId: entry.userId,
      libraryId: entry.libraryId,
      ts: entry.ts,
      baseRevision: entry.baseRevision ?? getKnownServerSeq(entry.userId, entry.libraryId, entry.bookId, entry.format),
    };
    try {
      const result = await sendProgressOp(op);
      if (generation !== outboxGeneration) break;
      if (result.ok) {
        // S2/S4: applied true, duplicate, conflict, or deleted — in all
        // cases remove ONLY this exact mutationId. A conflict never deletes
        // a newer queued mutation for the same identity (the coordinator
        // already rebased/retried the newest once; older losers drop here).
        outcomes.set(entry.mutationId, { kind: "acked" });
        continue;
      }
      if (result.reason === "unauthorized") {
        outcomes.set(entry.mutationId, { kind: "suspended" });
        suspended = true;
        outboxSuspended = true;
        void queryClient.invalidateQueries({ queryKey: ["user"] });
        break;
      }
      if (result.reason === "identity-mismatch") {
        outcomes.set(entry.mutationId, { kind: "rejected", status: 409 });
        continue;
      }
      if (result.reason === "superseded" || result.reason === "deleted") {
        outcomes.set(entry.mutationId, { kind: "acked" });
        continue;
      }
      outcomes.set(entry.mutationId, { kind: "retry" });
    } catch {
      // Network error / 5xx path handled below as retry (never deleted).
      outcomes.set(entry.mutationId, { kind: "retry" });
    }
    // 429 handling: back off after the loop via attempts-based schedule.
    const lastOutcome = outcomes.get(entry.mutationId);
    if (lastOutcome?.kind === "retry" && entry.attempts >= 0) {
      // Peek: rate-limit signals surface as plain retry; the exponential
      // schedule below slows the drain automatically.
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

/**
 * S3 shared send coordinator. Every progress write — flush initial send,
 * PUT->POST fallback, and retryOutbox replays — goes through here, chained
 * per user:library:book:format identity.
 *
 * - Checks generation + principal/library match BEFORE each fetch attempt
 *   (including before the POST fallback).
 * - Sends expected {userId, libraryId} + baseRevision in the body.
 * - Persists returned server_seq per identity.
 * - On applied:false/conflict: refetches server state, rebases, and retries
 *   ONCE with a fresh baseRevision only when this op is the newest local
 *   mutation for the identity and its ts is newer than the server updatedAt.
 *   Older queued mutations for the same identity are dropped (exact
 *   mutationId only) so an offline queue of page10(ts1000)+page20(ts2000)
 *   drains sequentially to final=page20.
 */
export async function sendProgressOp(op: ProgressOp): Promise<PutProgressResult> {
  const key = identityKey(op.userId, op.libraryId, op.bookId, op.data.format);
  return chainIdentityResult(key, () => sendProgressOpInner(op));
}

function opBlockedByPrincipal(op: ProgressOp): boolean {
  if (lastKnownUserId !== null && op.userId !== lastKnownUserId) return true;
  try {
    if (op.libraryId !== getLibraryScopeId()) return true;
  } catch {}
  return false;
}

function newestLocalTsForIdentity(
  userId: number | null,
  libraryId: string,
  bookId: number,
  format: string,
): number | null {
  let best: number | null = null;
  for (const p of pending.values()) {
    if (p.userId === userId && p.libraryId === libraryId && p.bookId === bookId && p.data.format === format) {
      best = best === null ? p.ts : Math.max(best, p.ts);
    }
  }
  for (const e of readOutbox()) {
    if (e.userId === userId && e.libraryId === libraryId && e.bookId === bookId && e.format === format) {
      best = best === null ? e.ts : Math.max(best, e.ts);
    }
  }
  return best;
}

async function attemptSend(
  op: ProgressOp,
  method: "PUT" | "POST",
  baseRevision: number | null,
  generation: number,
): Promise<{ res: Response | null; networkError: boolean }> {
  // S3: re-check generation + principal match before EVERY attempt.
  if (generation !== outboxGeneration) return { res: null, networkError: false };
  if (opBlockedByPrincipal(op)) return { res: null, networkError: false };
  const url = `/api/user/progress/${op.bookId}`;
  const payload = JSON.stringify({
    ...op.data,
    mutationId: op.mutationId,
    clientTs: op.ts,
    baseRevision,
    expectedUserId: op.userId,
    expectedLibraryId: op.libraryId,
  });
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    });
    return { res, networkError: false };
  } catch {
    return { res: null, networkError: true };
  }
}

interface ServerProgressBody {
  applied?: unknown;
  reason?: unknown;
  serverSeq?: unknown;
  progress?: unknown;
}

function parseServerProgressBody(body: ServerProgressBody, op: ProgressOp): PutProgressResult {
  const seq =
    serverSeqOfProgress(body.progress) ??
    (typeof body.serverSeq === "number" ? Math.floor(body.serverSeq) : null);
  if (seq !== null) {
    setKnownServerSeq(op.userId, op.libraryId, op.bookId, op.data.format, seq);
  }
  if (body && body.applied === false) {
    return {
      ok: true,
      applied: false,
      reason: typeof body.reason === "string" ? body.reason : "conflict",
      serverSeq: seq,
    };
  }
  return { ok: true, applied: true, serverSeq: seq };
}

async function refetchServerState(op: ProgressOp): Promise<{ serverSeq: number | null; updatedAt: number | null }> {
  try {
    const res = await fetchJson<{ progress: (ProgressRecord & { updatedAt?: number }) | null; serverSeq?: unknown }>(
      `/api/user/progress/${op.bookId}?format=${encodeURIComponent(op.data.format)}`,
    );
    const seq = serverSeqOfProgress(res.progress) ?? (typeof res.serverSeq === "number" ? res.serverSeq : null);
    if (seq !== null) {
      setKnownServerSeq(op.userId, op.libraryId, op.bookId, op.data.format, seq);
    }
    const updatedAt =
      res.progress && typeof res.progress.updatedAt === "number" ? res.progress.updatedAt : null;
    return { serverSeq: seq, updatedAt };
  } catch {
    return { serverSeq: null, updatedAt: null };
  }
}

async function sendProgressOpInner(op: ProgressOp): Promise<PutProgressResult> {
  const generation = outboxGeneration;
  // S4: deletion tombstone — an op predating a removal is dropped, never sent.
  if (isOpSupersededByDeletion({ userId: op.userId, libraryId: op.libraryId, bookId: op.bookId, format: op.data.format, ts: op.ts })) {
    return { ok: true, applied: false, reason: "deleted" };
  }
  const baseRevision = op.baseRevision ?? getKnownServerSeq(op.userId, op.libraryId, op.bookId, op.data.format);
  // Server accepts both PUT and POST (beacon can only POST).
  let firstConflict: PutProgressResult | null = null;
  for (const method of ["PUT", "POST"] as const) {
    const { res, networkError } = await attemptSend(op, method, baseRevision, generation);
    if (!res) {
      if (generation !== outboxGeneration || opBlockedByPrincipal(op)) return { ok: false, applied: false, reason: "superseded" };
      if (networkError) {
        if (method === "PUT") continue; // fall through to POST attempt
        return { ok: false, applied: false };
      }
      return { ok: false, applied: false, reason: "superseded" };
    }
    if (res.ok) {
      let body: ServerProgressBody = {};
      try {
        body = (await res.clone().json()) as ServerProgressBody;
      } catch {}
      const parsed = parseServerProgressBody(body, op);
      if (parsed.applied === false && parsed.reason === "conflict" && method === "PUT") {
        firstConflict = parsed;
        break; // rebase below, then single POST retry with fresh revision
      }
      return parsed;
    }
    if (res.status === 401 || res.status === 409) {
      return { ok: false, applied: false, reason: res.status === 401 ? "unauthorized" : "identity-mismatch" };
    }
    // POST fallback only helps on 404/405 (old server without the alias).
    if (method === "PUT" && (res.status === 404 || res.status === 405)) continue;
    return { ok: false, applied: false };
  }
  // S2 conflict path: refetch, rebase, retry once for the newest local
  // mutation only. applied:false must NOT delete a newer queued mutation.
  if (firstConflict) {
    if (generation !== outboxGeneration || opBlockedByPrincipal(op)) {
      return { ok: false, applied: false, reason: "superseded" };
    }
    const server = await refetchServerState(op);
    const newestTs = newestLocalTsForIdentity(op.userId, op.libraryId, op.bookId, op.data.format);
    const isNewest = newestTs === null || op.ts >= newestTs;
    const localNewer = server.updatedAt === null || op.ts > server.updatedAt;
    if (isNewest && localNewer) {
      const freshBase = server.serverSeq ?? getKnownServerSeq(op.userId, op.libraryId, op.bookId, op.data.format);
      const { res, networkError } = await attemptSend(op, "POST", freshBase, generation);
      if (!res) return { ok: false, applied: false, ...(networkError ? {} : { reason: "superseded" }) };
      if (res.ok) {
        let body: ServerProgressBody = {};
        try {
          body = (await res.clone().json()) as ServerProgressBody;
        } catch {}
        return parseServerProgressBody(body, op);
      }
      if (res.status === 401 || res.status === 409) {
        return { ok: false, applied: false, reason: "identity-mismatch" };
      }
      return { ok: false, applied: false };
    }
    // Older queued mutation, or server is newer: drop exactly this mutation
    // (caller removes by mutationId only); the newer state wins.
    return firstConflict;
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
  // S4: deletion tombstone — drop locally without sending.
  if (isOpSupersededByDeletion({ userId: op.userId, libraryId: op.libraryId, bookId: op.bookId, format: op.data.format, ts: op.ts })) {
    pending.delete(bookId);
    writeOutbox(readOutbox().filter((e) => e.mutationId !== op.mutationId));
    return;
  }
  // R3: capture generation at flush start; the completion callback aborts if
  // it changed (account switch) instead of enqueueing under a new principal.
  const generationAtStart = outboxGeneration;
  const url = `/api/user/progress/${bookId}`;
  const payload = JSON.stringify({
    ...op.data,
    mutationId: op.mutationId,
    clientTs: op.ts,
    baseRevision: op.baseRevision,
    expectedUserId: op.userId,
    expectedLibraryId: op.libraryId,
  });
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // sendBeacon POSTs; the server has a POST alias for this reason. Queueing
    // in the browser is NOT an ack: the op was already persisted to the
    // outbox synchronously at creation, so the next load replays it until a
    // PUT/POST returns ok.
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    } catch {}
  }
  // S3: all sends go through the shared per-identity coordinator.
  void (async () => {
    // Keep pending until the server acks; only delete on response.ok.
    const result = await sendProgressOp(op);
    if (generationAtStart !== outboxGeneration) return;
    if (result.ok) {
      // Only clear if no newer save arrived while the request was in flight.
      const current = pending.get(bookId);
      if (current === op) {
        pending.delete(bookId);
      }
      if (result.serverSeq !== null && result.serverSeq !== undefined) {
        setKnownServerSeq(op.userId, op.libraryId, op.bookId, op.data.format, result.serverSeq);
      }
      // S4 ack cleanup: delete ONLY the exact mutationId. No
      // identical-payload coalescing: a newer queued mutation for the same
      // identity (e.g. page20 after page10) is always preserved; the
      // revision protocol + rebase decides the winner server-side.
      // applied:false (conflict/deleted) is still processed — the losing
      // mutation is dropped without clobbering UI.
      writeOutbox(readOutbox().filter((e) => e.mutationId !== op.mutationId));
      if (result.applied !== false) {
        void queryClient.invalidateQueries({ queryKey: ["reading-list"] });
      }
    } else {
      // Failure keeps the synchronously-persisted outbox entry (written at
      // creation with the SAME captured identity); just schedule a retry.
      if (result.reason === "unauthorized") {
        outboxSuspended = true;
        void queryClient.invalidateQueries({ queryKey: ["user"] });
        return;
      }
      if (result.reason === "superseded" || result.reason === "identity-mismatch") return;
      scheduleOutboxRetry();
    }
  })();
}

// Debounced, fire-and-forget progress save. Safe to call on every page turn.
// S4 persist-before-delivery: the op is written to the localStorage outbox
// SYNCHRONOUSLY at creation (before the debounce timer), then the flush is
// scheduled. R3: captures {userId, libraryId, mutationId, ts, baseRevision}
// into the pending entry immediately (not at enqueue-after-failure).
export function saveBookProgress(bookId: number, data: PendingSave): void {
  const libraryId = getLibraryScopeId();
  const userId = lastKnownUserId;
  const format = data.format;
  const op: ProgressOp = {
    bookId,
    data: { ...data },
    mutationId: newMutationId(),
    userId,
    libraryId,
    ts: Date.now(),
    baseRevision: getKnownServerSeq(userId, libraryId, bookId, format),
  };
  pending.set(bookId, op);
  enqueueProgressOutbox(bookId, op.data, {
    mutationId: op.mutationId,
    userId: op.userId,
    libraryId: op.libraryId,
    ts: op.ts,
    baseRevision: op.baseRevision,
  });
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
      // S4: record the tombstone + cancel queued ops BEFORE the DELETE
      // resolves, so a concurrent flush cannot resurrect with a stale op.
      // Ops created after this instant (ts >= deletedAt) may still resurrect
      // the row — that is the documented last-writer-wins policy.
      try {
        recordProgressDeletion(lastKnownUserId, getLibraryScopeId(), bookId);
      } catch {}
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
      // S4: library-level tombstone; same resurrection policy as above.
      try {
        recordReadingListClear(lastKnownUserId, getLibraryScopeId());
      } catch {}
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
