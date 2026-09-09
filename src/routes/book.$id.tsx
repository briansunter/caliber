import { createFileRoute, useParams, useNavigate } from "@tanstack/react-router";
import { BookDetail } from "@/components/BookDetail";
import { Button } from "@/components/ui/button";
import { ArrowLeft, BookOpen } from "lucide-react";

export const Route = createFileRoute("/book/$id")({
  component: BookDetailPage,
});

function BookDetailPage() {
  const { id } = useParams({ from: "/book/$id" });
  const bookId = parseInt(id, 10);
  const navigate = useNavigate();

  function handleBack() {
    // Library state (q/view/sort/tags) lives in the URL, so going back
    // through history pops to the intact library entry and preserves it.
    // No document.referrer sniffing or window.history.length gate here:
    // the referrer does not update on SPA pushes (misfires on normal
    // fresh tab -> library -> detail navigation), and history.length counts
    // external/cross-origin entries too, so a direct open/bookmark can
    // still report length > 1 and back() would exit the app entirely.
    // TanStack Router stamps each in-app entry with __TSR_index in
    // history.state (0 on the first entry), so it is the reliable signal
    // for "there is an in-app entry to return to". Direct opens/bookmarks
    // have no in-app entry to return to, so they fall back to the library
    // root (there is no prior state to preserve).
    const tsrIndex = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0;
    if (tsrIndex > 0) {
      window.history.back();
    } else {
      navigate({
        to: "/",
        search: { q: "", view: "list", sortBy: "added", sortOrder: "desc", tag: [] },
      });
    }
  }

  return (
    <div className="min-h-screen bg-parchment paper-texture">
      {/* Header */}
      <header className="border-b border-ink bg-surface/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            {/* Back navigation */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              aria-label="Back to library"
              className="group gap-2 text-ink-muted hover:text-ink transition-colors bg-transparent hover:bg-parchment-dark cursor-pointer"
            >
              <div className="flex items-center justify-center w-8 h-8 rounded bg-parchment-dark group-hover:bg-parchment-warm transition-colors border border-ink">
                <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
              </div>
              <span className="hidden sm:inline font-medium text-sm">Back to Library</span>
            </Button>

            {/* Library branding */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded bg-ink">
                <BookOpen className="h-4 w-4 text-white" strokeWidth={1.5} />
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold leading-none text-ink">Caliber</p>
                <p className="text-xs text-ink-muted mt-0.5">Library</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main id="main-content" className="max-w-6xl mx-auto px-6 py-10 lg:py-14">
        <BookDetail bookId={bookId} />
      </main>

      {/* Footer */}
      <footer className="border-t border-ink mt-auto bg-surface">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="ornament text-ink-muted">
            <span className="text-sm">Caliber Library Manager</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
