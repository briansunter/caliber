interface IdentifiedItem {
  id: number;
}

export interface WindowPage<T> {
  items: T[];
  total?: number;
  nextCursor: string | null;
}

export interface WindowAnchor<T> {
  identity: string;
  page: WindowPage<T>;
}

// Cursor presence, rather than a full window or an incomplete total, proves
// that TanStack evicted the initial page. A preserved anchor can fill the first
// eviction without introducing a gap; later evictions omit intermediate pages.
export function flattenBookWindow<T extends IdentifiedItem>(
  pages: WindowPage<T>[] | undefined,
  pageParams: readonly unknown[] | undefined,
  identity: string,
  anchor: WindowAnchor<T> | null,
  keepAnchor: boolean,
) {
  const stored = anchor?.identity === identity ? anchor.page : null;
  const firstPageEvicted = pages !== undefined && pages.length > 0 && pageParams?.[0] !== undefined;
  const retainedPages = pages ?? [];
  const totalCount =
    retainedPages.find((page) => typeof page.total === "number")?.total ?? stored?.total ?? null;
  const seen = new Set<number>();
  const books: T[] = [];
  const append = (items: T[]) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      books.push(item);
    }
  };
  if (firstPageEvicted && keepAnchor && stored) {
    const retainedIds = new Set(retainedPages.flatMap((page) => page.items.map((item) => item.id)));
    append(stored.items.filter((item) => !retainedIds.has(item.id)));
  }
  for (const page of retainedPages) append(page.items);
  const anchorFillsGap = keepAnchor && stored !== null && stored.nextCursor === pageParams?.[0];
  const windowTruncated =
    firstPageEvicted && !anchorFillsGap && (totalCount === null || books.length < totalCount);
  return { books, totalCount, windowTruncated };
}
