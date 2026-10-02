import { type SourceSignature, isSourceSignature } from "./file-signature";

export interface CachedPage {
  index: number;
  name: string;
  fileName: string;
  contentType: string;
  sourceName?: string;
}

export interface PageCacheMeta {
  source: SourceSignature;
  pageCount: number;
  pages: CachedPage[];
  libHash?: string;
  version?: number;
}

/** Cached JSON is disposable; reject corrupt records and paths before using them. */
export function isPageCacheMeta(value: unknown): value is PageCacheMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<PageCacheMeta>;
  if (
    !isSourceSignature(meta.source) ||
    !Number.isSafeInteger(meta.pageCount) ||
    (meta.pageCount ?? 0) < 1 ||
    (meta.pageCount ?? 0) > 10_000 ||
    !Array.isArray(meta.pages) ||
    meta.pages.length !== meta.pageCount
  )
    return false;
  return meta.pages.every((page: unknown, offset) => {
    if (!page || typeof page !== "object") return false;
    const entry = page as Partial<CachedPage>;
    return (
      entry.index === offset + 1 &&
      typeof entry.name === "string" &&
      typeof entry.fileName === "string" &&
      /^\d{5}\.(?:avif|gif|jpe?g|png|webp)$/.test(entry.fileName) &&
      typeof entry.contentType === "string" &&
      /^image\/[a-z0-9.+-]+$/.test(entry.contentType) &&
      (entry.sourceName === undefined || typeof entry.sourceName === "string")
    );
  });
}
