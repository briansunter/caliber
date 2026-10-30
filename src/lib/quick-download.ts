export function preferredDownloadFormat(formats: string[] = []): string | undefined {
  const upper = formats.map((format) => format.toUpperCase());
  return (
    upper.find((format) => format === "EPUB") ??
    upper.find((format) => format === "PDF") ??
    upper[0]
  );
}

export function createDownloadAction(
  request: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
) {
  let pending = false;
  return async (bookId: number, format: string): Promise<string | null> => {
    if (pending) return null;
    pending = true;
    try {
      const url = `/api/books/${bookId}/download/${encodeURIComponent(format)}`;
      const response = await request(url, { method: "HEAD" });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      return url;
    } finally {
      pending = false;
    }
  };
}
