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
}: BookCoverImageProps) {
  const [failed, setFailed] = useState(false);

  if (!hasCover || failed) {
    return <CoverFallback title={title} size={size} />;
  }

  return (
    <img
      src={`/api/books/${bookId}/thumb`}
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
