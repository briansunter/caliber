import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { ArrowLeft, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from "lucide-react";

// Worker setup — served from our API (versioned URL to bust cache)
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=4.10.38";

interface PdfReaderProps {
  url: string;
  bookId: number;
  onBack: () => void;
  title: string;
}

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function PdfReader({ url, bookId, onBack, title }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<any>(null);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const posKey = `caliber-pos-${bookId}-pdf`;

  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(() => stored(posKey, { page: 1 }).page as number);
  const [totalPages, setTotalPages] = useState(0);
  const [showUI, setShowUI] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [_rendering, setRendering] = useState(false);

  const goNext = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, totalPages || p));
  }, [totalPages]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const toggleUI = useCallback(() => setShowUI((p) => !p), []);

  // Touch handling
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
    [goPrev, goNext, toggleUI]
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI]
  );

  // Load PDF document
  useEffect(() => {
    let cancelled = false;
    pdfjsLib.getDocument(url).promise.then((pdf) => {
      if (cancelled) return;
      pdfRef.current = pdf;
      setTotalPages(pdf.numPages);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Render current page
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!pdf || !canvas || !container || isLoading) return;

    // Cancel previous render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    setRendering(true);

    pdf.getPage(currentPage).then((page) => {
      const containerWidth = container.clientWidth;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / unscaledViewport.width;
      const viewport = page.getViewport({ scale: fitScale * zoom });
      const dpr = window.devicePixelRatio || 1;

      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);

      const renderTask = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = renderTask;

      renderTask.promise
        .then(() => setRendering(false))
        .catch(() => {}); // Ignore cancellation
    });

    // Save position
    try {
      localStorage.setItem(posKey, JSON.stringify({ page: currentPage, ts: Date.now() }));
    } catch {}
  }, [currentPage, isLoading, zoom, posKey]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") goPrev();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") goNext();
      else if (e.key === "Escape") onBack();
    };
    document.addEventListener("keyup", handleKey);
    return () => document.removeEventListener("keyup", handleKey);
  }, [goPrev, goNext, onBack]);

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-900 select-none">
      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 z-[115] flex items-center justify-center bg-neutral-900">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
            <p className="text-sm text-white/50">Loading PDF...</p>
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
          <button onClick={onBack} className="p-2 -ml-1 rounded-lg text-white active:opacity-60">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span className="text-sm text-white truncate mx-2 flex-1 text-center font-medium">
            {title}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className="p-2 rounded-lg text-white active:opacity-60"
            >
              <ZoomOut className="h-5 w-5" />
            </button>
            <span className="text-xs text-white/60 w-10 text-center tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              className="p-2 -mr-1 rounded-lg text-white active:opacity-60"
            >
              <ZoomIn className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Canvas container */}
      <div ref={containerRef} className="flex-1 relative min-h-0 overflow-auto">
        <div className="flex items-start justify-center min-h-full">
          <canvas ref={canvasRef} className="block" />
        </div>

        {/* Touch overlay — only when not zoomed (zoom breaks swipe UX) */}
        {!isLoading && zoom === 1 && (
          <div
            className="absolute inset-0 z-[106]"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onClick={onClick}
          />
        )}
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
              onClick={goPrev}
              disabled={currentPage <= 1}
              className="p-1.5 rounded-lg text-white disabled:opacity-20 active:opacity-60"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm text-white/60 tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <button
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
