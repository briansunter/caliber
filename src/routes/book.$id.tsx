import { createFileRoute, useParams } from "@tanstack/react-router";
import { BookDetail } from "@/components/BookDetail";
import { Button } from "@/components/ui/button";
import { ArrowLeft, BookOpen } from "lucide-react";

export const Route = createFileRoute("/book/$id")({
  component: BookDetailPage,
});

function BookDetailPage() {
  const { id } = useParams({ from: "/book/$id" });
  const bookId = parseInt(id, 10);

  return (
    <div className="min-h-screen bg-parchment paper-texture">
      {/* Header */}
      <header className="border-b border-ink bg-white/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            {/* Back navigation */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.history.back()}
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
      <main className="max-w-6xl mx-auto px-6 py-10 lg:py-14">
        <BookDetail bookId={bookId} />
      </main>

      {/* Footer */}
      <footer className="border-t border-ink mt-auto bg-white">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="ornament text-ink-muted">
            <span className="text-sm">Caliber Library Manager</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
