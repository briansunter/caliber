import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Download,
  Wifi,
  Maximize,
  Minimize,
} from "lucide-react";
import { stored } from "@/lib/utils";
import { useReaderSettings } from "@/lib/reader-settings";
import { useFullscreen } from "@/lib/use-fullscreen";
import {
  getNextReaderLoadMode,
  prefetchOrder,
  replaceReaderLoadModeInUrl,
  type ReaderLoadMode,
} from "./reader-types";

// Drop PDF.js's cached page operator lists this often (in page turns). Visiting
// a page caches its parsed content; without periodic cleanup a long read grows
// unbounded and eventually crashes the tab. Re-warming refills the near window.
const PDF_CLEANUP_EVERY = 12;

// Worker setup — served from our API (versioned URL to bust cache)
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=4.10.38";

interface PdfReaderProps {
  url: string;
  bookId: number;
  onBack: () => void;
  title: string;
  initialLoadMode?: ReaderLoadMode;
}

interface PdfLinkService {
  eventBus?: { dispatch: () => void };
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  getDestinationHash(dest: unknown): string;
  getAnchorUrl(anchor: string): string;
  goToDestination(dest: unknown): Promise<void>;
  goToPage(page: number | string): void;
  executeNamedAction(action: string): void;
  executeSetOCGState(): Promise<void>;
}

type ReaderPointerTarget = EventTarget | null;

function closestElement(target: ReaderPointerTarget): Element | null {
  const node = target as (Node & { closest?: (selector: string) => Element | null }) | null;
  if (!node) return null;
  if (typeof node.closest === "function") return node.closest("*");
  return node.parentElement ?? null;
}

function isInteractiveTarget(target: ReaderPointerTarget): boolean {
  const element = closestElement(target);
  return Boolean(
    element?.closest(
      [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='link']",
      ].join(","),
    ),
  );
}

