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

export function replaceReaderLoadModeInUrl(mode: ReaderLoadMode): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  window.history.replaceState(window.history.state, "", url);
}
