import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { CoverFallback } from "./CoverFallback";

interface BookCoverImageProps {
  bookId: number;
  title: string;
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
  hasCover,
  size = "lg",
  width,
  height,
  className,
  authKey,
}: BookCoverImageProps) {
  const [failed, setFailed] = useState(false);
  const coverKey = `${bookId}:${String(authKey ?? "")}:${hasCover ? "1" : "0"}`;
  const [lastCoverKey, setLastCoverKey] = useState(coverKey);

  // Reset the sticky error fallback whenever the book or auth identity
  // changes so a previous 401/404 does not stick to a new principal.
  // (State adjusted during render — the documented alternative to an effect.)
  if (lastCoverKey !== coverKey) {
    setLastCoverKey(coverKey);
    setFailed(false);
  }

  if (!hasCover || failed) {
    return <CoverFallback title={title} size={size} />;
  }

  const src =
    authKey !== undefined && authKey !== null && String(authKey) !== ""
      ? `/api/books/${bookId}/thumb?auth=${encodeURIComponent(String(authKey))}`
      : `/api/books/${bookId}/thumb`;

  return (
    <img
      key={coverKey}
      src={src}
      alt={title}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      onError={() => setFailed(true)}
      className={cn("h-full w-full object-cover", className)}
    />
  );
});
