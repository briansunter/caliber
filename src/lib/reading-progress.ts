import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";

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

function flush(bookId: number, useBeacon = false): void {
  const data = pending.get(bookId);
  if (!data) return;
  pending.delete(bookId);
  const timer = timers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(bookId);
  }
  const url = `/api/user/progress/${bookId}`;
  const payload = JSON.stringify(data);
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // sendBeacon can't do PUT; fall back to keepalive fetch below if it fails.
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    } catch {}
  }
  void fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
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
