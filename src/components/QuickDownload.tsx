import { useRef, useState } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { createDownloadAction, preferredDownloadFormat } from "@/lib/quick-download";

export function QuickDownload({
  id,
  title,
  formats,
}: {
  id: number;
  title: string;
  formats?: string[];
}) {
  const format = preferredDownloadFormat(formats);
  const action = useRef(createDownloadAction());
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  async function download() {
    if (!format || state === "loading" || state === "success") return;
    setState("loading");
    try {
      const url = await action.current(id, format);
      if (!url) return;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      anchor.click();
      setState("success");
      setTimeout(() => setState("idle"), 3000);
    } catch {
      setState("error");
    }
  }
  const label = !format
    ? `No download available for ${title}`
    : state === "loading"
      ? `Checking download for ${title}`
      : state === "error"
        ? `Download failed for ${title}; retry`
        : state === "success"
          ? `Download requested for ${title}; check your browser downloads`
          : `Download ${title} as ${format}`;
  return (
    <button
      type="button"
      disabled={!format || state === "loading" || state === "success"}
      onClick={download}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-ink-secondary hover:bg-parchment-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "error" ? (
        <AlertCircle className="h-4 w-4 text-error" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}
