import React, { useEffect, useRef, useState, useCallback } from "react";
import ePub from "epubjs";
import type Book from "epubjs/types/book";
import type Rendition from "epubjs/types/rendition";
import type { Location } from "epubjs/types/rendition";
import type { NavItem } from "epubjs/types/navigation";
import type Navigation from "epubjs/types/navigation";
import {
  Settings,
  List,
  Minus,
  Plus,
  X,
  Maximize,
  Minimize,
  ChevronLeft,
  ChevronRight,
  Hand,
  BookOpen,
  Columns2,
  FileText,
} from "lucide-react";
import {
  ReaderErrorPanel,
  ReaderFooterShell,
  ReaderHeader,
  ReaderLoadingOverlay,
  ReaderLoadModeToggle,
  ReaderRoot,
  themedTone,
  useDialogFocusTrap,
} from "./ReaderChrome";
import { stored } from "@/lib/utils";
import { useFullscreen } from "@/lib/use-fullscreen";
import {
  flushBookProgress,
  fetchBookProgress,
  saveBookProgress,
  progressPosKey,
  readScopedPos,
  getLibraryScopeId,
} from "@/lib/reading-progress";
import { getNextReaderLoadMode, type ReaderLoadMode } from "./reader-types";

// Cap on waiting for the initial server-progress restore; a stalled request
// must not keep suppressing server saves for the whole session.
const RESTORE_TIMEOUT_MS = 5000;

interface EpubReaderProps {
  streamUrl: string;
  fullUrl: string;
  bookId: number;
  onBack: () => void;
  title: string;
  initialLoadMode?: ReaderLoadMode;
}

type ReaderTheme = "light" | "dark" | "sepia";

// Page measure: caps how wide the text column may grow. Narrow is full-bleed
// (the previous behavior); Normal/Wide center the column at a comfortable
// measure. The cap only bites on viewports wider than the value, so phones
// are unaffected. Applied to the rendition container (not in-iframe styles)
// so epub.js lays out its fixed-px columns at the capped width.
type EpubMargin = "narrow" | "normal" | "wide";
const EPUB_MARGIN_MAX_WIDTH: Record<EpubMargin, string | undefined> = {
  narrow: undefined,
  normal: "48rem",
  wide: "38rem",
};
const EPUB_MARGINS: EpubMargin[] = ["narrow", "normal", "wide"];

interface SpineItemLike {
  index?: number;
  linear?: boolean | string;
}

type ReaderPointerTarget = EventTarget | null;

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
  } catch (error) {
    noteIgnoredEpubError("parse error body", error);
  }

  return `HTTP ${response.status}`;
}

function isZipArchive(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function fetchFileBytes(
  url: string,
  range?: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    ...(range ? { headers: { Range: range } } : {}),
    ...(signal ? { signal } : {}),
  });
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
  // SAFETY: epubjs has no public spine-items type; the shape is verified at
  // runtime by the Array.isArray filter below, so a mismatch yields [].
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
    } catch (error) {
      noteIgnoredEpubError("read spine end", error);
    }
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
  } catch (error) {
    noteIgnoredEpubError("read CFI progress", error);
  }

  const spinePercent = getSpineProgress(location, book);
  if (spinePercent !== null) return roundProgress(spinePercent);

  return 0;
}

interface EpubPageInfo {
  current: number;
  total: number;
}

function getEpubPageInfo(
  location: Location | null | undefined,
  book: Book | null,
): EpubPageInfo | null {
  const total = book?.locations?.length() ?? 0;
  const cfi = location?.start?.cfi;
  if (!total || !cfi) return null;
  try {
    const index = Number(book?.locations?.locationFromCfi(cfi));
    if (!Number.isFinite(index) || index < 0) return null;
    return { current: Math.min(index + 1, total), total };
  } catch {
    return null;
  }
}

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

type EpubPageLayout = "single" | "double";

