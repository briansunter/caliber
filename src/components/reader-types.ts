export type ReaderLoadMode = "stream" | "full";

export const READER_PREFETCH_AHEAD = 3;
export const READER_PREFETCH_BEHIND = 1;

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