export function PdfReader({
  url,
  bookId,
  onBack,
  title,
  initialLoadMode = "stream",
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageLayerRef = useRef<HTMLDivElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderTokenRef = useRef(0);
  const prefetchRunRef = useRef(0);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTouchEndRef = useRef(0);
  const visitsRef = useRef(0);

  const settings = useReaderSettings();
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen();

  const posKey = `caliber-pos-${bookId}-pdf`;
  const zoomKey = `caliber-zoom-${bookId}-pdf`;

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(initialLoadMode);
  const [currentPage, setCurrentPage] = useState(() => stored(posKey, { page: 1 }).page as number);
  const [totalPages, setTotalPages] = useState(0);
  const [showUI, setShowUI] = useState(true);
  const [zoom, setZoom] = useState(() => stored(zoomKey, { zoom: 1 }).zoom as number);
  const [containerWidth, setContainerWidth] = useState(0);
  const [, setRendering] = useState(false);

  const goToPdfDestination = useCallback(async (dest: unknown) => {
    const pdf = pdfRef.current;
    if (!pdf) return;

    const explicitDest =
      typeof dest === "string" ? await pdf.getDestination(dest) : await Promise.resolve(dest);
    if (!Array.isArray(explicitDest)) return;

    const destRef = explicitDest[0];
    let pageNumber: number | null = null;

    if (destRef && typeof destRef === "object") {
      const pdfWithCache = pdf as pdfjsLib.PDFDocumentProxy & {
        cachedPageNumber?: (ref: unknown) => number | null;
      };
      pageNumber = pdfWithCache.cachedPageNumber?.(destRef) ?? null;
      if (!pageNumber) {
        try {
          pageNumber = (await pdf.getPageIndex(destRef as never)) + 1;
        } catch {
          return;
        }
      }
    } else if (Number.isInteger(destRef)) {
      pageNumber = Number(destRef) + 1;
    }

    if (pageNumber && pageNumber >= 1 && pageNumber <= pdf.numPages) {
      setCurrentPage(pageNumber);
    }
  }, []);

  const goNext = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, totalPages || p));
  }, [totalPages]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const toggleUI = useCallback(() => setShowUI((p) => !p), []);
  const toggleLoadMode = useCallback(() => {
    const nextMode = getNextReaderLoadMode(loadMode);
    replaceReaderLoadModeInUrl(nextMode);
    setLoadMode(nextMode);
  }, [loadMode]);

  useEffect(() => {
    setLoadMode(initialLoadMode);
  }, [initialLoadMode]);

  useEffect(() => {
    return () => {
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch {}
        renderTaskRef.current = null;
      }
      if (pdfRef.current) {
        try { pdfRef.current.destroy(); } catch {}
        pdfRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setContainerWidth(entry.contentRect.width);
      });
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const pdfLinkService = useMemo<PdfLinkService>(
    () => ({
      eventBus: { dispatch: () => {} },
      addLinkAttributes(link, targetUrl, newWindow = false) {
        link.href = targetUrl;
        link.title = targetUrl;
        link.target = newWindow ? "_blank" : "_blank";
        link.rel = "noopener noreferrer";
      },
      getDestinationHash(dest) {
        if (typeof dest === "string" && dest) return `#${encodeURIComponent(dest)}`;
        if (Array.isArray(dest)) return `#${encodeURIComponent(JSON.stringify(dest))}`;
        return "#";
      },
      getAnchorUrl(anchor) {
        return anchor;
      },
      goToDestination: goToPdfDestination,
      goToPage(page) {
        const parsed = typeof page === "string" ? Number.parseInt(page, 10) : page;
        const max = pdfRef.current?.numPages ?? totalPages;
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= max) {
          setCurrentPage(parsed);
        }
      },
      executeNamedAction(action) {
        switch (action) {
          case "NextPage":
            setCurrentPage((page) => Math.min(page + 1, pdfRef.current?.numPages ?? page));
            break;
          case "PrevPage":
            setCurrentPage((page) => Math.max(page - 1, 1));
            break;
          case "FirstPage":
            setCurrentPage(1);
            break;
          case "LastPage":
            setCurrentPage(pdfRef.current?.numPages ?? totalPages);
            break;
        }
      },
      executeSetOCGState: async () => {},
    }),
    [goToPdfDestination, totalPages],
  );

  // Touch handling
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (zoom !== 1 || isInteractiveTarget(e.target)) {
        touchRef.current = null;
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;
      touchRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        t: Date.now(),
      };
    },
    [zoom],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (zoom !== 1 || isInteractiveTarget(e.target)) {
        touchRef.current = null;
        return;
      }

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
    [goPrev, goNext, toggleUI, zoom],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (zoom !== 1 || isInteractiveTarget(e.target)) return;
      // Ignore the click synthesized from a touch we already handled
      if (Date.now() - lastTouchEndRef.current < 700) return;

      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI, zoom],
  );

  const onReaderKeyUp = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") toggleUI();
  }, [toggleUI]);

  // Load PDF document. Stream mode lets PDF.js request byte ranges; full mode fetches once.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      setIsLoading(true);
      setLoadError(null);
      setTotalPages(0);

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      if (pdfRef.current) {
        try {
          await pdfRef.current.destroy();
        } catch {}
        pdfRef.current = null;
      }

      try {
        if (loadMode === "full") {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          if (cancelled) return;
          loadingTask = pdfjsLib.getDocument({ data });
        } else {
          loadingTask = pdfjsLib.getDocument({
            url,
            rangeChunkSize: 256 * 1024,
            disableAutoFetch: true,
            disableRange: false,
            disableStream: true,
          });
        }

        const pdf = await loadingTask.promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }

        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        setIsLoading(false);
      } catch (error) {
        if (cancelled) return;

        if (loadMode === "stream") {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load PDF");
        setIsLoading(false);
      }
    }

    void loadPdf();

    return () => {
      cancelled = true;
      if (loadingTask) {
        try {
          loadingTask.destroy();
        } catch {}
      }
    };
  }, [url, loadMode]);

  // Render current page
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const pageLayer = pageLayerRef.current;
    const annotationLayer = annotationLayerRef.current;
    if (!pdf || !canvas || !container || !pageLayer || !annotationLayer || isLoading) return;

    const token = renderTokenRef.current + 1;
    renderTokenRef.current = token;

    // Cancel previous render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    setRendering(true);

    const effectiveWidth = containerWidth > 0 ? containerWidth : container.clientWidth;

    pdf.getPage(currentPage).then(async (page) => {
      if (renderTokenRef.current !== token) return;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const fitScale = effectiveWidth / unscaledViewport.width;
      const viewport = page.getViewport({ scale: fitScale * zoom });
      // Cap the pixel ratio so Retina pages don't allocate 2-3x oversized canvas
      // backing stores — the main driver of Safari's per-tab memory crashes.
      const deviceDpr = window.devicePixelRatio || 1;
      const dpr =
        settings.maxRenderScale > 0 ? Math.min(deviceDpr, settings.maxRenderScale) : deviceDpr;

      // Double-buffer: render offscreen, then blit to the visible canvas in one
      // step so the previous page stays on screen until the new one is ready.
      const offscreen = document.createElement("canvas");
      offscreen.width = viewport.width * dpr;
      offscreen.height = viewport.height * dpr;
      const offCtx = offscreen.getContext("2d");
      if (!offCtx) return;

      const renderTask = page.render({
        canvasContext: offCtx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      renderTaskRef.current = renderTask;

      renderTask.promise
        .then(() => {
          if (renderTokenRef.current !== token) return;
          canvas.width = offscreen.width;
          canvas.height = offscreen.height;
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          pageLayer.style.width = `${viewport.width}px`;
          pageLayer.style.height = `${viewport.height}px`;
          annotationLayer.style.setProperty("--scale-factor", String(viewport.scale));
          canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
          // Release the offscreen backing store immediately. Safari counts
          // detached canvases against the tab budget until GC runs, so leaving
          // them around is what eventually crashes the renderer.
          offscreen.width = 0;
          offscreen.height = 0;
          setRendering(false);
        })
        .catch(() => {}); // Ignore cancellation

      try {
        // Wait for the canvas swap so the layer renders against the new
        // viewport/scale-factor, not the previous page's
        await renderTask.promise;
        const annotations = await page.getAnnotations({ intent: "display" });
        if (renderTokenRef.current !== token) return;
        annotationLayer.innerHTML = "";

        const layer = new pdfjsLib.AnnotationLayer({
          div: annotationLayer,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          page,
          viewport,
          structTreeLayer: null,
        });
        await layer.render({
          viewport,
          div: annotationLayer,
          annotations,
          page,
          linkService: pdfLinkService as never,
          renderForms: false,
        });
      } catch {
        annotationLayer.innerHTML = "";
      }
    });

    // Save position
    try {
      localStorage.setItem(posKey, JSON.stringify({ page: currentPage, ts: Date.now() }));
    } catch {}
    // Save zoom
    try {
      localStorage.setItem(zoomKey, JSON.stringify({ zoom, ts: Date.now() }));
    } catch {}
  }, [
    currentPage,
    isLoading,
    zoom,
    containerWidth,
    posKey,
    zoomKey,
    pdfLinkService,
    settings.maxRenderScale,
  ]);

  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || isLoading || totalPages === 0) return;

    const run = prefetchRunRef.current + 1;
    prefetchRunRef.current = run;

    // Warm sequentially, closest page first, so the most likely next page
    // never waits behind further-out pages
    void (async () => {
      // Periodically purge PDF.js's accumulated page cache so a long read
      // session stays bounded. Guarded — cleanup() rejects mid-render, which is
      // fine: we simply skip and try again next interval. Re-warming below
      // refills the near window.
      visitsRef.current += 1;
      if (visitsRef.current % PDF_CLEANUP_EVERY === 0) {
        try {
          await pdf.cleanup();
        } catch {}
        if (prefetchRunRef.current !== run) return;
      }

      for (const pageNumber of prefetchOrder(
        currentPage,
        1,
        totalPages,
        settings.prefetchAhead,
        settings.prefetchBehind,
      )) {
        if (prefetchRunRef.current !== run) return;
        try {
          const page = await pdf.getPage(pageNumber);
          if (prefetchRunRef.current !== run) return;
          await page.getOperatorList();
        } catch {}
      }
    })();
  }, [currentPage, isLoading, totalPages, settings.prefetchAhead, settings.prefetchBehind]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") goPrev();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") goNext();
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "Escape") onBack();
    };
    document.addEventListener("keyup", handleKey);
    return () => document.removeEventListener("keyup", handleKey);
  }, [goPrev, goNext, onBack, toggleFullscreen]);

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-900 select-none">
      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 z-[115] flex items-center justify-center bg-neutral-900">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
            <p className="text-sm text-white/50">
              {loadMode === "stream" ? "Streaming PDF..." : "Loading PDF..."}
            </p>
          </div>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 z-[115] flex items-center justify-center bg-neutral-900">
          <div className="max-w-sm px-6 text-center">
            <p className="text-sm text-white/70">Failed to load PDF: {loadError}</p>
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

      {/* Header */}
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
        <div className="flex items-center justify-between px-3 h-12">
          <button
            type="button"
            onClick={onBack}
            className="p-2 -ml-1 rounded-lg text-white active:opacity-60"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span className="text-sm text-white truncate mx-2 flex-1 text-center font-medium">
            {title}
          </span>
          <div className="flex items-center gap-1">
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
              <span className="hidden sm:inline">{loadMode === "stream" ? "Stream" : "Full"}</span>
            </button>
            {fullscreenSupported && (
              <button
                type="button"
                onClick={toggleFullscreen}
                className="p-2 rounded-lg text-white active:opacity-60"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                title={isFullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
              >
                {isFullscreen ? (
                  <Minimize className="h-5 w-5" />
                ) : (
                  <Maximize className="h-5 w-5" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className="p-2 rounded-lg text-white active:opacity-60"
            >
              <ZoomOut className="h-5 w-5" />
            </button>
            <span className="text-xs text-white/60 w-10 text-center tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              className="p-2 -mr-1 rounded-lg text-white active:opacity-60"
            >
              <ZoomIn className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Canvas container */}
      <div
        ref={containerRef}
        className="flex-1 relative min-h-0 overflow-auto"
        role="application"
        tabIndex={-1}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={onClick}
        onKeyUp={onReaderKeyUp}
      >
        <div className="flex items-start justify-center min-h-full">
          <div ref={pageLayerRef} className="pdf-page-layer relative">
            <canvas ref={canvasRef} className="block" />
            <div ref={annotationLayerRef} className="annotationLayer pdf-annotation-layer" />
          </div>
        </div>
      </div>

      {/* Footer */}
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
          {/* Progress bar */}
          <div className="w-full h-1 rounded-full bg-white/10 mb-2">
            <div
              className="h-full rounded-full bg-white/50 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Page controls */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentPage <= 1}
              className="p-1.5 rounded-lg text-white disabled:opacity-20 active:opacity-60"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex items-center gap-1 text-sm text-white/60 tabular-nums">
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
              <span>/ {totalPages}</span>
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={currentPage >= totalPages}
              className="p-1.5 rounded-lg text-white disabled:opacity-20 active:opacity-60"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
