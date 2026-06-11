import { useEffect, useRef, useState, useCallback } from "react";
import ePub from "epubjs";
import type Book from "epubjs/types/book";
import type Rendition from "epubjs/types/rendition";
import type { Location } from "epubjs/types/rendition";
import type { NavItem } from "epubjs/types/navigation";
import type Navigation from "epubjs/types/navigation";
import { ArrowLeft, Settings, List, Minus, Plus, X, Download, Wifi } from "lucide-react";
import { stored } from "@/lib/utils";
import {
  getNextReaderLoadMode,
  replaceReaderLoadModeInUrl,
  type ReaderLoadMode,
} from "./reader-types";

interface EpubReaderProps {
  streamUrl: string;
  fullUrl: string;
  bookId: number;
  onBack: () => void;
  title: string;
  initialLoadMode?: ReaderLoadMode;
}

type ReaderTheme = "light" | "dark" | "sepia";

interface SpineItemLike {
  index?: number;
  linear?: boolean | string;
}

const THEME_STYLES: Record<ReaderTheme, Record<string, Record<string, string>>> = {
  light: {
    body: {
      color: "#1a1a1a !important",
      background: "#ffffff !important",
      "font-family": "Georgia, 'Times New Roman', serif",
      padding: "0 12px !important",
    },
    "p, li, span, div": { "line-height": "1.8 !important" },
  },
  dark: {
    body: {
      color: "#d4d4d4 !important",
      background: "#121212 !important",
      "font-family": "Georgia, 'Times New Roman', serif",
      padding: "0 12px !important",
    },
    "p, li, span, div": { "line-height": "1.8 !important" },
    a: { color: "#93c5fd !important" },
    "h1, h2, h3, h4, h5, h6": { color: "#e5e5e5 !important" },
  },
  sepia: {
    body: {
      color: "#433422 !important",
      background: "#f4ecd8 !important",
      "font-family": "Georgia, 'Times New Roman', serif",
      padding: "0 12px !important",
    },
    "p, li, span, div": { "line-height": "1.8 !important" },
  },
};

const BG: Record<ReaderTheme, string> = {
  light: "#ffffff",
  dark: "#121212",
  sepia: "#f4ecd8",
};

const FG: Record<ReaderTheme, string> = {
  light: "#1a1a1a",
  dark: "#d4d4d4",
  sepia: "#433422",
};

function streamEntryUrl(streamUrl: string, entryPath: string): string {
  return new URL(entryPath, new URL(streamUrl, window.location.href)).toString();
}

async function errorText(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {}

  return `HTTP ${response.status}`;
}

