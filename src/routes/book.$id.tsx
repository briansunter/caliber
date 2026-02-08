import { createFileRoute, useParams, Link } from "@tanstack/react-router";
import { BookDetail } from "@/components/BookDetail";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Library, BookOpen } from "lucide-react";

export const Route = createFileRoute("/book/$id")({
  component: BookDetailPage,
});

function BookDetailPage() {
  const { id } = useParams({ from: "/book/$id" });
  const bookId = parseInt(id, 10);

  return (
    <div className="min-h-screen bg-primary">
      {/* Header */}
      <header className="border-b border-default bg-secondary">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 sm:h-20">
            {/* Back navigation */}
            <Link to="/">
              <Button
                variant="ghost"
                size="sm"
                className="group gap-2 text-tertiary hover:text-primary transition-colors bg-transparent hover:bg-tertiary"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded bg-tertiary group-hover:bg-elevated transition-colors border border-default">
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
                </div>
                <span className="hidden sm:inline font-medium uppercase tracking-wider text-xs">Back to Library</span>
              </Button>
            </Link>

            {/* Library branding */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded bg-accent-dim border border-default">
                <BookOpen className="h-4 w-4 text-accent" strokeWidth={1.5} />
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold leading-none text-primary">
                  Caliber
                </p>
                <p className="text-xs text-tertiary mt-0.5 uppercase tracking-wider">Library</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <BookDetail bookId={bookId} />
      </main>

      {/* Footer */}
      <footer className="border-t border-default mt-auto bg-primary">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-tertiary">
            <div className="flex items-center gap-2">
              <Library className="h-4 w-4" strokeWidth={1.5} />
              <span className="uppercase tracking-wider text-xs">Calibre Library</span>
            </div>
            <p className="text-xs">
              Browse and download your digital collection
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
