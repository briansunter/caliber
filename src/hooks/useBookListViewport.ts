import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { BookListItem } from "@/lib/calibre-optimized";
import {
  bookAnchorScrollTop,
  visibleBookAnchor,
  type BookScrollAnchor,
} from "@/lib/book-list-layout";
import type { useFlattenedBooks } from "./useBooksInfinite";

/** Observe layout changes without subscribing to virtual row style mutations. */
export function useBookListLayout() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({ width: 320, scrollMargin: 0, measured: false });

  useLayoutEffect(() => {
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const width = element.clientWidth;
      const scrollMargin = Math.max(0, element.getBoundingClientRect().top + window.scrollY);
      if (width <= 0) return;
      setLayout((previous) =>
        previous.width === width && previous.scrollMargin === scrollMargin && previous.measured
          ? previous
          : { width, scrollMargin, measured: true },
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);

    // Previous siblings include the sticky toolbar and any expandable shelves.
    // Direct child mutations let us attach to newly mounted siblings, without
    // observing each virtual row (which changes during every scroll).
    const observeLayout = () => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(element);
      let node: HTMLElement | null = element;
      while (node) {
        resizeObserver?.observe(node);
        let sibling = node.previousElementSibling;
        while (sibling) {
          resizeObserver?.observe(sibling);
          sibling = sibling.previousElementSibling;
        }
        node = node.parentElement;
      }
      scheduleMeasure();
    };
    const structureObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(observeLayout);
    // Never observe the virtual container's children: rows mount on every scroll.
    let ancestor: HTMLElement | null = element.parentElement;
    while (ancestor) {
      structureObserver?.observe(ancestor, { childList: true });
      ancestor = ancestor.parentElement;
    }
    observeLayout();
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      structureObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [element]);

  return { ...layout, element, setElement };
}

type FetchNextPage = ReturnType<typeof useFlattenedBooks>["fetchNextPage"];
const STORAGE_KEY = "caliber-book-positions-v2";
const MAX_SAVED_POSITIONS = 12;

interface SavedAnchor extends BookScrollAnchor {
  savedAt: number;
}

function readPositions(): Record<string, SavedAnchor> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const positions: Record<string, SavedAnchor> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const anchor = value as Partial<SavedAnchor>;
      if (
        typeof anchor.id === "number" &&
        Number.isSafeInteger(anchor.id) &&
        anchor.id > 0 &&
        typeof anchor.offset === "number" &&
        Number.isFinite(anchor.offset) &&
        anchor.offset >= 0 &&
        typeof anchor.savedAt === "number" &&
        Number.isFinite(anchor.savedAt)
      )
        positions[key] = anchor as SavedAnchor;
    }
    return positions;
  } catch {
    return {};
  }
}

function savePosition(identity: string, anchor: BookScrollAnchor | null) {
  try {
    const positions = readPositions();
    if (anchor) positions[identity] = { ...anchor, savedAt: Date.now() };
    else delete positions[identity];
    const retained = Object.fromEntries(
      Object.entries(positions)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, MAX_SAVED_POSITIONS),
    );
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(retained));
  } catch {
    // Storage is optional (private browsing and quota limits must not break a list).
  }
}

interface BookScrollRestorationOptions {
  identity: string;
  books: BookListItem[];
  columns: number;
  rowHeight: number;
  scrollMargin: number;
  stickyOffset: number;
  ready: boolean;
  hasNextPage: boolean;
  fetchNextPage: FetchNextPage;
  virtualizer: Virtualizer<Window, Element>;
}

/** Restore once per query/view, then let scrolling and pagination proceed freely. */
export function useBookScrollRestoration(options: BookScrollRestorationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const attemptedIdentity = useRef<string | null>(null);
  const restoring = useRef(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const { identity, ready } = options;

  useEffect(() => {
    if (!ready || attemptedIdentity.current === identity) return;
    attemptedIdentity.current = identity;
    const saved = readPositions()[identity];
    if (!saved) {
      setIsRestoring(false);
      return;
    }
    let cancelled = false;
    let disposed = false;
    let settled = false;
    restoring.current = true;
    setIsRestoring(true);
    const cancelForInteraction = () => {
      cancelled = true;
      restoring.current = false;
      setIsRestoring(false);
      cleanupListeners();
    };
    window.addEventListener("wheel", cancelForInteraction, { passive: true });
    window.addEventListener("touchstart", cancelForInteraction, { passive: true });
    window.addEventListener("pointerdown", cancelForInteraction, { passive: true });
    window.addEventListener("keydown", cancelForInteraction);
    const cleanupListeners = () => {
      window.removeEventListener("wheel", cancelForInteraction);
      window.removeEventListener("touchstart", cancelForInteraction);
      window.removeEventListener("pointerdown", cancelForInteraction);
      window.removeEventListener("keydown", cancelForInteraction);
    };
    const run = async () => {
      try {
        // Router restoration and the virtualizer attach during the same commit.
        // Restore after they settle so their initial scroll offset cannot win.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        for (let attempt = 0; attempt <= 10 && !cancelled; attempt++) {
          const current = latest.current;
          if (current.identity !== identity) return;
          const index = current.books.findIndex((book) => book.id === saved.id);
          if (index >= 0) {
            current.virtualizer.scrollToOffset(
              bookAnchorScrollTop(
                index,
                current.columns,
                current.rowHeight,
                current.scrollMargin,
                current.stickyOffset,
                saved.offset,
              ),
            );
            return;
          }
          if (!current.hasNextPage || attempt === 10) break;
          const result = await current.fetchNextPage({ cancelRefetch: false });
          if (result.isError) break;
          // Let React publish the newly flattened, deduplicated retained window.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      } finally {
        settled = true;
        cleanupListeners();
        if (!disposed && latest.current.identity === identity) {
          restoring.current = false;
          setIsRestoring(false);
        }
      }
    };
    void run().catch(() => {});
    return () => {
      cancelled = true;
      disposed = true;
      // StrictMode replays mount effects. An interrupted attempt must remain
      // eligible for the replay, while successful restores stay one-shot.
      if (!settled && attemptedIdentity.current === identity) attemptedIdentity.current = null;
      restoring.current = false;
      cleanupListeners();
    };
  }, [identity, ready]);

  useEffect(() => {
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: BookScrollAnchor | null | undefined;
    let navigating = false;
    const capture = () => {
      const current = latest.current;
      if (current.identity !== identity || !current.ready || restoring.current || navigating)
        return;
      snapshot = visibleBookAnchor(
        current.books,
        current.columns,
        current.rowHeight,
        current.scrollMargin,
        window.scrollY,
        current.stickyOffset,
      );
    };
    const persist = () => {
      clearTimeout(timer);
      if (snapshot !== undefined) savePosition(identity, snapshot);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        capture();
        clearTimeout(timer);
        timer = setTimeout(persist, 180);
      });
    };
    const onPageHide = () => {
      capture();
      persist();
    };
    const onNavigation = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.hasAttribute("download") ||
        (target.target && target.target !== "_self")
      )
        return;
      const destination = new URL(target.href, window.location.href);
      if (
        destination.origin === window.location.origin &&
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      )
        return;
      capture();
      persist();
      navigating = true;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("click", onNavigation, true);
    return () => {
      cancelAnimationFrame(frame);
      // The router resets the window before passive unmount cleanups run.
      // Persist the position captured before navigation, not that reset.
      persist();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("click", onNavigation, true);
    };
  }, [identity]);

  return isRestoring;
}
