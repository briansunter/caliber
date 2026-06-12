import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Wifi, ZoomIn, ZoomOut } from "lucide-react";
import { stored } from "@/lib/utils";
import {
  getNextReaderLoadMode,
  READER_PREFETCH_AHEAD,
  READER_PREFETCH_BEHIND,
  replaceReaderLoadModeInUrl,
  type ReaderLoadMode,
} from "./reader-types";

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
  streamManifestUrl: string;
  fullUrl: string;
  supportsFullFile?: boolean;
  initialLoadMode?: ReaderLoadMode;
  onBack: () => void;
}

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

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
  streamManifestUrl,
  fullUrl,
  supportsFullFile = true,
  initialLoadMode = "stream",
  onBack,
}: ComicReaderProps) {
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const preloadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const posKey = `caliber-pos-${bookId}-comic`;

  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(
    supportsFullFile ? initialLoadMode : "stream",
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [currentPage, setCurrentPage] = useState(() => stored(posKey, { page: 1 }).page as number);
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
  }, []);

  const clearObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current = [];
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
    replaceReaderLoadModeInUrl(nextMode);
    setLoadMode(nextMode);
  }, [loadMode, supportsFullFile]);

  useEffect(() => {
    setLoadMode(supportsFullFile ? initialLoadMode : "stream");
  }, [initialLoadMode, supportsFullFile]);

  useEffect(() => {
    let cancelled = false;

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
          const response = await fetch(streamManifestUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const manifest = (await response.json()) as ComicManifest;
          if (cancelled) return;
          setPages(manifest.pages);
          setCurrentPage((p) => Math.min(Math.max(p, 1), manifest.pageCount || 1));
        } else {
          const response = await fetch(fullUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const zip = await JSZip.loadAsync(await response.arrayBuffer());
          const entries = Object.values(zip.files)
            .filter((entry) => !entry.dir && IMAGE_EXTENSIONS.has(extension(entry.name)))
            .sort((a, b) => sortPageNames(a.name, b.name));

          const fullPages: ComicPage[] = [];
          const objectUrls: string[] = [];
          for (const [offset, entry] of entries.entries()) {
            const blob = await entry.async("blob");
            const href = URL.createObjectURL(blob);
            objectUrls.push(href);
            fullPages.push({
              index: offset + 1,
              href,
              type: imageType(entry.name),
              name: entry.name.split("/").pop() || `Page ${offset + 1}`,
            });
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
        if (cancelled) return;

        if (loadMode === "stream") {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load comic");
        setIsLoading(false);
      }
    }

    void loadComic();

    return () => {
      cancelled = true;
    };
  }, [streamManifestUrl, fullUrl, loadMode, clearObjectUrls, clearPreloadedImages]);

  useEffect(() => {
    return () => {
      clearObjectUrls();
      clearPreloadedImages();
    };
  }, [clearObjectUrls, clearPreloadedImages]);

  useEffect(() => {
    if (isLoading || pages.length === 0) return;

    const keep = new Set<string>();
    const start = Math.max(0, currentPage - 1 - READER_PREFETCH_BEHIND);
    const end = Math.min(pages.length - 1, currentPage - 1 + READER_PREFETCH_AHEAD);

    for (let index = start; index <= end; index += 1) {
      const candidate = pages[index];
      if (!candidate) continue;

      keep.add(candidate.href);
      if (candidate.href === page?.href || preloadedImagesRef.current.has(candidate.href)) continue;

      const image = new Image();
      image.decoding = "async";
      image.src = candidate.href;
      preloadedImagesRef.current.set(candidate.href, image);
      void image.decode?.().catch(() => {});
    }

    for (const href of preloadedImagesRef.current.keys()) {
      if (!keep.has(href)) preloadedImagesRef.current.delete(href);
    }
  }, [currentPage, isLoading, page?.href, pages]);

  useEffect(() => {
    try {
      localStorage.setItem(posKey, JSON.stringify({ page: currentPage, ts: Date.now() }));
    } catch {}
  }, [currentPage, posKey]);

  // Double-buffer page turns: keep the current image on screen until the next
  // one is fully decoded, then swap in a single frame — no blank flash.
  useEffect(() => {
    if (isLoading || !page) return;
    if (displayed?.href === page.href) return;

    let cancelled = false;
    setPageError(false);

    // Only surface a spinner if the decode is actually slow (cold cache)
    const spinnerTimer = setTimeout(() => {
      if (!cancelled) setPagePending(true);
    }, 200);

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
        if (cancelled) return;
        setDisplayed(page);
        setPagePending(false);
      })
      .catch(() => {
        if (cancelled) return;
        preloadedImagesRef.current.delete(page.href);
        setPageError(true);
        setPagePending(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(spinnerTimer);
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
      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI],
  );

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 select-none">
      {isLoading && (
        <div className="absolute inset-0 z-[115] flex items-center justify-center bg-neutral-950">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
            <p className="text-sm text-white/50">
              {loadMode === "stream" ? "Streaming pages..." : "Loading comic..."}
            </p>
          </div>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 z-[115] flex items-center justify-center bg-neutral-950">
          <div className="max-w-sm px-6 text-center">
            <p className="text-sm text-white/70">Failed to load comic: {loadError}</p>
            <button
              type="button"
              onClick={() => setLoadMode("stream")}
              className="mt-4 rounded bg-white/10 px-4 py-2 text-sm text-white active:opacity-70"
            >
              Try streaming
            </button>
          </div>
        </div>
      )}

      <div
        className="shrink-0 z-[108] transition-all duration-200"
        style={{
          transform: showUI ? "translateY(0)" : "translateY(-100%)",
          background: "rgba(0,0,0,0.85)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <div className="flex h-12 items-center justify-between px-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 rounded-lg p-2 text-white active:opacity-60"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span className="mx-2 flex-1 truncate text-center text-sm font-medium text-white">
            {title}
          </span>
          <div className="flex items-center gap-1">
            {supportsFullFile ? (
              <button
                type="button"
                onClick={toggleLoadMode}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-white active:opacity-60"
                aria-label={loadMode === "stream" ? "Streaming pages" : "Full-file loading"}
                title={loadMode === "stream" ? "Streaming pages" : "Full-file loading"}
              >
                {loadMode === "stream" ? (
                  <Wifi className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">
                  {loadMode === "stream" ? "Stream" : "Full"}
                </span>
              </button>
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
              className="-mr-1 rounded-lg p-2 text-white active:opacity-60"
            >
              <ZoomIn className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
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
                  : "absolute inset-0 flex items-center justify-center pointer-events-none"
              }
            >
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
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
            aria-label="Page navigation overlay"
            className="absolute inset-0 z-[106] m-0 block h-full w-full cursor-default appearance-none border-none bg-transparent p-0 outline-none"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onClick={onClick}
          />
        )}
      </div>

      <div
        className="shrink-0 z-[108] transition-all duration-200"
        style={{
          transform: showUI ? "translateY(0)" : "translateY(100%)",
          background: "rgba(0,0,0,0.85)",
          backdropFilter: "blur(12px)",
          borderTop: "1px solid rgba(255,255,255,0.1)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div className="px-4 py-3">
          <div className="mb-2 h-1 w-full rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white/50 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentPage <= 1}
              className="rounded-lg p-1.5 text-white active:opacity-60 disabled:opacity-20"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex items-center gap-1 text-sm tabular-nums text-white/60">
              <input
                type="number"
                min={1}
                max={totalPages || 1}
                value={currentPage}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (Number.isInteger(val) && val >= 1 && val <= (totalPages || 1)) {
                    setCurrentPage(val);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-10 bg-transparent text-center text-sm text-white/60 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none outline-none border-b border-white/20 focus:border-white/50"
                aria-label="Page number"
              />
              <span>/ {totalPages || "-"}</span>
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={currentPage >= totalPages}
              className="rounded-lg p-1.5 text-white active:opacity-60 disabled:opacity-20"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
