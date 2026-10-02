export type ReaderLoadMode = "stream" | "full";

export const READER_PREFETCH_AHEAD = 6;
export const READER_PREFETCH_BEHIND = 2;

// Pages to warm around the current one, closest first, forward before
// backward at equal distance: +1, -1, +2, -2, +3, +4, ...
export function prefetchOrder(
  current: number,
  min: number,
  max: number,
  ahead: number = READER_PREFETCH_AHEAD,
  behind: number = READER_PREFETCH_BEHIND,
): number[] {
  const order: number[] = [];
  for (let d = 1; d <= Math.max(ahead, behind); d += 1) {
    if (d <= ahead && current + d <= max) order.push(current + d);
    if (d <= behind && current - d >= min) order.push(current - d);
  }
  return order;
}

export function normalizeReaderLoadMode(value: string | null | undefined): ReaderLoadMode {
  return value === "full" ? "full" : "stream";
}

export function getNextReaderLoadMode(mode: ReaderLoadMode): ReaderLoadMode {
  return mode === "stream" ? "full" : "stream";
}

// Saved positions are untrusted JSON and a book may have changed since the
// checkpoint was written. Never ask a reader to load NaN or a missing page.
export function normalizeReaderPage(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const page = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) return 1;
  return Math.min(page, Math.max(1, Math.floor(max)));
}

// Large poster-sized PDFs can exceed a browser's canvas limit even with a
// capped device ratio. Bound both dimensions and total backing-store pixels.
export function pdfRenderRatio(width: number, height: number, ratio: number): number {
  if (![width, height, ratio].every((value) => Number.isFinite(value) && value > 0)) return 1;
  return Math.min(ratio, 8192 / width, 8192 / height, Math.sqrt(16_777_216 / (width * height)));
}

export type ReaderKeyboardAction = "previous" | "next" | "immersive" | "back";

export function getReaderKeyboardAction(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented"
  >,
): ReaderKeyboardAction | null {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
    return null;
  if (event.key === " ") return event.shiftKey ? "previous" : "next";
  if (event.shiftKey && event.key.startsWith("Arrow")) return null;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") return "previous";
  if (event.key === "ArrowRight" || event.key === "ArrowDown") return "next";
  if (event.key.toLowerCase() === "f") return "immersive";
  if (event.key === "Escape") return "back";
  return null;
}

// Progress is external JSON. Bad fields must not turn a valid EPUB into a
// book-load error or suppress a usable checkpoint from this device.
export function getEpubRestoreCfi(progress: unknown): string | null {
  if (typeof progress !== "object" || progress === null || Array.isArray(progress)) return null;
  const { location, cfi, format } = progress as Record<string, unknown>;
  if (
    format != null &&
    format !== "" &&
    (typeof format !== "string" || format.toUpperCase() !== "EPUB")
  )
    return null;
  const value = location ?? cfi;
  return typeof value === "string" && value.startsWith("epubcfi(") && value.endsWith(")")
    ? value
    : null;
}
