import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { ChevronLeft, ChevronRight, Wifi, ZoomIn, ZoomOut } from "lucide-react";
import {
  ReaderErrorPanel,
  ReaderFooterShell,
  ReaderHeader,
  ReaderLoadingOverlay,
  ReaderLoadModeToggle,
  ReaderPageInput,
  ReaderRoot,
  darkTone,
} from "./ReaderChrome";
import { useReaderSettings } from "@/lib/reader-settings";
import {
  flushBookProgress,
  fetchBookProgress,
  saveBookProgress,
  progressPosKey,
  readScopedPos,
} from "@/lib/reading-progress";
import { getNextReaderLoadMode, prefetchOrder, type ReaderLoadMode } from "./reader-types";

interface ComicPage {
  index: number;
  href: string;
  type: string;
  name: string;
}

interface ComicManifest {
  pageCount: number;
  pages: ComicPage[];
}

interface ComicReaderProps {
  bookId: number;
  title: string;
  format: "CBZ" | "CBR";
  streamManifestUrl: string;
  fullUrl: string;
  supportsFullFile?: boolean;
  initialLoadMode?: ReaderLoadMode;
  onBack: () => void;
}

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

// Cap on waiting for the initial server-progress restore; a stalled request
// must not keep suppressing server saves for the whole session.
const RESTORE_TIMEOUT_MS = 5000;

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

