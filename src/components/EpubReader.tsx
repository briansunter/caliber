import { useEffect, useRef, useState, useCallback } from "react";
import ePub from "epubjs";
import type { NavItem } from "epubjs";
import {
  ArrowLeft,
  Settings,
  List,
  Minus,
  Plus,
  X,
} from "lucide-react";

interface EpubReaderProps {
  url: string;
  bookId: number;
  onBack: () => void;
  title: string;
}

type ReaderTheme = "light" | "dark" | "sepia";

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

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function EpubReader({ url, bookId, onBack, title }: EpubReaderProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<any>(null);
  const bookRef = useRef<any>(null);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [showUI, setShowUI] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [fontSize, setFontSize] = useState(() => stored("caliber-fontsize", 100));
  const [theme, setTheme] = useState<ReaderTheme>(() => stored("caliber-reader-theme", "light" as ReaderTheme));
  const [locationsReady, setLocationsReady] = useState(false);

  const posKey = `caliber-pos-${bookId}-epub`;

  const goNext = useCallback(() => renditionRef.current?.next(), []);
  const goPrev = useCallback(() => renditionRef.current?.prev(), []);
  const toggleUI = useCallback(() => {
    setShowUI((p) => !p);
    setShowSettings(false);
  }, []);

  // Touch handling on the overlay
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      t: Date.now(),
    };
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchRef.current;
      if (!start) return;
      touchRef.current = null;

      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
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
        const x = e.changedTouches[0].clientX;
        if (x < w * 0.3) goPrev();
        else if (x > w * 0.7) goNext();
        else toggleUI();
      }
    },
    [goPrev, goNext, toggleUI]
  );

  // Click handler for desktop
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const w = window.innerWidth;
      if (e.clientX < w * 0.3) goPrev();
      else if (e.clientX > w * 0.7) goNext();
      else toggleUI();
    },
    [goPrev, goNext, toggleUI]
  );

  // Initialize epub.js
  useEffect(() => {
    if (!viewerRef.current) return;
    let cancelled = false;
    let keyHandler: ((e: KeyboardEvent) => void) | null = null;

    // Fetch the EPUB as binary first (epub.js needs this for zip files served from API)
    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => {
        if (cancelled || !viewerRef.current) return;

        const book = ePub(data as any);
        bookRef.current = book;

        const rendition = book.renderTo(viewerRef.current!, {
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
        rendition.themes.select(theme);
        rendition.themes.fontSize(`${fontSize}%`);

        // Restore position
        let savedCfi: string | null = null;
        try {
          const s = localStorage.getItem(posKey);
          if (s) savedCfi = JSON.parse(s).cfi;
        } catch {}

        rendition.display(savedCfi || undefined).then(() => {
          if (!cancelled) setIsLoading(false);
        });

        // TOC
        book.loaded.navigation.then((nav: any) => {
          if (!cancelled) setToc(nav.toc);
        });

        // Location tracking
        rendition.on("relocated", (location: any) => {
          const cfi = location.start?.cfi;
          if (cfi) {
            try {
              localStorage.setItem(posKey, JSON.stringify({ cfi, ts: Date.now() }));
            } catch {}
          }
        });

        // Generate locations for progress (async, doesn't block)
        book.ready
          .then(() => book.locations.generate(1600))
          .then(() => {
            if (!cancelled) setLocationsReady(true);
          });

        // Keyboard
        keyHandler = (e: KeyboardEvent) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") rendition.prev();
          else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") rendition.next();
          else if (e.key === "Escape") onBack();
        };
        rendition.on("keyup", keyHandler);
        document.addEventListener("keyup", keyHandler);
      });

    return () => {
      cancelled = true;
      if (keyHandler) document.removeEventListener("keyup", keyHandler);
      if (renditionRef.current) renditionRef.current.destroy();
      if (bookRef.current) bookRef.current.destroy();
    };
  }, [url]);

  // Update progress when locations are ready
  useEffect(() => {
    if (!locationsReady || !renditionRef.current || !bookRef.current) return;
    const rendition = renditionRef.current;
    const book = bookRef.current;

    const updateProgress = (location: any) => {
      try {
        const pct = book.locations.percentageFromCfi(location.start.cfi);
        setProgress(Math.round(pct * 100));
      } catch {}
    };

    rendition.on("relocated", updateProgress);
    // Set initial progress
    if (rendition.location?.start?.cfi) {
      updateProgress(rendition.location);
    }
    return () => rendition.off("relocated", updateProgress);
  }, [locationsReady]);

  // Theme changes
  useEffect(() => {
    renditionRef.current?.themes.select(theme);
    try { localStorage.setItem("caliber-reader-theme", JSON.stringify(theme)); } catch {}
  }, [theme]);

  // Font size changes
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
    try { localStorage.setItem("caliber-fontsize", JSON.stringify(fontSize)); } catch {}
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
        <div className="absolute inset-0 z-[115] flex items-center justify-center" style={{ background: bg }}>
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-current/30 border-t-current" style={{ color: fg }} />
            <p className="text-sm" style={{ color: fg, opacity: 0.6 }}>Loading book...</p>
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
          <button onClick={onBack} className="p-2 -ml-1 rounded-lg active:opacity-60" style={{ color: fg }}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span className="text-sm truncate mx-2 flex-1 text-center font-medium" style={{ color: fg }}>
            {title}
          </span>
          <div className="flex items-center">
            <button onClick={() => { setShowToc(true); setShowSettings(false); }} className="p-2 rounded-lg active:opacity-60" style={{ color: fg }}>
              <List className="h-5 w-5" />
            </button>
            <button onClick={() => setShowSettings((s) => !s)} className="p-2 -mr-1 rounded-lg active:opacity-60" style={{ color: fg }}>
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Book viewer + touch overlay */}
      <div className="flex-1 relative min-h-0">
        {/* epub.js renders here */}
        <div ref={viewerRef} className="absolute inset-0" />

        {/* Touch/click overlay */}
        {!isLoading && (
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
            <span>{progress}% read</span>
            <span>Tap edges to turn pages</span>
          </div>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <>
          <div className="fixed inset-0 z-[109]" onClick={() => setShowSettings(false)} />
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
            <button onClick={() => setShowToc(false)} className="p-2 -mr-2 active:opacity-60" style={{ color: fg }}>
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {toc.map((item, i) => (
              <button
                key={i}
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
