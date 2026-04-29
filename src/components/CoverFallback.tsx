import { memo } from "react";
import { coverInitials } from "@/lib/utils";

interface CoverFallbackProps {
  title: string;
  size?: "sm" | "lg";
}

const PALETTE: ReadonlyArray<readonly [string, string, string]> = [
  ["#eef2ff", "#c7d2fe", "#4338ca"],
  ["#fef3c7", "#fde68a", "#b45309"],
  ["#dcfce7", "#bbf7d0", "#15803d"],
  ["#fee2e2", "#fecaca", "#b91c1c"],
  ["#f3e8ff", "#e9d5ff", "#7e22ce"],
  ["#cffafe", "#a5f3fc", "#0e7490"],
  ["#fce7f3", "#fbcfe8", "#be185d"],
  ["#e0e7ff", "#c7d2fe", "#3730a3"],
];

function pickPalette(title: string): readonly [string, string, string] {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? PALETTE[0]!;
}

export const CoverFallback = memo(function CoverFallback({
  title,
  size = "lg",
}: CoverFallbackProps) {
  const [bg1, bg2, fg] = pickPalette(title);
  const initials = coverInitials(title);
  const fontSize = size === "sm" ? "0.75rem" : "1.5rem";

  return (
    <div
      aria-hidden="true"
      className="w-full h-full flex items-center justify-center font-semibold tracking-tight select-none"
      style={{
        background: `linear-gradient(135deg, ${bg1} 0%, ${bg2} 100%)`,
        color: fg,
        fontSize,
        letterSpacing: "-0.02em",
      }}
    >
      {initials}
    </div>
  );
});