// epub.js teardown/pre-warm paths race in-flight async work by design, so
// destroy/navigation/location rejections are routine and unactionable. Log
// them at debug level instead of swallowing silently or interrupting reading
// with UI errors.
function noteIgnoredEpubError(stage: string, error: unknown): void {
  console.debug(`[EpubReader] ignored ${stage} error`, error);
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
  // R5: reactive restore gate. Epub displays the server target directly
  // (fetch → display target), so the gate flips to "ready" right after the
  // fetch settles and BEFORE display — the first relocated event is already
  // the target, so no first-save miss. restoreStateRef mirrors the state
  // for the non-reactive relocated event callback.
  const [restoreState, setRestoreState] = useState<"pending" | "ready">("pending");
  const restoreStateRef = useRef<"pending" | "ready">("pending");
  // R5: keep the event-callback mirror in sync; the state itself drives
  // rerenders so save gating is never ref-only.
  useEffect(() => {
    restoreStateRef.current = restoreState;
  }, [restoreState]);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [htmlDocument, setHtmlDocument] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<ReaderLoadMode>(initialLoadMode);
  const [showUI, setShowUI] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pageInfo, setPageInfo] = useState<EpubPageInfo | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [fontSize, setFontSize] = useState(() => stored("caliber-fontsize", 100));
  const [margins, setMargins] = useState<EpubMargin>(() => {
    const saved = stored("caliber-margins", "normal" as EpubMargin);
    return saved === "narrow" || saved === "normal" || saved === "wide" ? saved : "normal";
  });
  const [theme, setTheme] = useState<ReaderTheme>(() =>
    stored("caliber-reader-theme", "light" as ReaderTheme),
  );
  // Touch/click navigation zones: narrow 15% edges turn pages, the center
  // 70% is interactive book content. In "read" mode a center tap toggles the
  // toolbars; in "interact" mode the center is fully pass-through so links
  // and selections inside the book always work.
  type TouchMode = "read" | "interact";
  const [touchMode, setTouchMode] = useState<TouchMode>(() =>
    stored("caliber-touch-mode", "read" as TouchMode),
  );
  const [isTouchDevice] = useState(() => window.matchMedia("(hover: none)").matches);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  // Single page or side-by-side spread, persisted per book. Applied at
  // rendition creation and toggled live via rendition.spread().
  const spreadKey = `caliber-layout-${getLibraryScopeId()}-${bookId}-epub`;
  const [pageLayout, setPageLayout] = useState<EpubPageLayout>(() =>
    stored(spreadKey, "single" as EpubPageLayout),
  );
  const pageLayoutRef = useRef(pageLayout);

  useEffect(() => {
    try {
      localStorage.setItem("caliber-touch-mode", JSON.stringify(touchMode));
    } catch (error) {
      noteIgnoredEpubError("persist touch mode", error);
    }
  }, [touchMode]);

  const openSettings = useCallback(() => {
    setShowToc(false);
    setShowSettings(true);
  }, []);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  // Focus trap + Esc handling + opener focus-restore for the settings dialog.
  useDialogFocusTrap(showSettings, settingsDialogRef, closeSettings);
  const {
    isFullscreen,
    supported: fullscreenSupported,
    toggle: toggleFullscreen,
  } = useFullscreen();
  const fontSizeRef = useRef(fontSize);
  const themeRef = useRef(theme);
  const showSettingsRef = useRef(showSettings);
  const showTocRef = useRef(showToc);
  const onBackRef = useRef(onBack);

  const posKey = progressPosKey(bookId, "epub");

  const toggleUI = useCallback(() => {
    setShowUI((p) => !p);
    setShowSettings(false);
  }, []);
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
    fontSizeRef.current = fontSize;
  }, [fontSize]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    pageLayoutRef.current = pageLayout;
  }, [pageLayout]);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    showTocRef.current = showToc;
  }, [showToc]);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  // Initialize epub.js. Stream mode reads unpacked entries; full mode loads the archive once.
  useEffect(() => {
    if (!viewerRef.current) return;
    let cancelled = false;
    const abort = new AbortController();
    let keyHandler: ((e: KeyboardEvent) => void) | null = null;
    let contentHandlers: Array<[string, (e: Event) => void]> = [];

    async function openBook() {
      setIsLoading(true);
      // R5: reset the restore gate for each (re)open so a previous book's
      // ready state never unblocks saves for the new book.
      restoreStateRef.current = "pending";
      setRestoreState("pending");
      setLoadError(null);
      setHtmlDocument(null);
      setProgress(0);
      setToc([]);
      lastLocationRef.current = null;

      try {
        let book: Book;
        if (loadMode === "stream") {
          const prefix = await fetchFileBytes(fullUrl, "bytes=0-2047", abort.signal);
          if (abort.signal.aborted || cancelled) return;
          if (!isZipArchive(prefix)) {
            const html = await loadHtmlFallback(fullUrl, prefix);
            if (!html) throw new Error("Invalid EPUB archive");
            if (!cancelled) {
              setLoadMode("full");
              setHtmlDocument(html);
              setIsLoading(false);
            }
            return;
          }

          const containerUrl = streamEntryUrl(streamUrl, "META-INF/container.xml");
          // The stream backend is always same-origin; refuse an off-origin URL
          // so book content can never turn the reader into an open fetcher.
          if (new URL(containerUrl, window.location.href).origin !== window.location.origin) {
            throw new Error("Refusing to load EPUB container from another origin");
          }
          const container = await fetch(containerUrl, {
            signal: abort.signal,
          });
          if (!container.ok) throw new Error(await errorText(container));
          book = ePub(streamUrl, { openAs: "directory" });
        } else {
          const data = await fetchFileBytes(fullUrl, undefined, abort.signal);
          if (abort.signal.aborted || cancelled) return;
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
          } catch (error) {
            noteIgnoredEpubError("destroy book", error);
          }
          return;
        }

        bookRef.current = book;

        const rendition = book.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          // "always" forces facing pages even on narrow screens; the
          // minSpreadWidth floor of 1 keeps epubjs from collapsing the
          // spread back to a single column. "none" is strict single page.
          spread: pageLayoutRef.current === "double" ? "always" : "none",
          minSpreadWidth: 1,
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
          const pct = getEpubProgress(location, bookRef.current);
          setProgress(pct);
          setPageInfo(getEpubPageInfo(location, bookRef.current));

          const cfi = location.start?.cfi;
          if (cfi) {
            try {
              localStorage.setItem(posKey, JSON.stringify({ cfi, ts: Date.now() }));
            } catch (error) {
              noteIgnoredEpubError("persist position", error);
            }
            // Sync to the signed-in user's server-side progress (debounced).
            // Held back until the initial restore attempt settles so a slow or
            // failed fetch can't let this device's older position clobber
            // newer server progress. R5: restoreState (mirrored in
            // restoreStateRef for this event callback) — refs alone don't
            // rerender, so the gate must be state.
            if (restoreStateRef.current === "ready") {
              saveBookProgress(bookId, {
                format: "EPUB",
                location: cfi,
                percentage: pct,
                finished: Boolean(location.atEnd) || pct >= 99,
              });
            }
          }
        });

        // Restore position: prefer the signed-in user's server progress, then
        // fall back to this device's localStorage. F03: a locator from a
        // different format is ignored (local default, no reload loop).
        // F04: scoped key first, legacy key as fallback.
        let savedCfi: string | null = null;
        let timerId: ReturnType<typeof setTimeout> | null = null;
        // R4: format-scoped fetch — EPUB position only.
        const serverProgress = await Promise.race([
          fetchBookProgress(bookId, "EPUB").catch(() => null),
          new Promise<null>((resolve) => {
            timerId = setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS);
          }),
        ]);
        if (timerId) clearTimeout(timerId);
        // R5: fetch settles before display, and display targets the fetched
        // CFI directly — so flipping to ready here is safe. The first
        // relocated event already reflects the server position.
        restoreStateRef.current = "ready";
        setRestoreState("ready");
        if (
          serverProgress?.location &&
          (!serverProgress.format || serverProgress.format.toUpperCase() === "EPUB")
        ) {
          savedCfi = serverProgress.location;
        }
        if (!savedCfi) {
          try {
            const scoped = readScopedPos<{ cfi?: string }>(bookId, "epub", {});
            if (scoped?.cfi) savedCfi = scoped.cfi;
            else {
              const s = localStorage.getItem(posKey);
              if (s) savedCfi = JSON.parse(s).cfi;
            }
          } catch (error) {
            noteIgnoredEpubError("restore position", error);
          }
        }
        // F03: validate CFI shape before restoring; garbage never reaches display().
        if (savedCfi && !savedCfi.startsWith("epubcfi(")) {
          // Allow localStorage's raw CFI variants but drop numeric page strings.
          if (/^\d+$/.test(savedCfi.trim())) savedCfi = null;
        }

        await rendition.display(savedCfi || undefined);
        if (rendition.location) {
          lastLocationRef.current = rendition.location;
          setProgress(getEpubProgress(rendition.location, bookRef.current));
          setPageInfo(getEpubPageInfo(rendition.location, bookRef.current));
        }
        if (!cancelled) setIsLoading(false);

        // TOC
        book.loaded.navigation
          .then((nav: Navigation) => {
            if (!cancelled) setToc(nav.toc);
          })
          .catch((error: unknown) => {
            noteIgnoredEpubError("load table of contents", error);
          });

        // Generate locations for progress (async, doesn't block)
        book.ready
          .then(() => {
            if (cancelled) return;
            return book.locations.generate(1600);
          })
          .then(() => {
            if (!cancelled) {
              const location = lastLocationRef.current ?? rendition.location;
              if (location) {
                setProgress(getEpubProgress(location, bookRef.current));
                setPageInfo(getEpubPageInfo(location, bookRef.current));
              }
            }
          })
          .catch((error: unknown) => {
            noteIgnoredEpubError("generate locations", error);
          });

        const navigateFromPointer = (clientX: number, viewportWidth: number) => {
          // Narrow 15% edge zones turn pages; the center 70% is interactive.
          if (clientX < viewportWidth * 0.15) rendition.prev();
          else if (clientX > viewportWidth * 0.85) rendition.next();
          else toggleUI();
        };

        const contentTouchStart = (e: Event) => {
          if (isInteractiveTarget(e.target)) {
            touchRef.current = null;
            return;
          }

          const touch = (e as TouchEvent).touches?.[0];
          if (!touch) return;
          touchRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            t: Date.now(),
          };
        };

        const contentTouchEnd = (e: Event) => {
          if (isInteractiveTarget(e.target)) {
            touchRef.current = null;
            return;
          }

          const start = touchRef.current;
          if (!start) return;
          touchRef.current = null;

          const event = e as TouchEvent;
          const touch = event.changedTouches?.[0];
          if (!touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          const dt = Date.now() - start.t;

          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500) {
            if (dx > 0) rendition.prev();
            else rendition.next();
            return;
          }

          if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && dt < 300) {
            const viewportWidth = event.view?.innerWidth || window.innerWidth;
            navigateFromPointer(touch.clientX, viewportWidth);
          }
        };

        const contentClick = (e: Event) => {
          if ((e as MouseEvent).defaultPrevented || isInteractiveTarget(e.target)) return;
          const event = e as MouseEvent;
          const viewportWidth = event.view?.innerWidth || window.innerWidth;
          navigateFromPointer(event.clientX, viewportWidth);
        };

        contentHandlers = [
          ["touchstart", contentTouchStart],
          ["touchend", contentTouchEnd],
          ["click", contentClick],
        ];
        for (const [eventName, handler] of contentHandlers) {
          rendition.on(eventName, handler);
        }

        // Keyboard
        keyHandler = (e: KeyboardEvent) => {
          const active = document.activeElement;
          const tag = active?.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          if (showSettingsRef.current || showTocRef.current) {
            if (e.key === "Escape") {
              if (showSettingsRef.current) setShowSettings(false);
              else if (showTocRef.current) setShowToc(false);
            }
            return;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") rendition.prev();
          else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ")
            rendition.next();
          else if (e.key === "f" || e.key === "F") toggleImmersive();
          else if (e.key === "Escape") onBackRef.current();
        };
        rendition.on("keyup", keyHandler);
        document.addEventListener("keyup", keyHandler);
      } catch (error) {
        if (cancelled || abort.signal.aborted) return;

        if (loadMode === "stream") {
          setLoadMode("full");
          return;
        }

        setLoadError(error instanceof Error ? error.message : "Failed to load EPUB");
        setIsLoading(false);
      }
    }

    void openBook().catch((error: unknown) => {
      noteIgnoredEpubError("open book", error);
    });

    return () => {
      cancelled = true;
      abort.abort();
      if (keyHandler) document.removeEventListener("keyup", keyHandler);
      flushBookProgress(bookId);
      const r = renditionRef.current;
      const b = bookRef.current;
      renditionRef.current = null;
      bookRef.current = null;
      if (r) {
        for (const [eventName, handler] of contentHandlers) {
          r.off(eventName, handler);
        }
      }
      if (r)
        try {
          r.destroy();
        } catch (error) {
          noteIgnoredEpubError("destroy rendition", error);
        }
      if (b)
        try {
          b.destroy();
        } catch (error) {
          noteIgnoredEpubError("destroy book", error);
        }
    };
  }, [streamUrl, fullUrl, loadMode, posKey, toggleUI, toggleImmersive, bookId]);

  // Theme changes
  useEffect(() => {
    renditionRef.current?.themes.select(theme);
    try {
      localStorage.setItem("caliber-reader-theme", JSON.stringify(theme));
    } catch (error) {
      noteIgnoredEpubError("persist theme", error);
    }
  }, [theme]);

  // Font size changes
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
    try {
      localStorage.setItem("caliber-fontsize", JSON.stringify(fontSize));
    } catch (error) {
      noteIgnoredEpubError("persist font size", error);
    }
  }, [fontSize]);

  const handleTocNav = useCallback((href: string) => {
    renditionRef.current?.display(href);
    setShowToc(false);
    setShowUI(false);
  }, []);

  // Live spread toggle: epubjs re-layouts the current position, then we
  // re-display the current CFI so facing pages settle deterministically.
  const applyPageLayout = useCallback(
    (next: EpubPageLayout) => {
      setPageLayout(next);
      try {
        localStorage.setItem(spreadKey, JSON.stringify(next));
      } catch (error) {
        noteIgnoredEpubError("persist page layout", error);
      }
      const rendition = renditionRef.current;
      if (!rendition) return;
      void (async () => {
        try {
          rendition.spread(next === "double" ? "always" : "none", 0);
          const cfi = lastLocationRef.current?.start?.cfi ?? rendition.location?.start?.cfi;
          await rendition.display(cfi);
        } catch (error) {
          noteIgnoredEpubError("apply page layout", error);
        }
      })();
    },
    [spreadKey],
  );

  // Live margin change: the container's max-width restyles, then the
  // rendition re-measures and re-displays the current CFI so pagination
  // settles at the same position (same pattern as applyPageLayout). The
  // single-file HTML fallback has no rendition — its iframe picks up the
  // reactive max-width style on its own.
  const applyMargins = useCallback((next: EpubMargin) => {
    setMargins(next);
    try {
      localStorage.setItem("caliber-margins", JSON.stringify(next));
    } catch (error) {
      noteIgnoredEpubError("persist margins", error);
    }
    const rendition = renditionRef.current;
    const container = viewerRef.current;
    if (!rendition || !container) return;
    void (async () => {
      try {
        rendition.resize(container.clientWidth, container.clientHeight);
        const cfi = lastLocationRef.current?.start?.cfi ?? rendition.location?.start?.cfi;
        await rendition.display(cfi);
      } catch (error) {
        noteIgnoredEpubError("apply margins", error);
      }
    })();
  }, []);

  const bg = BG[theme];
  const fg = FG[theme];
  // Centered measure cap for the page column (undefined = full-bleed).
  const maxMeasure = EPUB_MARGIN_MAX_WIDTH[margins];
  const isDark = theme === "dark";
  const subtle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";
  const barBg = isDark ? "rgba(0,0,0,0.88)" : "rgba(255,255,255,0.96)";

  const tone = themedTone({ fg, barBg, subtle });

  return (
    <ReaderRoot bgClassName="" style={{ background: bg }}>
      {/* Loading */}
      {isLoading && (
        <ReaderLoadingOverlay
          message={loadMode === "stream" ? "Streaming book…" : "Loading book…"}
          bg={bg}
          fg={fg}
        />
      )}

      {loadError && (
        <ReaderErrorPanel
          kindLabel="EPUB"
          detail={loadError}
          onRetry={() => setLoadMode("stream")}
          onBack={onBack}
          downloadHref={`/api/books/${bookId}/download/EPUB`}
          bg={bg}
          fg={fg}
          subtle={subtle}
        />
      )}

      {/* Header overlay: position fixed so immersive mode never reserves
          flex space or shifts the page layout. */}
      <ReaderHeader
        title={title}
        showUI={showUI}
        onBack={onBack}
        overlay
        tone={tone}
        actionsClassName="flex items-center"
      >
        <ReaderLoadModeToggle
          loadMode={loadMode}
          onToggle={toggleLoadMode}
          streamLabel="Streaming book"
          fullLabel="Full-file loading"
          tone={tone}
        />
        <button
          type="button"
          onClick={toggleImmersive}
          className="p-2 rounded-lg active:opacity-60"
          style={{ color: fg }}
          aria-label={immersive ? "Show toolbars" : "Hide toolbars"}
          title={immersive ? "Show toolbars (f)" : "Hide toolbars / fullscreen (f)"}
        >
          {immersive ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowToc(true);
            setShowSettings(false);
          }}
          aria-label="Table of contents"
          title="Table of contents"
          className="p-2 rounded-lg active:opacity-60"
          style={{ color: fg }}
        >
          <List className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => setTouchMode((m) => (m === "read" ? "interact" : "read"))}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs active:opacity-60"
          style={{ color: fg }}
          aria-label={
            touchMode === "read"
              ? "Reading mode: tap center toggles toolbars"
              : "Interact mode: center passes through to book content"
          }
          aria-pressed={touchMode === "interact"}
          title={touchMode === "read" ? "Switch to Interact mode" : "Switch to Read mode"}
        >
          {touchMode === "read" ? <BookOpen className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
          <span className="hidden sm:inline">{touchMode === "read" ? "Read" : "Interact"}</span>
        </button>
        <button
          type="button"
          onClick={() => (showSettings ? closeSettings() : openSettings())}
          aria-label="Reader settings"
          aria-haspopup="dialog"
          title="Reader settings"
          className="p-2 -mr-1 rounded-lg active:opacity-60"
          style={{ color: fg }}
        >
          <Settings className="h-5 w-5" />
        </button>
      </ReaderHeader>

      {/* Book viewer + touch overlay */}
      <div className="flex-1 relative min-h-0">
        {htmlDocument ? (
          <iframe
            className="absolute inset-0 mx-auto h-full w-full border-0"
            style={maxMeasure ? { maxWidth: maxMeasure } : undefined}
            title={title}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={htmlDocument}
          />
        ) : (
          <div
            ref={viewerRef}
            className="absolute inset-0 mx-auto h-full w-full"
            style={maxMeasure ? { maxWidth: maxMeasure } : undefined}
          />
        )}

        {/* Real-DOM tap zones over the book. epub.js renders into an iframe
            whose in-page click/touch handlers fire unreliably on iOS Safari, so
            on touch devices navigation and toolbar-toggle live here instead:
            narrow 15% left/right edges page back/forward, the center 70% is
            interactive book content — in Read mode a center tap toggles the
            bars (so you can never get stuck with the toolbar hidden), in
            Interact mode the center is fully pass-through for links and
            selection. Desktop keeps the in-iframe handlers — they work with a
            mouse and preserve clicking links inside the book. */}
        {!isLoading && !htmlDocument && isTouchDevice && (
          <>
            <button
              type="button"
              aria-label="Previous page"
              title="Previous page"
              className="absolute left-0 top-0 bottom-0 z-[106] w-[15%] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none"
              onClick={() => renditionRef.current?.prev()}
            />
            {touchMode === "read" ? (
              <button
                type="button"
                aria-label={showUI ? "Hide toolbars" : "Show toolbars"}
                title={showUI ? "Hide toolbars" : "Show toolbars"}
                className="absolute left-[15%] top-0 bottom-0 z-[106] w-[70%] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none"
                onClick={toggleUI}
              />
            ) : (
              <div
                aria-hidden="true"
                className="absolute left-[15%] top-0 bottom-0 z-[105] w-[70%] pointer-events-none"
              />
            )}
            <button
              type="button"
              aria-label="Next page"
              title="Next page"
              className="absolute right-0 top-0 bottom-0 z-[106] w-[15%] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none"
              onClick={() => renditionRef.current?.next()}
            />
          </>
        )}
      </div>

      {/* Persistent accessible page controls: always available, including in
          immersive mode and for keyboard / screen-reader users. */}
      {!isLoading && !loadError && (
        <div className="fixed bottom-4 left-0 right-0 z-[107] flex items-center justify-between px-4 pointer-events-none">
          <button
            type="button"
            onClick={() => renditionRef.current?.prev()}
            aria-label="Previous page"
            title="Previous page"
            className="pointer-events-auto w-11 h-11 rounded-full flex items-center justify-center shadow-lg active:opacity-70"
            style={{ color: fg, background: barBg, border: `1px solid ${subtle}` }}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => renditionRef.current?.next()}
            aria-label="Next page"
            title="Next page"
            className="pointer-events-auto w-11 h-11 rounded-full flex items-center justify-center shadow-lg active:opacity-70"
            style={{ color: fg, background: barBg, border: `1px solid ${subtle}` }}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Footer overlay: position fixed so immersive mode never reserves
          flex space or shifts the page layout. */}
      <ReaderFooterShell showUI={showUI} overlay tone={tone}>
        <div className="px-4 py-3">
          <div className="w-full h-1 rounded-full" style={{ background: subtle }}>
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${progress}%`,
                background: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)",
              }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-xs" style={{ color: fg, opacity: 0.45 }}>
            <span className="tabular-nums">
              {formatProgress(progress)} read
              {pageInfo ? ` (${pageInfo.current} / ${pageInfo.total})` : ""}
            </span>
            <span>{isTouchDevice ? "Tap edges to turn pages" : "Click edges or use ← → keys"}</span>
            <span>{touchMode === "read" ? "Read mode" : "Interact mode"}</span>
          </div>
        </div>
      </ReaderFooterShell>

      {/* Settings dialog primitive: role=dialog + aria-modal with a focus
          trap and Esc handling (see effect above). */}
      {showSettings && (
        <>
          <button
            type="button"
            aria-label="Close settings"
            className="fixed inset-0 z-[109] cursor-default bg-transparent border-none p-0 m-0 outline-none appearance-none block w-full h-full"
            onClick={closeSettings}
          />
          <div
            ref={settingsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Reader settings"
            className="absolute bottom-0 left-0 right-0 z-[110] rounded-t-2xl shadow-2xl"
            style={{
              background: isDark ? "#1e1e1e" : "#ffffff",
              borderTop: `1px solid ${subtle}`,
              paddingBottom: "env(safe-area-inset-bottom, 16px)",
            }}
          >
            <div className="p-5 space-y-5">
              <div className="flex items-center justify-between">
                <div className="w-10 h-1 rounded-full" style={{ background: subtle }} />
                <button
                  type="button"
                  onClick={closeSettings}
                  aria-label="Close settings"
                  title="Close settings"
                  className="p-1.5 rounded-lg active:opacity-60"
                  style={{ color: fg }}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Font size */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: fg }}>
                  Font Size
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setFontSize((s) => Math.max(60, s - 10))}
                    aria-label="Decrease font size"
                    title="Decrease font size"
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
                    aria-label="Increase font size"
                    title="Increase font size"
                    className="w-9 h-9 rounded-full flex items-center justify-center border active:opacity-60"
                    style={{ color: fg, borderColor: subtle }}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Margins: caps the text column width on wide screens.
                  Narrow is full-bleed; Normal/Wide center a comfortable
                  measure. Narrow screens are unaffected either way. */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: fg }}>
                  Margins
                </span>
                <fieldset
                  className="flex items-center rounded-full border p-1"
                  style={{ borderColor: subtle }}
                >
                  <legend className="sr-only">Margins</legend>
                  {EPUB_MARGINS.map((value) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => applyMargins(value)}
                      aria-pressed={margins === value}
                      aria-label={`${value} margins`}
                      title={
                        value === "narrow"
                          ? "Text fills the screen"
                          : value === "normal"
                            ? "Comfortable reading width"
                            : "Narrow column"
                      }
                      className="rounded-full px-3 py-1.5 text-xs capitalize active:opacity-60"
                      style={{
                        color: fg,
                        background:
                          margins === value
                            ? isDark
                              ? "rgba(255,255,255,0.12)"
                              : "rgba(0,0,0,0.08)"
                            : "transparent",
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </fieldset>
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
                      aria-label={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                      className="w-10 h-10 rounded-full border-2 transition-[box-shadow,border-color,transform] active:scale-95"
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

              {/* Page layout (reflowable books only; the single-file HTML
                  fallback has no spread to toggle) */}
              {!htmlDocument && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: fg }}>
                    Page layout
                  </span>
                  <fieldset
                    className="flex items-center rounded-full border p-1"
                    style={{ borderColor: subtle }}
                  >
                    <legend className="sr-only">Page layout</legend>
                    {(
                      [
                        { value: "single", label: "Single", icon: FileText },
                        { value: "double", label: "Double", icon: Columns2 },
                      ] as const
                    ).map(({ value, label, icon: Icon }) => (
                      <button
                        type="button"
                        key={value}
                        onClick={() => applyPageLayout(value)}
                        aria-pressed={pageLayout === value}
                        aria-label={`${label} page layout`}
                        title={value === "single" ? "One page at a time" : "Two pages side by side"}
                        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs active:opacity-60"
                        style={{
                          color: fg,
                          background:
                            pageLayout === value
                              ? isDark
                                ? "rgba(255,255,255,0.12)"
                                : "rgba(0,0,0,0.08)"
                              : "transparent",
                        }}
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </button>
                    ))}
                  </fieldset>
                </div>
              )}
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
            {toc.length > 0 ? (
              (() => {
                function renderTocItems(items: NavItem[], depth: number): React.ReactNode {
                  return items.map((item) => (
                    <React.Fragment key={item.id || item.href}>
                      <button
                        type="button"
                        onClick={() => handleTocNav(item.href)}
                        className="w-full text-left py-3 text-sm active:opacity-60 transition-opacity"
                        style={{
                          color: depth === 0 ? fg : fg,
                          opacity: depth === 0 ? 1 : 0.75,
                          borderBottom: `1px solid ${subtle}`,
                          paddingLeft: `${20 + depth * 16}px`,
                          paddingRight: "20px",
                        }}
                      >
                        {item.label?.trim()}
                      </button>
                      {item.subitems && item.subitems.length > 0
                        ? renderTocItems(item.subitems, depth + 1)
                        : null}
                    </React.Fragment>
                  ));
                }
                return renderTocItems(toc, 0);
              })()
            ) : (
              <div className="p-8 text-center text-sm" style={{ color: fg, opacity: 0.4 }}>
                No table of contents available
              </div>
            )}
          </div>
        </div>
      )}
    </ReaderRoot>
  );
}
