import { useCallback, useEffect, useState } from "react";

// Cross-browser Fullscreen API wrapper. Safari (desktop + iPad) still uses the
// webkit-prefixed variants; iPhone Safari doesn't support element fullscreen at
// all, so `supported` is false there and callers can hide the control.

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function activeFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function isFullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement as FullscreenElement;
  return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

function run(fn?: () => Promise<void> | void): void {
  try {
    Promise.resolve(fn?.()).catch(() => {});
  } catch {}
}

export function useFullscreen(): {
  isFullscreen: boolean;
  supported: boolean;
  toggle: () => void;
} {
  const [supported] = useState(isFullscreenSupported);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(activeFullscreenElement()));

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(activeFullscreenElement()));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    const doc = document as FullscreenDocument;
    if (activeFullscreenElement()) {
      run(document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc));
    } else {
      // Fullscreen the whole document — the readers are fixed inset-0 overlays,
      // so this fills the screen and hides the browser chrome/address bar.
      const el = document.documentElement as FullscreenElement;
      run(el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el));
    }
  }, []);

  return { isFullscreen, supported, toggle };
}
