import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Expand,
  MoveHorizontal,
} from "lucide-react";
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
import { stored } from "@/lib/utils";
import { useReaderSettings } from "@/lib/reader-settings";
import { useFullscreen } from "@/lib/use-fullscreen";
import {
  flushBookProgress,
  fetchBookProgress,
  saveBookProgress,
  progressPosKey,
  readScopedPos,
  getLibraryScopeId,
} from "@/lib/reading-progress";
import { getNextReaderLoadMode, prefetchOrder, type ReaderLoadMode } from "./reader-types";

// Drop PDF.js's cached page operator lists this often (in page turns). Visiting
// a page caches its parsed content; without periodic cleanup a long read grows
// unbounded and eventually crashes the tab. Re-warming refills the near window.
const PDF_CLEANUP_EVERY = 12;

// Worker setup — served from our API (versioned URL to bust cache)
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=4.10.38";

// Cap on waiting for the initial server-progress restore; a stalled request
// must not keep suppressing server saves for the whole session.
const RESTORE_TIMEOUT_MS = 5000;

// True print size: PDF points are 1/72in, CSS px are 1/96in.
const ACTUAL_SIZE_SCALE = 96 / 72;

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
  const {
    isFullscreen,
    supported: fullscreenSupported,
    toggle: toggleFullscreen,
  } = useFullscreen();

  const posKey = progressPosKey(bookId, "pdf");
  const zoomKey = `caliber-zoom-${getLibraryScopeId()}-${bookId}-pdf`;

  // Zoom modes: "width" fits the page width (default, historic behavior),
  // "page" fits the whole page into the visible area (fit to screen),
  // "actual" renders at true print size (1pt = 1/72in at 96 CSS dpi),
  // "custom" is a manual multiplier on top of fit-width via +/- buttons.
  type PdfFitMode = "width" | "page" | "actual" | "custom";

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(initialLoadMode);
  const [currentPage, setCurrentPage] = useState(
    () => readScopedPos<{ page: number }>(bookId, "pdf", { page: 1 }).page as number,
  );
  const [totalPages, setTotalPages] = useState(0);
  const [showUI, setShowUI] = useState(true);
  const [zoom, setZoom] = useState(() => {
    const saved = stored(zoomKey, { zoom: 1 }) as { zoom?: number; fitMode?: PdfFitMode };
    const z = Number(saved.zoom);
    return Number.isFinite(z) ? Math.min(3, Math.max(0.5, z)) : 1;
  });
  const [fitMode, setFitMode] = useState<PdfFitMode>(() => {
    const saved = stored(zoomKey, {}) as { fitMode?: PdfFitMode };
    return saved.fitMode === "page" || saved.fitMode === "actual" || saved.fitMode === "custom"
      ? saved.fitMode
      : "width";
  });
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  // Last rendered page size in PDF points; lets +/- zoom start from the
  // current fit-page/actual-size scale instead of jumping back to fit-width.
  const pageDimsRef = useRef<{ w: number; h: number } | null>(null);
  // Manual zoom always drops into "custom" so the mode label stays truthful.
  // Stepping from a fit mode starts at that mode's effective scale so the
  // first tap doesn't jump back to fit-width.
  const adjustZoom = useCallback(
    (delta: number) => {
      let start = zoom;
      const container = containerRef.current;
      const dims = pageDimsRef.current;
      if (fitMode !== "custom" && container && dims && container.clientWidth > 0) {
        const fitWidthScale = container.clientWidth / dims.w;
        if (fitWidthScale > 0) {
          const currentAbs =
            fitMode === "actual"
              ? ACTUAL_SIZE_SCALE
              : Math.min(
                  container.clientWidth / dims.w,
                  (container.clientHeight || container.clientWidth) / dims.h,
                );
          if (Number.isFinite(currentAbs)) start = currentAbs / fitWidthScale;
        }
      }
      setZoom(Math.min(3, Math.max(0.5, start + delta)));
      setFitMode("custom");
    },
    [fitMode, zoom],
  );
  const applyFitMode = useCallback((mode: PdfFitMode) => {
    setFitMode(mode);
    setZoomMenuOpen(false);
  }, []);
  // Tap-to-turn zones only make sense when the page is not manually zoomed
  // (fit modes keep them enabled so phones can still page through).
  const isZoomed = fitMode === "custom" && zoom !== 1;
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
    setLoadMode(nextMode);
  }, [loadMode]);

  // "Immersive" = no top/bottom bars. Where the native Fullscreen API exists
  // (desktop, iPad) we also enter real fullscreen; on iPhone the API is absent,
  // so the button just hides the reader's own bars.
  const immersive = fullscreenSupported ? isFullscreen : !showUI;
  const toggleImmersive = useCallback(() => {
    if (fullscreenSupported) toggleFullscreen();
    else setShowUI((v) => !v);
  }, [fullscreenSupported, toggleFullscreen]);

  // Keep the reader's bars hidden while in native fullscreen; restore on exit.
  useEffect(() => {
    if (fullscreenSupported) setShowUI(!isFullscreen);
  }, [isFullscreen, fullscreenSupported]);

  useEffect(() => {
    setLoadMode(initialLoadMode);
  }, [initialLoadMode]);

  useEffect(() => {
    return () => {
      flushBookProgress(bookId);
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
        renderTaskRef.current = null;
      }
      if (pdfRef.current) {
        try {
          pdfRef.current.destroy();
        } catch {}
        pdfRef.current = null;
      }
    };
  }, [bookId]);

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
        setContainerHeight(entry.contentRect.height);
      });
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);
    setContainerHeight(container.clientHeight);
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
      if (isZoomed || isInteractiveTarget(e.target)) {
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
    [isZoomed],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (isZoomed || isInteractiveTarget(e.target)) {
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
    [goPrev, goNext, toggleUI, isZoomed],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (isZoomed || isInteractiveTarget(e.target)) return;
      // Ignore the click synthesized from a touch we already handled
      if (Date.now() - lastTouchEndRef.current < 700) return;

      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI, isZoomed],
  );

  const onReaderKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") toggleUI();
    },
    [toggleUI],
  );

  // Load PDF document. Stream mode lets PDF.js request byte ranges; full mode fetches once.
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    async function loadPdf() {
      setIsLoading(true);
      setLoadError(null);
      setTotalPages(0);

      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
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
          const response = await fetch(url, { signal: abort.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          if (cancelled || abort.signal.aborted) return;
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
          await pdf.destroy().catch(() => {});
          return;
        }

        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        setIsLoading(false);
      } catch (error) {
        if (cancelled || abort.signal.aborted) return;

        if (loadMode === "stream") {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load PDF");
        setIsLoading(false);
      }
    }

    void loadPdf().catch(() => {});

    return () => {
      cancelled = true;
      abort.abort();
      if (loadingTask) {
        try {
          loadingTask.destroy();
        } catch {}
      }
    };
  }, [url, loadMode]);

  const currentPageRef = useRef(currentPage);
  const totalPagesRef = useRef(totalPages);
  // R5: reactive restore gate (refs alone never rerender, which caused the
  // first-save miss). serverTarget === undefined means the fetch has not
  // completed yet; null means fetched with no usable server position.
  // Checkpoint save effect below persists displayedPage only when
  // restoreState === "ready". Settle effect flips to ready on first
  // displayedPage when serverTarget == null, else when
  // displayedPage === serverTarget.
  const [restoreState, setRestoreState] = useState<"pending" | "ready">("pending");
  const [serverTarget, setServerTarget] = useState<number | null | undefined>(undefined);
  // FUP4: explicit checkpoint of the page actually swapped onto the canvas.
  // Set ONLY in the successful canvas-swap callback (with latest-token
  // guard). Saves must use this, never the merely-requested currentPage.
  // Guard: never save page 1 over restored page 20 without display — the
  // save effect below no-ops while displayedPage is null.
  const [displayedPage, setDisplayedPage] = useState<number | null>(null);
  const displayedPageRef = useRef<number | null>(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
    totalPagesRef.current = totalPages;
  });

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
    // Capture the requested page for the async swap; only this value may
    // become displayedPage, and only under the token guard below.
    const requestedPage = currentPage;

    // F06: terminal catch so a rejected getPage never becomes unhandled.
    void pdf
      .getPage(requestedPage)
      .then(async (page) => {
        if (renderTokenRef.current !== token) return;

        const unscaledViewport = page.getViewport({ scale: 1 });
        pageDimsRef.current = {
          w: unscaledViewport.width,
          h: unscaledViewport.height,
        };
        const fitWidthScale = effectiveWidth / unscaledViewport.width;
        let scale: number;
        if (fitMode === "actual") {
          scale = ACTUAL_SIZE_SCALE;
        } else if (fitMode === "page") {
          const effectiveHeight = containerHeight > 0 ? containerHeight : container.clientHeight;
          scale = Math.min(
            effectiveWidth / unscaledViewport.width,
            effectiveHeight / unscaledViewport.height,
          );
        } else {
          // "width" and "custom" both build on fit-width; custom adds the
          // manual +/- multiplier.
          scale = fitWidthScale * (fitMode === "custom" ? zoom : 1);
        }
        const viewport = page.getViewport({ scale });
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
            // F06: release the offscreen backing store in a finally-equivalent
            // path — both success and cancellation free the canvas.
            offscreen.width = 0;
            offscreen.height = 0;
            // FUP4: checkpoint ONLY on successful swap with the latest-token
            // guard. This is the sole writer of displayedPage.
            displayedPageRef.current = requestedPage;
            setDisplayedPage(requestedPage);
            setRendering(false);
          })
          .catch(() => {
            // Release even on cancellation/failure.
            try {
              offscreen.width = 0;
              offscreen.height = 0;
            } catch {}
          }); // Ignore cancellation

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
      })
      .catch(() => {});

    // FUP4: no saves from the render-start path. Persistence lives in the
    // displayedPage save effect below, which only fires after a successful
    // canvas swap.
    // Save zoom
    try {
      localStorage.setItem(zoomKey, JSON.stringify({ zoom, fitMode, ts: Date.now() }));
    } catch {}
  }, [
    currentPage,
    isLoading,
    zoom,
    fitMode,
    containerWidth,
    containerHeight,
    zoomKey,
    pdfLinkService,
    settings.maxRenderScale,
  ]);

  // FUP4 + R5: single checkpoint — save ONLY the successfully displayed
  // page, and only when restoreState === "ready". Deps include
  // displayedPage, restoreState, and totalPages so the first display after
  // the gate opens is never missed (ref-only gating could not rerender).
  useEffect(() => {
    if (displayedPage === null) return;
    try {
      localStorage.setItem(posKey, JSON.stringify({ page: displayedPage, ts: Date.now() }));
    } catch {}
    // Sync to the signed-in user's server-side progress (debounced). Held
    // back until restore settles (see settle effect below) so a slow/failed
    // fetch can't let this device's older page clobber newer server progress.
    if (totalPages > 0 && restoreState === "ready") {
      saveBookProgress(bookId, {
        format: "PDF",
        location: String(displayedPage),
        percentage: (displayedPage / totalPages) * 100,
        finished: displayedPage >= totalPages,
      });
    }
  }, [displayedPage, restoreState, totalPages, posKey, bookId]);

  // Reset the reactive gate when switching books.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId is a prop; reset must run on book change.
  useEffect(() => {
    setRestoreState("pending");
    setServerTarget(undefined);
  }, [bookId]);

  // Restore the signed-in user's server-side page once, after the doc loads.
  // F03: ignore locators from a different format; fall back to local state
  // with no reload loop. R4: format-scoped fetch (PDF only).
  // FUP4: do NOT settle the save gate or queue a catch-up save here. The
  // gate settles in the display-settle effect below, only after the restored
  // (or initial) page has successfully displayed.
  useEffect(() => {
    if (isLoading || totalPages === 0) return;
    if (serverTarget !== undefined) return;
    let cancelled = false;

    void (async () => {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const record = await Promise.race([
        fetchBookProgress(bookId, "PDF").catch(() => null),
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
      if (record.format && record.format.toUpperCase() !== "PDF") {
        setServerTarget(null);
        return;
      }
      const restored = Number.parseInt(record.location, 10);
      if (Number.isFinite(restored) && restored >= 1 && restored <= totalPages) {
        // Record the server target so the settle effect can wait for its
        // display before opening the save gate.
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
  }, [bookId, isLoading, totalPages, serverTarget]);

  // FUP4 + R5: settle the save gate only after successful display. If the
  // server position differed from the initial local page, the catch-up save
  // flows through the checkpoint effect above once ready flips — never
  // before display.
  useEffect(() => {
    if (displayedPage === null) return;
    if (serverTarget === undefined) return;
    if (restoreState === "ready") return;
    if (serverTarget !== null && displayedPage !== serverTarget) return;
    setRestoreState("ready");
  }, [displayedPage, serverTarget, restoreState]);

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
      else if (e.key === "f" || e.key === "F") toggleImmersive();
      else if (e.key === "Escape") onBack();
    };
    document.addEventListener("keyup", handleKey);
    return () => document.removeEventListener("keyup", handleKey);
  }, [goPrev, goNext, onBack, toggleImmersive]);

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <ReaderRoot>
      {/* Loading */}
      {isLoading && (
        <ReaderLoadingOverlay message={loadMode === "stream" ? "Streaming PDF…" : "Loading PDF…"} />
      )}

      {loadError && (
        <ReaderErrorPanel
          kindLabel="PDF"
          detail={loadError}
          onRetry={() => setLoadMode("stream")}
          onBack={onBack}
          downloadHref={`/api/books/${bookId}/download/PDF`}
        />
      )}

      {/* Header */}
      <ReaderHeader title={title} showUI={showUI} onBack={onBack} overlay={false} tone={darkTone()}>
        <ReaderLoadModeToggle
          loadMode={loadMode}
          onToggle={toggleLoadMode}
          streamLabel="Streaming pages"
          fullLabel="Full-file loading"
          tone={darkTone()}
        />
        <button
          type="button"
          onClick={toggleImmersive}
          className="p-2 rounded-lg text-white active:opacity-60"
          aria-label={immersive ? "Show toolbars" : "Hide toolbars"}
          title={immersive ? "Show toolbars (f)" : "Hide toolbars / fullscreen (f)"}
        >
          {immersive ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => adjustZoom(-0.25)}
          aria-label="Zoom out"
          title="Zoom out"
          className="p-2 rounded-lg text-white active:opacity-60"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setZoomMenuOpen((v) => !v)}
            aria-label="Reading size options"
            aria-haspopup="menu"
            aria-expanded={zoomMenuOpen}
            title="Reading size: fit width, fit screen, or actual size"
            className="text-xs text-white/60 w-10 text-center tabular-nums rounded py-1 active:opacity-60"
          >
            {fitMode === "width"
              ? "Fit"
              : fitMode === "page"
                ? "Page"
                : fitMode === "actual"
                  ? "100%"
                  : `${Math.round(zoom * 100)}%`}
          </button>
          {zoomMenuOpen && (
            <>
              <button
                type="button"
                aria-label="Close reading size options"
                className="fixed inset-0 z-[118] cursor-default bg-transparent border-none p-0 m-0"
                onClick={() => setZoomMenuOpen(false)}
              />
              <div
                role="menu"
                aria-label="Reading size"
                className="absolute right-0 top-full z-[119] mt-1 w-44 overflow-hidden rounded-lg border border-white/10 bg-neutral-900 shadow-xl"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={fitMode === "width"}
                  onClick={() => applyFitMode("width")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/80 active:bg-white/10"
                  title="Fit page width"
                >
                  <MoveHorizontal className="h-4 w-4 shrink-0" />
                  Fit width{fitMode === "width" ? " ✓" : ""}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={fitMode === "page"}
                  onClick={() => applyFitMode("page")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/80 active:bg-white/10"
                  title="Fit whole page on screen"
                >
                  <Expand className="h-4 w-4 shrink-0" />
                  Fit screen{fitMode === "page" ? " ✓" : ""}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={fitMode === "actual"}
                  onClick={() => applyFitMode("actual")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/80 active:bg-white/10"
                  title="True print size"
                >
                  <span className="w-4 shrink-0 text-center text-[10px] tabular-nums">1:1</span>
                  Actual size{fitMode === "actual" ? " ✓" : ""}
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => adjustZoom(0.25)}
          aria-label="Zoom in"
          title="Zoom in"
          className="p-2 -mr-1 rounded-lg text-white active:opacity-60"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
      </ReaderHeader>

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
      <ReaderFooterShell showUI={showUI} overlay={false} tone={darkTone()}>
        <div className="px-4 py-3">
          {/* Progress bar */}
          <div className="w-full h-1 rounded-full bg-white/10 mb-2">
            <div
              className="h-full rounded-full bg-white/50 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Page controls */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              title="Previous page"
              className="p-1.5 rounded-lg text-white disabled:opacity-20 active:opacity-60"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex items-center gap-1 text-sm text-white/60 tabular-nums">
              <ReaderPageInput
                value={currentPage}
                max={totalPages || 1}
                onCommit={setCurrentPage}
                describedById="pdf-page-total"
              />
              <span id="pdf-page-total">/ {totalPages}</span>
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              title="Next page"
              className="p-1.5 rounded-lg text-white disabled:opacity-20 active:opacity-60"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </ReaderFooterShell>
    </ReaderRoot>
  );
}
