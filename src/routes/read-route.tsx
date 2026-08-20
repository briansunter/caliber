import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { normalizeReaderLoadMode } from "@/components/reader-types";
import { useBook } from "@/hooks/useBooksInfinite";
import { loadReaderSettings } from "@/lib/reader-settings";

const EpubReader = lazy(() =>
  import("@/components/EpubReader").then((m) => ({ default: m.EpubReader })),
);
const PdfReader = lazy(() =>
  import("@/components/PdfReader").then((m) => ({ default: m.PdfReader })),
);
const ComicReader = lazy(() =>
  import("@/components/ComicReader").then((m) => ({ default: m.ComicReader })),
);

export const Route = createFileRoute("/read/$id/$format")({
  component: ReaderPage,
});

function ReaderPage() {
  const { id, format } = useParams({ from: "/read/$id/$format" });
  const bookId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  const navigate = useNavigate();
  const fmt = format.toUpperCase();
  const { data: book, isLoading, error } = useBook(bookId);
  // Explicit ?mode= in the URL wins; otherwise fall back to the user's default.
  const modeParam = new URLSearchParams(window.location.search).get("mode");
  const loadMode = modeParam
    ? normalizeReaderLoadMode(modeParam)
    : loadReaderSettings().defaultLoadMode;

  const goBack = () => {
    if (!Number.isNaN(bookId)) {
      navigate({ to: "/book/$id", params: { id: String(bookId) } });
    } else {
      navigate({ to: "/" });
    }
  };

  // Ensure the browser's back button goes to the book detail instead of
  // leaving the app when the reader was opened as a direct link (e.g.
  // from an external referrer or a bookmark). In that case history has no
  // in-app entry to go back to, so we insert the detail page behind the
  // reader. Normal in-app navigation (library -> detail -> reader) already
  // has the detail behind us, so we leave history alone.
  useEffect(() => {
    if (Number.isNaN(bookId)) return;

    let sameOriginReferrer = false;
    try {
      if (document.referrer) {
        sameOriginReferrer = new URL(document.referrer).origin === window.location.origin;
      }
    } catch {
      sameOriginReferrer = false;
    }

    // If the reader was reached via in-app navigation the referrer is same-origin
    // (e.g. the book detail page) and there is already a useful entry behind us.
    // Otherwise this is a direct open / external link and a single Back would
    // leave Caliber, so insert the detail page behind the reader.
    if (sameOriginReferrer) return;

    const detailHref = `/book/${bookId}`;
    const readerHref = window.location.href;
    // Insert the detail entry behind the reader so Back lands on it.
    window.history.replaceState(null, "", detailHref);
    window.history.pushState(null, "", readerHref);
  }, [bookId]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <p className="text-sm text-white/50">Loading…</p>
        </div>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
        <div className="text-center">
          <BookOpen className="h-10 w-10 text-white/30 mx-auto mb-3" />
          <p className="text-white/60 text-sm">
            {error ? "Failed to load book" : "Book not found"}
          </p>
          <button type="button" onClick={goBack} className="mt-4 text-blue-400 text-sm underline">
            Go back
          </button>
        </div>
      </div>
    );
  }

  const bookUrl = `/api/books/${bookId}/file/${fmt}`;
  const bookTitle = book.title;

  const readerFallback = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
        <p className="text-sm text-white/50">Loading…</p>
      </div>
    </div>
  );

  if (fmt === "EPUB") {
    return (
      <Suspense fallback={readerFallback}>
        <EpubReader
          streamUrl={`/api/books/${bookId}/epub/`}
          fullUrl={bookUrl}
          bookId={bookId}
          onBack={goBack}
          title={bookTitle}
          initialLoadMode={loadMode}
        />
      </Suspense>
    );
  }

  if (fmt === "PDF") {
    return (
      <Suspense fallback={readerFallback}>
        <PdfReader
          url={bookUrl}
          bookId={bookId}
          onBack={goBack}
          title={bookTitle}
          initialLoadMode={loadMode}
        />
      </Suspense>
    );
  }

  if (fmt === "CBZ" || fmt === "CBR") {
    return (
      <Suspense fallback={readerFallback}>
        <ComicReader
          bookId={bookId}
          onBack={goBack}
          title={bookTitle}
          streamManifestUrl={`/api/books/${bookId}/pages/${fmt}/manifest`}
          fullUrl={bookUrl}
          supportsFullFile={fmt === "CBZ"}
          initialLoadMode={loadMode}
        />
      </Suspense>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
      <div className="text-center">
        <BookOpen className="h-10 w-10 text-white/30 mx-auto mb-3" />
        <p className="text-white/60 text-sm">Reading {fmt} format is not supported yet.</p>
        <p className="text-white/40 text-xs mt-1">Supported: EPUB, PDF, CBZ, CBR</p>
        <button type="button" onClick={goBack} className="mt-4 text-blue-400 text-sm underline">
          Go back
        </button>
      </div>
    </div>
  );
}
