import { createFileRoute, useParams } from "@tanstack/react-router";
import { useBook } from "@/hooks/useBooksInfinite";
import { EpubReader } from "@/components/EpubReader";
import { PdfReader } from "@/components/PdfReader";
import { BookOpen } from "lucide-react";

export const Route = createFileRoute("/read/$id/$format")({
  component: ReaderPage,
});

function ReaderPage() {
  const { id, format } = useParams({ from: "/read/$id/$format" });
  const bookId = parseInt(id, 10);
  const fmt = format.toUpperCase();
  const { data: book, isLoading, error } = useBook(bookId);

  const goBack = () => window.history.back();

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <p className="text-sm text-white/50">Loading...</p>
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

  const bookUrl = `/api/books/${bookId}/download/${fmt}`;
  const bookTitle = book.title;

  if (fmt === "EPUB") {
    return <EpubReader url={bookUrl} bookId={bookId} onBack={goBack} title={bookTitle} />;
  }

  if (fmt === "PDF") {
    return <PdfReader url={bookUrl} bookId={bookId} onBack={goBack} title={bookTitle} />;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900">
      <div className="text-center">
        <BookOpen className="h-10 w-10 text-white/30 mx-auto mb-3" />
        <p className="text-white/60 text-sm">Reading {fmt} format is not supported yet.</p>
        <p className="text-white/40 text-xs mt-1">Supported: EPUB, PDF</p>
        <button type="button" onClick={goBack} className="mt-4 text-blue-400 text-sm underline">
          Go back
        </button>
      </div>
    </div>
  );
}
