import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Download, Wifi } from "lucide-react";
import type { ReaderLoadMode } from "./reader-types";

// Shared reader chrome for the EPUB / PDF / comic readers (batch 4, item 8).
// One spelling per concept: dark in-flow chrome vs. themed overlay chrome,
// a single loading overlay, a single error panel, and a single load-mode
// toggle. Visuals are preserved via props — no behavior change.

export interface ReaderThemedChrome {
  fg: string;
  barBg: string;
  subtle: string;
}

type HeaderTone = { kind: "dark" } | { kind: "themed"; chrome: ReaderThemedChrome };

export function darkTone(): HeaderTone {
  return { kind: "dark" };
}

export function themedTone(chrome: ReaderThemedChrome): HeaderTone {
  return { kind: "themed", chrome };
}

// Focus trap + Escape handling + opener focus-restore for reader dialogs.
// On activation, focuses the first focusable inside the dialog; Tab cycles
// within it; Escape calls onClose; on teardown, focus returns to the opener
// (explicit ref wins, otherwise the element focused at activation time).
export function useDialogFocusTrap(
  active: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocusTo?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dialogRef/returnFocusTo are stable refs read at activation; onClose rides onCloseRef.
  useEffect(() => {
    if (!active) return;
    const opener =
      returnFocusTo?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const dialogEl = dialogRef.current;
      const focusables = dialogEl.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const items = Array.from(focusables).filter((el) => !el.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      opener?.focus?.();
    };
    // dialogRef/returnFocusTo are stable refs; onClose rides onCloseRef.
  }, [active]);
}

export function ReaderRoot({
  children,
  bgClassName = "bg-neutral-900",
  style,
}: {
  children: ReactNode;
  bgClassName?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`fixed inset-0 z-[100] flex flex-col select-none ${bgClassName}`} style={style}>
      {children}
    </div>
  );
}

function overlayPositionClass(fixed: boolean): string {
  return fixed
    ? "fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900"
    : "absolute inset-0 z-[115] flex items-center justify-center";
}

export function ReaderLoadingOverlay({
  message,
  bg,
  fg,
  bgClassName = "bg-neutral-900",
  fixed = false,
}: {
  message: string;
  bg?: string;
  fg?: string;
  bgClassName?: string;
  fixed?: boolean;
}) {
  const themed = bg !== undefined;
  return (
    <div
      className={
        themed ? overlayPositionClass(false) : `${overlayPositionClass(fixed)} ${bgClassName}`
      }
      style={themed ? { background: bg } : undefined}
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70"
          style={themed && fg ? { color: fg, borderColor: undefined } : undefined}
        />
        {themed && fg ? (
          <p className="text-sm" style={{ color: fg, opacity: 0.6 }}>
            {message}
          </p>
        ) : (
          <p className="text-sm text-white/50">{message}</p>
        )}
      </div>
    </div>
  );
}

