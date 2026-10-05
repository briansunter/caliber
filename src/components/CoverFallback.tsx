import { memo } from "react";
import { coverInitials } from "@/lib/utils";

interface CoverFallbackProps {
  title: string;
  author?: string;
  size?: "sm" | "lg";
}

const PALETTE = [
  ["#40594a", "#314a3c", "#eee3c9"],
  ["#c6aa75", "#b79a66", "#343d2e"],
  ["#52636c", "#3e515a", "#eae1cd"],
  ["#ae745e", "#95624f", "#fff0db"],
  ["#ddd4c0", "#cfc4ab", "#4e5847"],
  ["#71676d", "#5c535b", "#f0e6d7"],
] as const;

function pickPalette(title: string): readonly [string, string, string] {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? PALETTE[0];
}

export const CoverFallback = memo(function CoverFallback({
  title,
  author,
  size = "lg",
}: CoverFallbackProps) {
  const [bg1, bg2, fg] = pickPalette(title);
  const initials = coverInitials(title);
  const fontSize = size === "sm" ? "0.75rem" : "clamp(1rem, 1.35vw, 1.5rem)";

  return (
    <div
      aria-hidden="true"
      className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden text-center select-none"
      style={{
        background: `linear-gradient(135deg, ${bg1} 0%, ${bg2} 100%)`,
        color: fg,
        fontSize,
        letterSpacing: "-0.02em",
        boxShadow: "inset 5px 0 9px rgb(0 0 0 / .12)",
      }}
    >
      {size === "sm" ? (
        initials
      ) : (
        <>
          <span className="absolute inset-3 border border-current opacity-25" />
          <span className="relative px-7 font-display leading-snug line-clamp-4">{title}</span>
          {author && (
            <span className="relative mt-3 max-w-[78%] text-xs leading-4 opacity-80 line-clamp-2">
              {author}
            </span>
          )}
          <span className="mt-4 h-px w-7 bg-current opacity-50" />
          <span className="mt-3 text-[9px] tracking-[.2em] opacity-65">{initials}</span>
        </>
      )}
    </div>
  );
});
