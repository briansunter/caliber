import { useRef, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { getSafeBookFilename } from "@/lib/book-files";
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
    if (!format || state === "loading") return;
    setState("loading");
    try {
      const blob = await action.current(id, format);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = getSafeBookFilename(title, format);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("success");
    } catch {
      setState("error");
    }
  }
  const label = !format
    ? `No download available for ${title}`
    : state === "loading"
      ? `Downloading ${title}`
      : state === "error"
        ? `Download failed for ${title}; retry`
        : state === "success"
          ? `Download started for ${title}; download again`
          : `Download ${title} as ${format}`;
  return (
    <button
      type="button"
      disabled={!format || state === "loading"}
      onClick={download}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-ink-secondary hover:bg-parchment-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "success" ? (
        <Check className="h-4 w-4" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}