function isZipArchive(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function fetchFileBytes(url: string, range?: string): Promise<ArrayBuffer> {
  const response = await fetch(url, range ? { headers: { Range: range } } : undefined);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

function decodeMaybeHtml(data: ArrayBuffer): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const start = text.slice(0, 512).trimStart().toLowerCase();

  if (
    start.startsWith("<!doctype html") ||
    start.startsWith("<html") ||
    start.startsWith("<head") ||
    start.startsWith("<body")
  ) {
    return text;
  }

  return null;
}

async function loadHtmlFallback(fullUrl: string, prefix?: ArrayBuffer): Promise<string | null> {
  if (prefix && !decodeMaybeHtml(prefix)) return null;

  const data = await fetchFileBytes(fullUrl);
  return decodeMaybeHtml(data);
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function roundProgress(value: number): number {
  const clamped = clampProgress(value);
  if (clamped > 0 && clamped < 10) return Math.round(clamped * 10) / 10;
  return Math.round(clamped);
}

function formatProgress(value: number): string {
  if (value > 0 && value < 10 && !Number.isInteger(value)) {
    return `${value.toFixed(1)}%`;
  }
  return `${Math.round(value)}%`;
}

function fractionToPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampProgress(value <= 1 ? value * 100 : value);
}

function getLinearSpineItems(book: Book | null): SpineItemLike[] {
  const spineItems = (book?.spine as unknown as { spineItems?: SpineItemLike[] } | undefined)
    ?.spineItems;
  if (!Array.isArray(spineItems)) return [];
  return spineItems.filter((item) => item.linear !== false && item.linear !== "no");
}

function getSpineProgress(location: Location, book: Book | null): number | null {
  const startIndex = Number(location.start?.index);
  if (!Number.isFinite(startIndex)) return null;

  const linearItems = getLinearSpineItems(book);
  let sectionCount = linearItems.length;
  let sectionPosition = linearItems.findIndex((item) => item.index === startIndex);

  if (sectionCount === 0) {
    let lastIndex = startIndex;
    try {
      const last = book?.spine?.last();
      if (typeof last?.index === "number") lastIndex = last.index;
    } catch {}
    sectionCount = Math.max(lastIndex + 1, startIndex + 1);
    sectionPosition = startIndex;
  } else if (sectionPosition < 0) {
    sectionPosition = Math.min(Math.max(startIndex, 0), sectionCount - 1);
  }

  if (sectionCount <= 0) return null;

  const page = Number(location.start?.displayed?.page);
  const pageCount = Number(location.start?.displayed?.total);
  const sectionOffset =
    Number.isFinite(page) && Number.isFinite(pageCount) && pageCount > 0
      ? Math.min(Math.max((page - 1) / pageCount, 0), 1)
      : 0;

  return clampProgress(((sectionPosition + sectionOffset) / sectionCount) * 100);
}

function getEpubProgress(location: Location | null | undefined, book: Book | null): number {
  if (!location?.start) return 0;
  if (location.atStart) return 0;
  if (location.atEnd) return 100;

  const locationPercent = fractionToPercent(location.start.percentage);
  if (locationPercent !== null && locationPercent > 0) return roundProgress(locationPercent);

  try {
    const cfi = location.start.cfi;
    const cfiPercent = cfi ? fractionToPercent(book?.locations?.percentageFromCfi(cfi)) : null;
    if (cfiPercent !== null && cfiPercent > 0) return roundProgress(cfiPercent);
  } catch {}

  const spinePercent = getSpineProgress(location, book);
  if (spinePercent !== null) return roundProgress(spinePercent);

  return 0;
}

export function EpubReader({
  streamUrl,
  fullUrl,
  bookId,
  onBack,
  title,
  initialLoadMode = "stream",
}: EpubReaderProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  const lastLocationRef = useRef<Location | null>(null);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [htmlDocument, setHtmlDocument] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(initialLoadMode);
  const [showUI, setShowUI] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [fontSize, setFontSize] = useState(() => stored("caliber-fontsize", 100));
  const [theme, setTheme] = useState<ReaderTheme>(() =>
    stored("caliber-reader-theme", "light" as ReaderTheme),
  );
  const fontSizeRef = useRef(fontSize);
  const themeRef = useRef(theme);

  const posKey = `caliber-pos-${bookId}-epub`;

  const goNext = useCallback(() => renditionRef.current?.next(), []);
  const goPrev = useCallback(() => renditionRef.current?.prev(), []);
  const toggleUI = useCallback(() => {
    setShowUI((p) => !p);
    setShowSettings(false);
  }, []);
  const toggleLoadMode = useCallback(() => {
    const nextMode = getNextReaderLoadMode(loadMode);
    replaceReaderLoadModeInUrl(nextMode);
    setLoadMode(nextMode);
  }, [loadMode]);

  useEffect(() => {
    setLoadMode(initialLoadMode);
  }, [initialLoadMode]);

  useEffect(() => {
    fontSizeRef.current = fontSize;
  }, [fontSize]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  // Touch handling on the overlay
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

      // Swipe (horizontal, >50px, <500ms)
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500) {
        if (dx > 0) goPrev();
        else goNext();
        return;
      }

      // Tap (minimal movement, <300ms)
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

  // Click handler for desktop
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI],
  );

  // Initialize epub.js. Stream mode reads unpacked entries; full mode loads the archive once.
  useEffect(() => {
    if (!viewerRef.current) return;
    let cancelled = false;
    let keyHandler: ((e: KeyboardEvent) => void) | null = null;

    async function openBook() {
      setIsLoading(true);
      setLoadError(null);
      setHtmlDocument(null);
      setProgress(0);
      setToc([]);
      lastLocationRef.current = null;

      try {
        let book: Book;
        if (loadMode === "stream") {
          const prefix = await fetchFileBytes(fullUrl, "bytes=0-2047");
          if (!isZipArchive(prefix)) {
            const html = await loadHtmlFallback(fullUrl, prefix);
            if (!html) throw new Error("Invalid EPUB archive");
            if (!cancelled) {
              setLoadMode("full");
              replaceReaderLoadModeInUrl("full");
              setHtmlDocument(html);
              setIsLoading(false);
            }
            return;
          }

          const container = await fetch(streamEntryUrl(streamUrl, "META-INF/container.xml"));
          if (!container.ok) throw new Error(await errorText(container));
          book = ePub(streamUrl, { openAs: "directory" });
        } else {
          const data = await fetchFileBytes(fullUrl);
          if (!isZipArchive(data)) {
            const html = decodeMaybeHtml(data);
            if (!html) throw new Error("Invalid EPUB archive");
            if (!cancelled) {
              setHtmlDocument(html);
              setIsLoading(false);
            }
            return;
          }
          book = ePub(data as ArrayBuffer & string);
        }

        if (cancelled || !viewerRef.current) {
          try {
            book.destroy();
          } catch {}
          return;
        }

        bookRef.current = book;

        const rendition = book.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "none",
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;

        // Themes
        for (const [name, styles] of Object.entries(THEME_STYLES)) {
          rendition.themes.register(name, styles);
        }
        rendition.themes.select(themeRef.current);
        rendition.themes.fontSize(`${fontSizeRef.current}%`);

        // Location tracking
        rendition.on("relocated", (location: Location) => {
          lastLocationRef.current = location;
          setProgress(getEpubProgress(location, bookRef.current));

          const cfi = location.start?.cfi;
          if (cfi) {
            try {
              localStorage.setItem(posKey, JSON.stringify({ cfi, ts: Date.now() }));
            } catch {}
          }
        });

        // Restore position
        let savedCfi: string | null = null;
        try {
          const s = localStorage.getItem(posKey);
          if (s) savedCfi = JSON.parse(s).cfi;
        } catch {}

        await rendition.display(savedCfi || undefined);
        if (rendition.location) {
          lastLocationRef.current = rendition.location;
          setProgress(getEpubProgress(rendition.location, bookRef.current));
        }
        if (!cancelled) setIsLoading(false);

        // TOC
        book.loaded.navigation
          .then((nav: Navigation) => {
            if (!cancelled) setToc(nav.toc);
          })
          .catch(() => {});

        // Generate locations for progress (async, doesn't block)
        book.ready
          .then(() => {
            if (cancelled) return;
            return book.locations.generate(1600);
          })
          .then(() => {
            if (!cancelled) {
              const location = lastLocationRef.current ?? rendition.location;
              if (location) setProgress(getEpubProgress(location, bookRef.current));
            }
          })
          .catch(() => {});

        // Keyboard
        keyHandler = (e: KeyboardEvent) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") rendition.prev();
          else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ")
            rendition.next();
          else if (e.key === "Escape") onBack();
        };
        rendition.on("keyup", keyHandler);
        document.addEventListener("keyup", keyHandler);
      } catch (error) {
        if (cancelled) return;

        if (loadMode === "stream") {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load EPUB");
        setIsLoading(false);
      }
    }

    void openBook();

    return () => {
      cancelled = true;
      if (keyHandler) document.removeEventListener("keyup", keyHandler);
      const r = renditionRef.current;
      const b = bookRef.current;
      renditionRef.current = null;
      bookRef.current = null;
      if (r)
        try {
          r.destroy();
        } catch {}
      if (b)
        try {
          b.destroy();
        } catch {}
    };
  }, [streamUrl, fullUrl, loadMode, onBack, posKey]);

  // Theme changes
  useEffect(() => {
    renditionRef.current?.themes.select(theme);
    try {
      localStorage.setItem("caliber-reader-theme", JSON.stringify(theme));
    } catch {}
  }, [theme]);

  // Font size changes
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
    try {
      localStorage.setItem("caliber-fontsize", JSON.stringify(fontSize));
    } catch {}
  }, [fontSize]);

  const handleTocNav = useCallback((href: string) => {
    renditionRef.current?.display(href);
    setShowToc(false);
    setShowUI(false);
  }, []);

  const bg = BG[theme];
  const fg = FG[theme];
  const isDark = theme === "dark";
  const subtle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";
  const barBg = isDark ? "rgba(0,0,0,0.88)" : "rgba(255,255,255,0.96)";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col select-none" style={{ background: bg }}>
      {/* Loading */}
      {isLoading && (
        <div
          className="absolute inset-0 z-[115] flex items-center justify-center"
          style={{ background: bg }}
        >
          <div className="flex flex-col items-center gap-3">
            <div
              className="h-8 w-8 animate-spin rounded-full border-2 border-current/30 border-t-current"
              style={{ color: fg }}
            />
            <p className="text-sm" style={{ color: fg, opacity: 0.6 }}>
              {loadMode === "stream" ? "Streaming book..." : "Loading book..."}
            </p>
          </div>
        </div>
      )}

      {loadError && (
        <div
          className="absolute inset-0 z-[115] flex items-center justify-center"
          style={{ background: bg }}
        >
          <div className="max-w-sm px-6 text-center">
            <p className="text-sm" style={{ color: fg, opacity: 0.75 }}>
              Failed to load EPUB: {loadError}
            </p>
            <button
              type="button"
              onClick={() => setLoadMode("stream")}
              className="mt-4 rounded px-4 py-2 text-sm active:opacity-70"
              style={{ color: fg, border: `1px solid ${subtle}` }}
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
          background: barBg,
          backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${subtle}`,
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <div className="flex items-center justify-between px-3 h-12">
          <button
            type="button"
            onClick={onBack}
            className="p-2 -ml-1 rounded-lg active:opacity-60"
            style={{ color: fg }}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span
            className="text-sm truncate mx-2 flex-1 text-center font-medium"
            style={{ color: fg }}
          >
            {title}
          </span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={toggleLoadMode}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs active:opacity-60"
              style={{ color: fg }}
              aria-label={loadMode === "stream" ? "Streaming book" : "Full-file loading"}
              title={loadMode === "stream" ? "Streaming book" : "Full-file loading"}
            >
              {loadMode === "stream" ? (
                <Wifi className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">{loadMode === "stream" ? "Stream" : "Full"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowToc(true);
                setShowSettings(false);
              }}
              className="p-2 rounded-lg active:opacity-60"
              style={{ color: fg }}
            >
              <List className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              className="p-2 -mr-1 rounded-lg active:opacity-60"
              style={{ color: fg }}
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Book viewer + touch overlay */}
      <div className="flex-1 relative min-h-0">
        {htmlDocument ? (
          <iframe
            className="absolute inset-0 h-full w-full border-0"
            title={title}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={htmlDocument}
          />
        ) : (
          <div ref={viewerRef} className="absolute inset-0" />
        )}

        {!isLoading && !htmlDocument && (
          <button
            type="button"
            aria-label="Page navigation overlay"
            className="absolute inset-0 z-[106] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none block w-full h-full"
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
          background: barBg,
          backdropFilter: "blur(12px)",
          borderTop: `1px solid ${subtle}`,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div className="px-4 py-3">
          <div className="w-full h-1 rounded-full" style={{ background: subtle }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                background: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)",
              }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-xs" style={{ color: fg, opacity: 0.45 }}>
            <span>{formatProgress(progress)} read</span>
            <span>Tap edges to turn pages</span>
          </div>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <>
          <button
            type="button"
            aria-label="Close settings"
            className="fixed inset-0 z-[109] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none block w-full h-full"
            onClick={() => setShowSettings(false)}
          />
          <div
            className="absolute bottom-0 left-0 right-0 z-[110] rounded-t-2xl shadow-2xl"
            style={{
              background: isDark ? "#1e1e1e" : "#ffffff",
              borderTop: `1px solid ${subtle}`,
              paddingBottom: "env(safe-area-inset-bottom, 16px)",
            }}
          >
            <div className="p-5 space-y-5">
              <div className="w-10 h-1 rounded-full mx-auto" style={{ background: subtle }} />

              {/* Font size */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: fg }}>
                  Font Size
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setFontSize((s) => Math.max(60, s - 10))}
                    className="w-9 h-9 rounded-full flex items-center justify-center border active:opacity-60"
                    style={{ color: fg, borderColor: subtle }}
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="text-sm w-12 text-center tabular-nums" style={{ color: fg }}>
                    {fontSize}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setFontSize((s) => Math.min(200, s + 10))}
                    className="w-9 h-9 rounded-full flex items-center justify-center border active:opacity-60"
                    style={{ color: fg, borderColor: subtle }}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: fg }}>
                  Theme
                </span>
                <div className="flex items-center gap-3">
                  {(["light", "dark", "sepia"] as ReaderTheme[]).map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setTheme(t)}
                      className="w-10 h-10 rounded-full border-2 transition-all active:scale-95"
                      style={{
                        background: BG[t],
                        borderColor: theme === t ? "#3b82f6" : subtle,
                        boxShadow: theme === t ? "0 0 0 2px #3b82f6" : "none",
                      }}
                      title={t.charAt(0).toUpperCase() + t.slice(1)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* TOC panel */}
      {showToc && (
        <div className="absolute inset-0 z-[112] flex flex-col" style={{ background: bg }}>
          <div
            className="flex items-center justify-between px-4 h-12 shrink-0"
            style={{
              borderBottom: `1px solid ${subtle}`,
              paddingTop: "env(safe-area-inset-top, 0px)",
            }}
          >
            <h2 className="text-sm font-semibold" style={{ color: fg }}>
              Contents
            </h2>
            <button
              type="button"
              onClick={() => setShowToc(false)}
              className="p-2 -mr-2 active:opacity-60"
              style={{ color: fg }}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {toc.map((item) => (
              <button
                type="button"
                key={item.href}
                onClick={() => handleTocNav(item.href)}
                className="w-full text-left px-5 py-3.5 text-sm active:opacity-60 transition-opacity"
                style={{
                  color: fg,
                  borderBottom: `1px solid ${subtle}`,
                }}
              >
                {item.label?.trim()}
              </button>
            ))}
            {toc.length === 0 && (
              <div className="p-8 text-center text-sm" style={{ color: fg, opacity: 0.4 }}>
                No table of contents available
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
