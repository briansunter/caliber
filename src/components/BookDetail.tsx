import { useBook } from "@/hooks/useBooksInfinite";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Download,
  Calendar,
  User,
  BookText,
  Hash,
  Star,
  FileText,
  Building2,
  Bookmark,
  Clock,
  ChevronRight,
} from "lucide-react";
import { useState, useCallback, memo, useMemo } from "react";
import { cn } from "@/lib/utils";

interface BookDetailProps {
  bookId: number;
}

// Elegant book cover with leather-bound shadow and spine effect
const BookCover = memo(function BookCover({
  bookId,
  title,
  hasCover,
}: {
  bookId: number;
  title: string;
  hasCover: boolean;
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  const handleLoad = useCallback(() => {
    setIsLoaded(true);
  }, []);

  const handleError = useCallback(() => {
    setHasError(true);
    setIsLoaded(true);
  }, []);

  if (!hasCover || hasError) {
    return (
      <div
        className="relative w-full aspect-[2/3] bg-tertiary rounded flex flex-col items-center justify-center text-muted border border-default"
        style={{
          boxShadow: "0 4px 6px rgba(0,0,0,0.3), 0 10px 20px rgba(0,0,0,0.4)",
        }}
      >
        {/* Spine highlight */}
        <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-r from-white/10 to-transparent" />
        <BookText className="h-16 w-16 mb-3 opacity-40" strokeWidth={1.5} />
        <span className="text-xs uppercase tracking-widest opacity-60">No Cover</span>
      </div>
    );
  }

  return (
    <div className="relative group">
      {/* Deep book shadow effect */}
      <div
        className="absolute -inset-3 rounded opacity-70 group-hover:opacity-90 transition-opacity duration-500"
        style={{
          background: "linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0.8) 100%)",
          filter: "blur(12px)",
        }}
      />

      {/* Book frame */}
      <div
        className="relative bg-tertiary rounded p-1.5"
        style={{
          boxShadow: "0 4px 6px rgba(0,0,0,0.3), 0 10px 20px rgba(0,0,0,0.4)",
        }}
      >
        {/* Inner border for depth */}
        <div className="relative overflow-hidden rounded border border-default">
          {/* Spine highlight overlay */}
          <div
            className="absolute left-0 top-0 bottom-0 w-3 z-10 pointer-events-none"
            style={{
              background: "linear-gradient(90deg, rgba(255,255,255,0.1) 0%, transparent 100%)",
            }}
          />

          {!isLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-tertiary">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            </div>
          )}
          <img
            src={`/api/books/${bookId}/cover`}
            alt={title}
            className={cn(
              "w-full aspect-[2/3] object-cover transition-all duration-500",
              isLoaded ? "opacity-100 scale-100" : "opacity-0 scale-105"
            )}
            loading="lazy"
            decoding="async"
            onLoad={handleLoad}
            onError={handleError}
          />
        </div>
      </div>
    </div>
  );
});

// Elegant metadata row with icon container
const MetadataRow = memo(function MetadataRow({
  icon: Icon,
  label,
  value,
  highlight = false,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex items-center justify-center w-8 h-8 rounded bg-tertiary text-tertiary">
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-widest text-muted">{label}</p>
        <p
          className={cn(
            "text-sm truncate",
            highlight ? "font-semibold text-primary" : "text-secondary"
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
});

// Star rating display
const StarRating = memo(function StarRating({
  rating,
}: {
  rating: number | null;
}) {
  const stars = useMemo(() => {
    if (!rating || rating <= 0) return null;
    const fullStars = Math.floor(rating / 2);
    const hasHalfStar = rating % 2 >= 1;
    return { fullStars, hasHalfStar };
  }, [rating]);

  if (!stars) return null;

  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "h-4 w-4",
            i < stars.fullStars
              ? "fill-accent text-accent"
              : i === stars.fullStars && stars.hasHalfStar
                ? "fill-accent/50 text-accent"
                : "fill-tertiary text-muted"
          )}
          strokeWidth={1.5}
        />
      ))}
    </div>
  );
});

// Download format button
const FormatButton = memo(function FormatButton({
  format,
  bookId,
}: {
  format: string;
  bookId: number;
}) {
  const handleDownload = useCallback(() => {
    window.open(`/api/books/${bookId}/download/${format}`, "_blank");
  }, [bookId, format]);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDownload}
      className="group relative overflow-hidden bg-secondary hover:bg-accent hover:text-primary border-default hover:border-accent text-primary transition-all duration-200 rounded-sm text-xs uppercase tracking-wider font-semibold"
    >
      <span className="relative z-10 flex items-center gap-2">
        <Download className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5" strokeWidth={2} />
        <span>{format.toUpperCase()}</span>
      </span>
    </Button>
  );
});

// Elegant tag pill
const TagPill = memo(function TagPill({ tag }: { tag: string }) {
  return (
    <Badge
      variant="secondary"
      className="px-3 py-1 bg-tertiary hover:bg-elevated text-secondary font-normal text-xs rounded-sm border border-default transition-colors cursor-default"
    >
      {tag}
    </Badge>
  );
});

