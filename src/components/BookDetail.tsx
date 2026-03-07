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
  BookOpen,
} from "lucide-react";
import { useState, useCallback, memo, useMemo } from "react";
import { cn, stripHtmlTags } from "@/lib/utils";
import { Link } from "@tanstack/react-router";

interface BookDetailProps {
  bookId: number;
}

const RATING_STAR_KEYS = ["star-1", "star-2", "star-3", "star-4", "star-5"] as const;

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
      <div className="relative w-full aspect-[2/3] bg-parchment-dark rounded-lg flex flex-col items-center justify-center text-ink-muted border border-ink">
        <BookText className="h-12 w-12 mb-2 text-ink-muted/40" strokeWidth={1.5} />
        <span className="text-xs text-ink-muted/60">No Cover</span>
      </div>
    );
  }

  return (
    <div className="relative group">
      {/* Book frame */}
      <div className="relative bg-parchment-dark rounded-lg p-1.5 border border-ink shadow-lg">
        <div className="relative overflow-hidden rounded-md border border-ink">
          {!isLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-parchment-dark">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            </div>
          )}
          <img
            src={`/api/books/${bookId}/cover`}
            alt={title}
            className={cn(
              "w-full aspect-[2/3] object-cover transition-all duration-500",
              isLoaded ? "opacity-100 scale-100" : "opacity-0 scale-105",
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
      <div className="flex items-center justify-center w-8 h-8 rounded bg-parchment-dark text-ink-muted border border-ink">
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-widest text-ink-muted">{label}</p>
        <p
          className={cn(
            "text-sm truncate",
            highlight ? "font-semibold text-accent" : "text-ink-secondary",
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
});

// Star rating display
const StarRating = memo(function StarRating({ rating }: { rating: number | null }) {
  const stars = useMemo(() => {
    if (!rating || rating <= 0) return null;
    const fullStars = Math.floor(rating / 2);
    const hasHalfStar = rating % 2 >= 1;
    return { fullStars, hasHalfStar };
  }, [rating]);

  if (!stars) return null;

  return (
    <div className="flex items-center gap-0.5">
      {RATING_STAR_KEYS.map((starKey, i) => (
        <Star
          key={starKey}
          className={cn(
            "h-4 w-4",
            i < stars.fullStars
              ? "fill-accent text-accent"
              : i === stars.fullStars && stars.hasHalfStar
                ? "fill-accent/50 text-accent"
                : "fill-parchment-dark text-ink-muted",
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
      className="group bg-text hover:bg-accent hover:text-white border-text hover:border-accent text-white transition-all duration-150 rounded text-xs uppercase tracking-wider font-semibold"
    >
      <span className="flex items-center gap-2">
        <Download className="h-3.5 w-3.5" strokeWidth={2} />
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
      className="px-3 py-1 bg-parchment-dark hover:bg-parchment-warm text-ink-secondary font-normal text-xs rounded-md border border-ink transition-colors cursor-default"
    >
      {tag}
    </Badge>
  );
});

// Ornamental divider
const OrnamentalDivider = memo(function OrnamentalDivider() {
  return (
    <div className="flex items-center justify-center gap-4 py-5">
      <div className="h-px flex-1 bg-border-default" />
      <div className="h-px flex-1 bg-border-default" />
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

  const descriptionText = useMemo(() => {
    if (!book?.comments) return "";
    return stripHtmlTags(book.comments);
  }, [book?.comments]);

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          <p className="text-sm text-ink-muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded bg-error/10 mb-3">
            <FileText className="h-6 w-6 text-error" strokeWidth={1.5} />
          </div>
          <h3 className="text-base font-semibold text-error mb-1">Error loading book</h3>
          <p className="text-sm text-ink-muted">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded bg-parchment-dark mb-3 border border-ink">
            <BookText className="h-6 w-6 text-ink-muted" strokeWidth={1.5} />
          </div>
          <h3 className="text-base font-semibold mb-1 text-ink">Book not found</h3>
          <p className="text-sm text-ink-muted">
            The book you&apos;re looking for doesn&apos;t exist.
          </p>
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
          <div className="lg:sticky lg:top-24 space-y-6">
            {/* Book Cover */}
            <div className="max-w-[250px] mx-auto lg:max-w-none">
              <BookCover bookId={bookId} title={book.title} hasCover={book.has_cover} />
            </div>

            {/* Read button */}
            {book.formats.some((f) => f === "EPUB" || f === "PDF") && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-widest">
                  Read
                </h3>
                <div className="flex flex-wrap gap-2">
                  {book.formats
                    .filter((f) => f === "EPUB" || f === "PDF")
                    .map((format) => (
                      <Link
                        key={format}
                        to="/read/$id/$format"
                        params={{ id: String(bookId), format: format.toLowerCase() }}
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="group bg-accent hover:bg-accent/90 border-accent text-white transition-all duration-150 rounded text-xs uppercase tracking-wider font-semibold cursor-pointer"
                        >
                          <span className="flex items-center gap-2">
                            <BookOpen className="h-3.5 w-3.5" strokeWidth={2} />
                            <span>Read {format}</span>
                          </span>
                        </Button>
                      </Link>
                    ))}
                </div>
              </div>
            )}

            {/* Download section */}
            {book.formats.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-widest">
                  Download
                </h3>
                <div className="flex flex-wrap gap-2">
                  {book.formats.map((format) => (
                    <FormatButton key={format} format={format} bookId={bookId} />
                  ))}
                </div>
              </div>
            )}

            {/* Quick metadata */}
            <div className="pt-4 border-t border-ink space-y-1">
              {book.rating && book.rating > 0 && (
                <MetadataRow
                  icon={Star}
                  label="Rating"
                  value={<StarRating rating={book.rating} />}
                />
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
              <div className="flex items-center gap-2 text-sm text-ink-secondary">
                <Bookmark className="h-4 w-4 text-accent" strokeWidth={2} />
                <span className="font-medium">{book.series}</span>
                <ChevronRight className="h-3 w-3 text-ink-muted" />
                <span className="text-xs bg-parchment-dark px-2 py-0.5 rounded-md border border-ink">
                  #{book.series_index}
                </span>
              </div>
            )}

            {/* Title */}
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight leading-tight text-ink">
              {book.title}
            </h1>

            {/* Author */}
            {authorNames && (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded bg-accent-subtle flex items-center justify-center">
                  <User className="h-4 w-4 text-accent" strokeWidth={2} />
                </div>
                <div>
                  <p className="text-xs text-ink-muted font-medium">Author</p>
                  <p className="text-base font-medium text-ink">{authorNames}</p>
                </div>
              </div>
            )}
          </div>

          <OrnamentalDivider />

          {/* Metadata grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {book.publisher && (
              <MetadataRow icon={Building2} label="Publisher" value={book.publisher} />
            )}
            {book.isbn && <MetadataRow icon={Hash} label="ISBN" value={book.isbn} />}
          </div>

          {/* Tags */}
          {book.tags.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-widest">
                Tags
              </h3>
              <div className="flex flex-wrap gap-2">
                {book.tags.map((tag) => (
                  <TagPill key={tag} tag={tag} />
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          {descriptionText && (
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-widest flex items-center gap-2">
                <FileText className="h-4 w-4" strokeWidth={1.5} />
                About this book
              </h3>
              <p className="leading-relaxed text-ink-secondary whitespace-pre-wrap">
                {descriptionText}
              </p>
            </div>
          )}

          {/* Empty state for no description */}
          {!descriptionText && (
            <div className="py-10 text-center border border-dashed border-ink rounded-lg bg-parchment-dark/50">
              <FileText className="h-8 w-8 mx-auto mb-2 text-ink-muted" strokeWidth={1.5} />
              <p className="text-sm text-ink-muted">No description available for this book.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