// Error panel (batch 4, item 9): title + collapsible detail + Back to book /
// Download instead / retry actions. `kindLabel` names the reader ("EPUB",
// "PDF", "comic") so the heading stays source-named per reader.
export function ReaderErrorPanel({
  kindLabel,
  detail,
  onRetry,
  retryLabel = "Try streaming",
  onBack,
  downloadHref,
  bg,
  fg,
  subtle,
  bgClassName = "bg-neutral-900",
}: {
  kindLabel: string;
  detail: string;
  onRetry?: () => void;
  retryLabel?: string;
  onBack: () => void;
  downloadHref?: string;
  bg?: string;
  fg?: string;
  subtle?: string;
  bgClassName?: string;
}) {
  const themed = bg !== undefined;
  const textStyle: CSSProperties | undefined = themed && fg ? { color: fg } : undefined;
  return (
    <div
      className={
        themed ? overlayPositionClass(false) : `${overlayPositionClass(false)} ${bgClassName}`
      }
      style={themed ? { background: bg } : undefined}
    >
      <div className="max-w-sm px-6 text-center">
        <p
          className={themed ? "text-sm" : "text-sm text-white/70"}
          style={themed ? { ...textStyle, opacity: 0.75 } : undefined}
          role="alert"
        >
          Failed to load {kindLabel}
        </p>
        <details className="mt-2">
          <summary
            className={
              themed
                ? "cursor-pointer text-xs underline"
                : "cursor-pointer text-xs text-white/50 underline"
            }
            style={themed ? { ...textStyle, opacity: 0.6 } : undefined}
          >
            Show details
          </summary>
          <p
            className={
              themed ? "mt-1 text-xs break-words" : "mt-1 text-xs break-words text-white/50"
            }
            style={themed ? { ...textStyle, opacity: 0.6 } : undefined}
          >
            {detail}
          </p>
        </details>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className={
              themed
                ? "rounded px-4 py-2 text-sm active:opacity-70"
                : "rounded bg-white/10 px-4 py-2 text-sm text-white active:opacity-70"
            }
            style={
              themed ? { ...textStyle, border: `1px solid ${subtle ?? "currentColor"}` } : undefined
            }
          >
            Back to book
          </button>
          {downloadHref && (
            <a
              href={downloadHref}
              download
              className={
                themed
                  ? "rounded px-4 py-2 text-sm active:opacity-70"
                  : "rounded bg-white/10 px-4 py-2 text-sm text-white active:opacity-70"
              }
              style={
                themed
                  ? { ...textStyle, border: `1px solid ${subtle ?? "currentColor"}` }
                  : undefined
              }
            >
              Download instead
            </a>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={
                themed
                  ? "rounded px-4 py-2 text-sm active:opacity-70"
                  : "rounded bg-white/10 px-4 py-2 text-sm text-white active:opacity-70"
              }
              style={
                themed
                  ? { ...textStyle, border: `1px solid ${subtle ?? "currentColor"}` }
                  : undefined
              }
            >
              {retryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ReaderHeader({
  title,
  showUI,
  onBack,
  overlay,
  tone,
  actionsClassName = "flex items-center gap-1",
  children,
}: {
  title: string;
  showUI: boolean;
  onBack: () => void;
  overlay: boolean;
  tone: HeaderTone;
  actionsClassName?: string;
  children?: ReactNode;
}) {
  const dark = tone.kind === "dark";
  const chrome = tone.kind === "themed" ? tone.chrome : null;
  return (
    <div
      className={
        overlay
          ? "fixed top-0 left-0 right-0 z-[108] transition-transform duration-200"
          : "shrink-0 z-[108] transition-transform duration-200"
      }
      style={
        dark
          ? {
              transform: showUI ? "translateY(0)" : "translateY(-100%)",
              background: "rgba(0,0,0,0.85)",
              backdropFilter: "blur(12px)",
              borderBottom: "1px solid rgba(255,255,255,0.1)",
              paddingTop: "env(safe-area-inset-top, 0px)",
            }
          : {
              transform: showUI ? "translateY(0)" : "translateY(-100%)",
              background: chrome?.barBg,
              backdropFilter: "blur(12px)",
              borderBottom: `1px solid ${chrome?.subtle}`,
              paddingTop: "env(safe-area-inset-top, 0px)",
              pointerEvents: showUI ? "auto" : "none",
            }
      }
    >
      <div className="flex items-center justify-between px-3 h-12">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to book"
          title="Back to book"
          className={
            dark
              ? "p-2 -ml-1 rounded-lg text-white active:opacity-60"
              : "p-2 -ml-1 rounded-lg active:opacity-60"
          }
          style={dark ? undefined : { color: chrome?.fg }}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span
          className="text-sm truncate mx-2 flex-1 text-center font-medium"
          style={dark ? undefined : { color: chrome?.fg }}
        >
          <span className={dark ? "text-white" : undefined}>{title}</span>
        </span>
        <div className={actionsClassName} style={dark ? undefined : { color: chrome?.fg }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ReaderFooterShell({
  showUI,
  overlay,
  tone,
  children,
}: {
  showUI: boolean;
  overlay: boolean;
  tone: HeaderTone;
  children: ReactNode;
}) {
  const dark = tone.kind === "dark";
  const chrome = tone.kind === "themed" ? tone.chrome : null;
  return (
    <div
      className={
        overlay
          ? "fixed bottom-0 left-0 right-0 z-[108] transition-transform duration-200"
          : "shrink-0 z-[108] transition-transform duration-200"
      }
      style={
        dark
          ? {
              transform: showUI ? "translateY(0)" : "translateY(100%)",
              background: "rgba(0,0,0,0.85)",
              backdropFilter: "blur(12px)",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
            }
          : {
              transform: showUI ? "translateY(0)" : "translateY(100%)",
              background: chrome?.barBg,
              backdropFilter: "blur(12px)",
              borderTop: `1px solid ${chrome?.subtle}`,
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              pointerEvents: showUI ? "auto" : "none",
            }
      }
    >
      {children}
    </div>
  );
}

export function ReaderLoadModeToggle({
  loadMode,
  onToggle,
  streamLabel,
  fullLabel,
  tone,
}: {
  loadMode: ReaderLoadMode;
  onToggle: () => void;
  streamLabel: string;
  fullLabel: string;
  tone: HeaderTone;
}) {
  const dark = tone.kind === "dark";
  const chrome = tone.kind === "themed" ? tone.chrome : null;
  const active = loadMode === "stream";
  const label = active ? streamLabel : fullLabel;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        dark
          ? "flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-white active:opacity-60"
          : "flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs active:opacity-60"
      }
      style={dark ? undefined : { color: chrome?.fg }}
      aria-label={label}
      title={label}
    >
      {active ? <Wifi className="h-4 w-4" /> : <Download className="h-4 w-4" />}
      <span className="hidden sm:inline">{active ? "Stream" : "Full"}</span>
    </button>
  );
}

// Shared numeric page input (batch 4, item 11): numeric keyboard on touch
// devices plus a programmatic description of the total page count.
export function ReaderPageInput({
  value,
  max,
  onCommit,
  describedById,
}: {
  value: number;
  max: number;
  onCommit: (page: number) => void;
  describedById: string;
}) {
  return (
    <input
      type="number"
      min={1}
      max={max || 1}
      value={value}
      inputMode="numeric"
      onChange={(e) => {
        const val = parseInt(e.target.value, 10);
        if (Number.isInteger(val) && val >= 1 && val <= (max || 1)) {
          onCommit(val);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      className="w-10 bg-transparent text-center text-sm text-white/60 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none outline-none border-b border-white/20 focus:border-white/50"
      aria-label="Page number"
      aria-describedby={describedById}
    />
  );
}