// Ornamental divider
const OrnamentalDivider = memo(function OrnamentalDivider() {
  return (
    <div className="flex items-center justify-center gap-4 py-4">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border-default to-transparent" />
      <span className="text-muted text-lg">&#10087;</span>
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border-default to-transparent" />
    </div>
  );
});

export function BookDetail({ bookId }: BookDetailProps) {
  const { data: book, isLoading, error } = useBook(bookId);

  const formattedPubDate = useMemo(() => {
    if (!book?.pubdate) return "Unknown";
    const date = new Date(book.pubdate);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
    });
  }, [book?.pubdate]);

  const formattedTimestamp = useMemo(() => {
    if (!book?.timestamp) return "";
    return new Date(book.timestamp).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, [book?.timestamp]);

  const authorNames = useMemo(() => {
    if (!book?.authors?.length) return "";
    return book.authors.join(", ");
  }, [book?.authors]);

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
            <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full border border-accent/10" />
          </div>
          <p className="text-sm text-tertiary animate-pulse uppercase tracking-widest">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded bg-error/10 mb-4 border border-error/30">
            <FileText className="h-8 w-8 text-error" strokeWidth={1.5} />
          </div>
          <h3 className="text-lg font-semibold text-error mb-1">Error loading book</h3>
          <p className="text-sm text-tertiary">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded bg-tertiary mb-4 border border-default">
            <BookText className="h-8 w-8 text-muted" strokeWidth={1.5} />
          </div>
          <h3 className="text-lg font-semibold mb-1 text-primary">Book not found</h3>
          <p className="text-sm text-tertiary">The book you&apos;re looking for doesn&apos;t exist.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8 lg:gap-12">
        {/* Left column - Cover and actions */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-8 space-y-6">
            {/* Book Cover */}
            <BookCover bookId={bookId} title={book.title} hasCover={book.has_cover} />

            {/* Download section */}
            {book.formats.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-tertiary uppercase tracking-widest">Download</h3>
                <div className="flex flex-wrap gap-2">
                  {book.formats.map((format) => (
                    <FormatButton key={format} format={format} bookId={bookId} />
                  ))}
                </div>
              </div>
            )}

            {/* Quick metadata */}
            <div className="pt-4 border-t border-default space-y-1">
              {book.rating && book.rating > 0 && (
                <MetadataRow icon={Star} label="Rating" value={<StarRating rating={book.rating} />} />
              )}
              <MetadataRow icon={Calendar} label="Published" value={formattedPubDate} />
              {formattedTimestamp && (
                <MetadataRow icon={Clock} label="Added to library" value={formattedTimestamp} />
              )}
            </div>
          </div>
        </div>

        {/* Right column - Book details */}
        <div className="lg:col-span-1 space-y-6">
          {/* Header section */}
          <div className="space-y-4">
            {/* Series badge */}
            {book.series && (
              <div className="flex items-center gap-2 text-sm text-secondary">
                <Bookmark className="h-4 w-4 text-accent" strokeWidth={1.5} />
                <span className="font-medium">{book.series}</span>
                <ChevronRight className="h-3 w-3 text-muted" />
                <span className="text-xs bg-tertiary px-2 py-0.5 rounded-sm border border-default">
                  #{book.series_index}
                </span>
              </div>
            )}

            {/* Title */}
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-[1.1] text-primary">
              {book.title}
            </h1>

            {/* Author */}
            {authorNames && (
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded bg-accent-dim flex items-center justify-center border border-default">
                  <User className="h-5 w-5 text-accent" strokeWidth={1.5} />
                </div>
                <div>
                  <p className="text-xs text-muted uppercase tracking-widest font-medium">Author</p>
                  <p className="text-lg font-medium text-primary">{authorNames}</p>
                </div>
              </div>
            )}
          </div>

          <OrnamentalDivider />

          {/* Metadata grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {book.publisher && <MetadataRow icon={Building2} label="Publisher" value={book.publisher} />}
            {book.isbn && <MetadataRow icon={Hash} label="ISBN" value={book.isbn} />}
          </div>

          {/* Tags */}
          {book.tags.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-widest">Tags</h3>
              <div className="flex flex-wrap gap-2">
                {book.tags.map((tag) => (
                  <TagPill key={tag} tag={tag} />
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          {book.comments && (
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-widest flex items-center gap-2">
                <FileText className="h-4 w-4" strokeWidth={1.5} />
                About this book
              </h3>
              <div
                className="prose prose-invert prose-base max-w-none leading-relaxed text-secondary"
                dangerouslySetInnerHTML={{ __html: book.comments }}
              />
            </div>
          )}

          {/* Empty state for no description */}
          {!book.comments && (
            <div className="py-12 text-center border border-dashed border-default rounded bg-secondary/50">
              <FileText className="h-10 w-10 mx-auto mb-3 text-muted" strokeWidth={1.5} />
              <p className="text-sm text-muted">No description available for this book.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
