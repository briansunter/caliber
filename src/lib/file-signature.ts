import { statSync } from "node:fs";

export interface SourceSignature {
  size: number;
  mtimeMs: number;
}

export function getSourceSignature(path: string): SourceSignature {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function isSameSignature(
  a: SourceSignature | null,
  b: SourceSignature,
): boolean {
  return Boolean(a && a.size === b.size && a.mtimeMs === b.mtimeMs);
}
