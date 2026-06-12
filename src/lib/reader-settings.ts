import { useSyncExternalStore } from "react";
import type { ReaderLoadMode } from "@/components/reader-types";

// User-tunable knobs that bound how much a reader keeps in memory at once.
// Lower values = less RAM/canvas pressure (fewer Safari "a problem repeatedly
// occurred" crashes) at the cost of slightly more waiting when paging fast.
export interface ReaderSettings {
  // Pages to warm ahead of / behind the current page (PDF + comic readers).
  prefetchAhead: number;
  prefetchBehind: number;
  // Cap the device-pixel-ratio used when rasterizing PDF pages. Retina screens
  // report 2-3; capping at 2 roughly halves the canvas backing-store size on a
  // 3x phone. 0 means "use the device ratio uncapped".
  maxRenderScale: number;
  // Default loading strategy for readers that support full-file mode.
  defaultLoadMode: ReaderLoadMode;
}

// Conservative defaults — deliberately lower than the old hard-coded 6-ahead/
// 2-behind so a fresh install does not blow Safari's per-tab memory budget.
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  prefetchAhead: 2,
  prefetchBehind: 1,
  maxRenderScale: 2,
  defaultLoadMode: "stream",
};

export const READER_SETTINGS_LIMITS = {
  prefetchAhead: { min: 0, max: 8 },
  prefetchBehind: { min: 0, max: 4 },
  maxRenderScale: { min: 1, max: 3 },
} as const;

const STORAGE_KEY = "caliber-reader-settings";
const CHANGE_EVENT = "caliber-reader-settings-change";

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampScale(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const { min, max } = READER_SETTINGS_LIMITS.maxRenderScale;
  return Math.min(max, Math.max(min, value));
}

export function normalizeReaderSettings(
  input: Partial<ReaderSettings> | null | undefined,
): ReaderSettings {
  const d = DEFAULT_READER_SETTINGS;
  if (!input) return { ...d };
  return {
    prefetchAhead: clampInt(
      input.prefetchAhead ?? d.prefetchAhead,
      READER_SETTINGS_LIMITS.prefetchAhead.min,
      READER_SETTINGS_LIMITS.prefetchAhead.max,
      d.prefetchAhead,
    ),
    prefetchBehind: clampInt(
      input.prefetchBehind ?? d.prefetchBehind,
      READER_SETTINGS_LIMITS.prefetchBehind.min,
      READER_SETTINGS_LIMITS.prefetchBehind.max,
      d.prefetchBehind,
    ),
    maxRenderScale: clampScale(input.maxRenderScale ?? d.maxRenderScale, d.maxRenderScale),
    defaultLoadMode: input.defaultLoadMode === "full" ? "full" : "stream",
  };
}

// Cached snapshot so useSyncExternalStore gets a stable reference between
// changes (a fresh object every read would loop-render).
let snapshot: ReaderSettings | null = null;

export function loadReaderSettings(): ReaderSettings {
  if (snapshot) return snapshot;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    snapshot = normalizeReaderSettings(raw ? JSON.parse(raw) : null);
  } catch {
    snapshot = { ...DEFAULT_READER_SETTINGS };
  }
  return snapshot;
}

export function saveReaderSettings(next: Partial<ReaderSettings>): ReaderSettings {
  const normalized = normalizeReaderSettings(next);
  snapshot = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {}
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
  return normalized;
}

export function resetReaderSettings(): ReaderSettings {
  return saveReaderSettings({ ...DEFAULT_READER_SETTINGS });
}

// --- React binding ---------------------------------------------------------

function subscribe(callback: () => void): () => void {
  const onChange = () => {
    snapshot = null; // invalidate so the next getSnapshot re-reads storage
    callback();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// Subscribes to reader-settings changes — open readers re-render live when the
// settings page (or another tab) updates a value.
export function useReaderSettings(): ReaderSettings {
  return useSyncExternalStore(subscribe, loadReaderSettings, () => DEFAULT_READER_SETTINGS);
}