function imageType(path: string): string {
  switch (extension(path)) {
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function sortPageNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function ComicReader({
  bookId,
  title,
  format,
  streamManifestUrl,
  fullUrl,
  supportsFullFile = true,
  initialLoadMode = "stream",
  onBack,
}: ComicReaderProps) {
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTouchEndRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);
  // F19: full-mode blob store for windowed pagination. Blobs are retained so
  // object URLs outside the visible window can be revoked and re-created.
  const fullBlobsRef = useRef<Map<number, Blob>>(new Map());
  const FULL_BLOB_WINDOW = 3;
  const preloadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const decodedHrefsRef = useRef<Set<string>>(new Set());
  const posKey = progressPosKey(bookId, `comic-${format}`);

  const settings = useReaderSettings();

  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(
    supportsFullFile ? initialLoadMode : "stream",
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [currentPage, setCurrentPage] = useState(
    () => readScopedPos<{ page: number }>(bookId, `comic-${format}`, { page: 1 }).page as number,
  );
  const [showUI, setShowUI] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [displayed, setDisplayed] = useState<ComicPage | null>(null);
  const [pagePending, setPagePending] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const totalPages = pages.length;
  const page = pages[currentPage - 1];

  const clearPreloadedImages = useCallback(() => {
    preloadedImagesRef.current.clear();
    decodedHrefsRef.current.clear();
  }, []);

  const clearObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current = [];
    fullBlobsRef.current.clear();
  }, []);

  const goNext = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, totalPages || p));
  }, [totalPages]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const toggleUI = useCallback(() => setShowUI((p) => !p), []);

  const toggleLoadMode = useCallback(() => {
    if (!supportsFullFile) return;

    const nextMode = getNextReaderLoadMode(loadMode);
    setLoadMode(nextMode);
  }, [loadMode, supportsFullFile]);

  useEffect(() => {
    setLoadMode(supportsFullFile ? initialLoadMode : "stream");
  }, [initialLoadMode, supportsFullFile]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();

    async function loadComic() {
      setIsLoading(true);
      setLoadError(null);
      setPages([]);
      setDisplayed(null);
      setPageError(false);
      clearObjectUrls();
      clearPreloadedImages();

      try {
        if (loadMode === "stream") {
          const response = await fetch(streamManifestUrl, { signal: abort.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const manifest = (await response.json()) as ComicManifest;
          if (cancelled) return;
          setPages(manifest.pages);
          setCurrentPage((p) => Math.min(Math.max(p, 1), manifest.pageCount || 1));
        } else {
          // F06: CBR has no full-file JSZip path — capability-gated, never
          // attempt a full-file fetch for CBR.
          if (format === "CBR") {
            throw new Error("Full-file loading is not supported for CBR");
          }
          const response = await fetch(fullUrl, { signal: abort.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const zip = await JSZip.loadAsync(await response.arrayBuffer());
          const entries = Object.values(zip.files)
            .filter((entry) => !entry.dir && IMAGE_EXTENSIONS.has(extension(entry.name)))
            .sort((a, b) => sortPageNames(a.name, b.name));

          const fullPages: ComicPage[] = [];
          const objectUrls: string[] = [];
          let abortedInLoop = false;
          try {
            for (const [offset, entry] of entries.entries()) {
              if (cancelled || abort.signal.aborted) {
                abortedInLoop = true;
                break;
              }
              const blob = await entry.async("blob");
              if (cancelled || abort.signal.aborted) {
                abortedInLoop = true;
                break;
              }
              // F19: retain the blob for windowed pagination; only the visible
              // window keeps live object URLs (see windowing effect below).
              fullBlobsRef.current.set(offset + 1, blob);
              const href = URL.createObjectURL(blob);
              objectUrls.push(href);
              fullPages.push({
                index: offset + 1,
                href,
                type: imageType(entry.name),
                name: entry.name.split("/").pop() || `Page ${offset + 1}`,
              });
            }
          } catch (loopError) {
            abortedInLoop = cancelled || abort.signal.aborted;
            if (!abortedInLoop) throw loopError;
          }
          if (abortedInLoop || cancelled || abort.signal.aborted) {
            // F06: never leak object URLs on cancellation/failure.
            for (const href of objectUrls) URL.revokeObjectURL(href);
            return;
          }

          if (cancelled) {
            for (const href of objectUrls) URL.revokeObjectURL(href);
            return;
          }

          objectUrlsRef.current = objectUrls;
          setPages(fullPages);
          setCurrentPage((p) => Math.min(Math.max(p, 1), fullPages.length || 1));
        }

        if (!cancelled) setIsLoading(false);
      } catch (error) {
        if (cancelled || abort.signal.aborted) return;

        // F06: stream->full fallback only when the format is capable of it.
        if (loadMode === "stream" && format === "CBZ" && supportsFullFile) {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load comic");
        setIsLoading(false);
      }
    }

    void loadComic().catch(() => {});

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    streamManifestUrl,
    fullUrl,
    loadMode,
    format,
    supportsFullFile,
    clearObjectUrls,
    clearPreloadedImages,
  ]);

  useEffect(() => {
    return () => {
      flushBookProgress(bookId);
      clearObjectUrls();
      clearPreloadedImages();
    };
  }, [bookId, clearObjectUrls, clearPreloadedImages]);

  // F19: full-mode blob pagination — only keep object URLs for the window
  // around the current page; revoke all others to bound browser memory.
  // Blobs stay in fullBlobsRef so revoked pages re-materialize on demand.
  useEffect(() => {
    if (loadMode !== "full" || pages.length === 0) return;
    if (fullBlobsRef.current.size === 0) return;
    const lo = Math.max(1, currentPage - FULL_BLOB_WINDOW);
    const hi = Math.min(pages.length, currentPage + FULL_BLOB_WINDOW);
    let changed = false;
    const next = pages.map((p) => {
      const inWindow = p.index >= lo && p.index <= hi;
      if (!inWindow && p.href.startsWith("blob:")) {
        URL.revokeObjectURL(p.href);
        const idx = objectUrlsRef.current.indexOf(p.href);
        if (idx >= 0) objectUrlsRef.current.splice(idx, 1);
        changed = true;
        return { ...p, href: "" };
      }
      if (inWindow && !p.href) {
        const blob = fullBlobsRef.current.get(p.index);
        if (blob) {
          const href = URL.createObjectURL(blob);
          objectUrlsRef.current.push(href);
          changed = true;
          return { ...p, href };
        }
      }
      return p;
    });
    if (changed) setPages(next);
  }, [loadMode, currentPage, pages]);

  useEffect(() => {
    if (isLoading || pages.length === 0) return;

    const warmOrder = prefetchOrder(
      currentPage,
      1,
      pages.length,
      settings.prefetchAhead,
      settings.prefetchBehind,
    );
    const keep = new Set<string>();
    const currentHref = pages[currentPage - 1]?.href;
    if (currentHref) keep.add(currentHref);

    // Kick off fetch+decode sequentially, nearest-forward first, so the next
    // page always wins the bandwidth race over further-out pages
    let cancelled = false;
    void (async () => {
      for (const pageNumber of warmOrder) {
        if (cancelled) return;
        const candidate = pages[pageNumber - 1];
        if (!candidate) continue;

        keep.add(candidate.href);
        let image = preloadedImagesRef.current.get(candidate.href);
        if (!image) {
          image = new Image();
          image.decoding = "async";
          image.src = candidate.href;
          preloadedImagesRef.current.set(candidate.href, image);
        }
        await image
          .decode?.()
          .then(() => decodedHrefsRef.current.add(candidate.href))
          .catch(() => {
            preloadedImagesRef.current.delete(candidate.href);
            decodedHrefsRef.current.delete(candidate.href);
          });
      }

      if (cancelled) return;
      for (const href of preloadedImagesRef.current.keys()) {
        if (!keep.has(href)) {
          preloadedImagesRef.current.delete(href);
          decodedHrefsRef.current.delete(href);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPage, isLoading, pages, settings.prefetchAhead, settings.prefetchBehind]);

  const currentPageRef = useRef(currentPage);
  const totalPagesRef = useRef(totalPages);
  // R5: reactive restore gate (refs alone never rerender, which caused the
  // first-save miss). serverTarget === undefined means the fetch has not
  // completed yet; null means fetched with no usable server position.
  // Checkpoint save effect below persists the displayed index only when
  // restoreState === "ready". Settle effect flips to ready on first display
  // when serverTarget == null, else when displayed.index === serverTarget.
  const [restoreState, setRestoreState] = useState<"pending" | "ready">("pending");
  const [serverTarget, setServerTarget] = useState<number | null | undefined>(undefined);
  // FUP4: checkpoint of the successfully displayed page index. displayed
  // state itself is set ONLY on successful image onLoad/decode (or an
  // already-decoded instant swap) — never on request. displayedPageRef
  // mirrors it for non-reactive readers.
  // Guard: never save page 1 over restored page 20 without display — the
  // save effect below no-ops while displayed is null.
  const displayedPageRef = useRef<number | null>(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
    totalPagesRef.current = totalPages;
  });

  useEffect(() => {
    // F06/FUP4: mirror the actually displayed page, not the requested one,
    // so a fast page-turn burst never saves a page the user never saw.
    if (displayed) displayedPageRef.current = displayed.index;
  }, [displayed]);

  // FUP4 + R5: single checkpoint — save ONLY the successfully displayed
  // index, and only when restoreState === "ready". Deps include displayed,
  // restoreState, and totalPages so the first display after the gate opens
  // is never missed (ref-only gating could not rerender).
  useEffect(() => {
    if (!displayed) return;
    const shown = displayed.index;
    try {
      localStorage.setItem(posKey, JSON.stringify({ page: shown, ts: Date.now() }));
    } catch {}
    // Sync to the signed-in user's server-side progress (debounced). Held
    // back until restore settles (settle effect below) so a slow/failed
    // fetch can't let this device's older page clobber newer server progress.
    if (totalPages > 0 && restoreState === "ready") {
      saveBookProgress(bookId, {
        format,
        location: String(shown),
        percentage: (shown / totalPages) * 100,
        finished: shown >= totalPages,
      });
    }
  }, [displayed, restoreState, posKey, bookId, totalPages, format]);

  // Reset the reactive gate when switching books/formats.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId/format are props; reset must run on identity change.
  useEffect(() => {
    setRestoreState("pending");
    setServerTarget(undefined);
  }, [bookId, format]);

  // Restore the signed-in user's server-side page once, after pages load.
  // F03: ignore server locators whose format doesn't match this reader and
  // fall back to local state — never trigger a full-file redownload loop.
  // R4: format-scoped fetch (CBZ/CBR only).
  // FUP4: do NOT settle the gate or queue a catch-up save here. Settle
  // happens in the display-settle effect below, only after the restored (or
  // initial) page has successfully displayed.
  useEffect(() => {
    if (totalPages === 0) return;
    if (serverTarget !== undefined) return;
    let cancelled = false;

    void (async () => {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const record = await Promise.race([
        fetchBookProgress(bookId, format).catch(() => null),
        new Promise<null>((resolve) => {
          timerId = setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS);
        }),
      ]);
      if (timerId) clearTimeout(timerId);
      if (cancelled) return;
      if (!record?.location) {
        setServerTarget(null);
        return;
      }
      if (record.format && record.format.toUpperCase() !== format) {
        setServerTarget(null);
        return;
      }
      const restored = Number.parseInt(record.location, 10);
      if (Number.isFinite(restored) && restored >= 1 && restored <= totalPages) {
        setServerTarget(restored);
        if (restored !== currentPageRef.current) {
          setCurrentPage(restored);
        }
      } else {
        setServerTarget(null);
      }
    })().catch(() => {
      if (!cancelled) setServerTarget(null);
    });

    return () => {
      cancelled = true;
    };
  }, [bookId, totalPages, format, serverTarget]);

  // FUP4 + R5: settle the save gate only after successful display. If the
  // server position differed from the initial local page, the catch-up save
  // flows through the checkpoint effect above once ready flips — never
  // before display.
  useEffect(() => {
    if (!displayed) return;
    if (serverTarget === undefined) return;
    if (restoreState === "ready") return;
    if (serverTarget !== null && displayed.index !== serverTarget) return;
    setRestoreState("ready");
  }, [displayed, serverTarget, restoreState]);

  // Double-buffer page turns: if the target page is already decoded (warm
  // buffer), swap instantly with no flash. Otherwise hold the old page only
  // briefly, then advance to a placeholder so fast paging never feels stuck,
  // and swap the real image in when it finishes decoding.
  // biome-ignore lint/correctness/useExhaustiveDependencies(retryToken): retryToken re-triggers the decode after a failed page load
  useEffect(() => {
    if (isLoading || !page) return;
    if (displayed?.href === page.href) return;

    setPageError(false);

    if (decodedHrefsRef.current.has(page.href)) {
      setDisplayed(page);
      setPagePending(false);
      return;
    }

    let cancelled = false;

    // Grace period: imperceptible for fast decodes, then show the placeholder
    const placeholderTimer = setTimeout(() => {
      if (cancelled) return;
      setDisplayed(null);
      setPagePending(true);
    }, 120);

    let image = preloadedImagesRef.current.get(page.href);
    if (!image) {
      image = new Image();
      image.decoding = "async";
      image.src = page.href;
      preloadedImagesRef.current.set(page.href, image);
    }

    const ready: Promise<void> =
      typeof image.decode === "function"
        ? image.decode()
        : image.complete
          ? Promise.resolve()
          : new Promise((resolve, reject) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => reject(new Error("load failed")), {
                once: true,
              });
            });

    ready
      .then(() => {
        decodedHrefsRef.current.add(page.href);
        if (cancelled) return;
        setDisplayed(page);
        setPagePending(false);
      })
      .catch(() => {
        preloadedImagesRef.current.delete(page.href);
        decodedHrefsRef.current.delete(page.href);
        if (cancelled) return;
        setPageError(true);
        setPagePending(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(placeholderTimer);
    };
  }, [page, displayed?.href, isLoading, retryToken]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") goPrev();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") goNext();
      else if (e.key === "Escape") onBack();
    };
    document.addEventListener("keyup", handleKey);
    return () => document.removeEventListener("keyup", handleKey);
  }, [goPrev, goNext, onBack]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      t: Date.now(),
    };
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchRef.current;
      if (!start) return;
      touchRef.current = null;

      // The browser fires a synthesized click after touchend for the same tap;
      // mark the touch as handled so onClick ignores it (else one tap = two pages)
      lastTouchEndRef.current = Date.now();

      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const dt = Date.now() - start.t;

      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500) {
        if (dx > 0) goPrev();
        else goNext();
        return;
      }

      if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && dt < 300) {
        const w = window.innerWidth;
        const x = touch.clientX;
        if (x < w * 0.3) goPrev();
        else if (x > w * 0.7) goNext();
        else toggleUI();
      }
    },
    [goPrev, goNext, toggleUI],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // Ignore the click synthesized from a touch we already handled
      if (Date.now() - lastTouchEndRef.current < 700) return;
      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI],
  );

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <ReaderRoot bgClassName="bg-neutral-950">
      {isLoading && (
        <ReaderLoadingOverlay
          message={loadMode === "stream" ? "Streaming pages…" : "Loading comic…"}
          bgClassName="bg-neutral-950"
        />
      )}

      {loadError && (
        <ReaderErrorPanel
          kindLabel="comic"
          detail={loadError}
          // "Try streaming" is a no-op state set when already streaming
          // (e.g. CBR, which has no full-file path), so hide the retry
          // button there instead of showing a dead control.
          onRetry={loadMode === "stream" ? undefined : () => setLoadMode("stream")}
          onBack={onBack}
          downloadHref={`/api/books/${bookId}/download/${format}`}
          bgClassName="bg-neutral-950"
        />
      )}

      <ReaderHeader title={title} showUI={showUI} onBack={onBack} overlay={false} tone={darkTone()}>
        {supportsFullFile ? (
          <ReaderLoadModeToggle
            loadMode={loadMode}
            onToggle={toggleLoadMode}
            streamLabel="Streaming pages"
            fullLabel="Full-file loading"
            tone={darkTone()}
          />
        ) : (
          <span
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-white/70"
            title="Streaming pages"
          >
            <Wifi className="h-4 w-4" />
            <span className="hidden sm:inline">Stream</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          aria-label="Zoom out"
          title="Zoom out"
          className="rounded-lg p-2 text-white active:opacity-60"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <span className="w-10 text-center text-xs tabular-nums text-white/60">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          aria-label="Zoom in"
          title="Zoom in"
          className="-mr-1 rounded-lg p-2 text-white active:opacity-60"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
      </ReaderHeader>

      <section className="relative min-h-0 flex-1 overflow-auto" aria-label="Comic pages">
        <div className="flex min-h-full items-start justify-center">
          {displayed && (
            <img
              src={displayed.href}
              alt={displayed.name}
              className="block max-w-none"
              style={{
                width: `${Math.round(100 * zoom)}%`,
                maxWidth: zoom <= 1 ? "100%" : "none",
              }}
              draggable={false}
            />
          )}
          {pagePending && !pageError && (
            <div
              className={
                displayed
                  ? "absolute bottom-4 right-4 pointer-events-none"
                  : "absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none"
              }
            >
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
              {!displayed && (
                <p className="text-sm tabular-nums text-white/40">
                  Page {currentPage}
                  {totalPages > 0 ? ` / ${totalPages}` : ""}
                </p>
              )}
            </div>
          )}
          {pageError && page && (
            <div className="absolute inset-0 z-[107] flex flex-col items-center justify-center gap-3 bg-neutral-950/70">
              <p className="text-sm text-white/60">Failed to load page {currentPage}</p>
              <button
                type="button"
                onClick={() => {
                  preloadedImagesRef.current.delete(page.href);
                  setPageError(false);
                  setRetryToken((t) => t + 1);
                }}
                className="rounded bg-white/10 px-3 py-1.5 text-sm text-white active:opacity-70"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {!isLoading && zoom === 1 && (
          <button
            type="button"
            aria-label="Page navigation: tap the left edge for the previous page, the right edge for the next page, or the center to toggle toolbars"
            className="absolute inset-0 z-[106] m-0 block h-full w-full cursor-default appearance-none border-none bg-transparent p-0 outline-none"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onClick={onClick}
          />
        )}
      </section>

      <ReaderFooterShell showUI={showUI} overlay={false} tone={darkTone()}>
        <div className="px-4 py-3">
          <div className="mb-2 h-1 w-full rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white/50 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              title="Previous page"
              className="rounded-lg p-1.5 text-white active:opacity-60 disabled:opacity-20"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex items-center gap-1 text-sm tabular-nums text-white/60">
              <ReaderPageInput
                value={currentPage}
                max={totalPages || 1}
                onCommit={setCurrentPage}
                describedById="comic-page-total"
              />
              <span id="comic-page-total">/ {totalPages || "-"}</span>
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              title="Next page"
              className="rounded-lg p-1.5 text-white active:opacity-60 disabled:opacity-20"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </ReaderFooterShell>
    </ReaderRoot>
  );
}
