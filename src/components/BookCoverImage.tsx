import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { CoverFallback } from "./CoverFallback";

interface BookCoverImageProps {
  bookId: number;
  title: string;
  author?: string;
  hasCover: boolean;
  size?: "sm" | "lg";
  width: number;
  height: number;
  className?: string;
  /** Auth/library identity suffix that busts the cached cover URL. */
  authKey?: string | number | null;
}

/** Cover image with a deterministic fallback when a Calibre file is missing. */
export const BookCoverImage = memo(function BookCoverImage({
  bookId,
  title,
  author,
  hasCover,
  size = "lg",
  width,
  height,
  className,
  authKey,
}: BookCoverImageProps) {
  const [failed, setFailed] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const coverKey = `${bookId}:${String(authKey ?? "")}:${hasCover ? "1" : "0"}`;
  const [lastCoverKey, setLastCoverKey] = useState(coverKey);

  // Reset the sticky error fallback whenever the book or auth identity
  // changes so a previous 401/404 does not stick to a new principal.
  // (State adjusted during render — the documented alternative to an effect.)
  if (lastCoverKey !== coverKey) {
    setLastCoverKey(coverKey);
    setFailed(false);
    setIsLoaded(false);
  }

  if (!hasCover || failed) {
    return <CoverFallback title={title} author={author} size={size} />;
  }

  const src =
    authKey !== undefined && authKey !== null && String(authKey) !== ""
      ? `/api/books/${bookId}/thumb?auth=${encodeURIComponent(String(authKey))}`
      : `/api/books/${bookId}/thumb`;

  return (
    <div className="relative h-full w-full">
      <CoverFallback title={title} author={author} size={size} />
      <img
        key={coverKey}
        src={src}
        alt={title}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        onLoad={() => setIsLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "absolute inset-0 h-full w-full object-cover transition-[filter,opacity] duration-200",
          isLoaded ? "opacity-100" : "opacity-0",
          className,
        )}
      />
    </div>
  );
});
