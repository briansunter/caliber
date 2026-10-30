export function preferredDownloadFormat(formats: string[] = []): string | undefined {
  const upper = formats.map((format) => format.toUpperCase());
  return (
    upper.find((format) => format === "EPUB") ??
    upper.find((format) => format === "PDF") ??
    upper[0]
  );
}

export function createDownloadAction(
  request: (url: string) => Promise<Response> = (url) => fetch(url),
) {
  let pending = false;
  return async (bookId: number, format: string): Promise<Blob | null> => {
    if (pending) return null;
    pending = true;
    try {
      const response = await request(`/api/books/${bookId}/download/${encodeURIComponent(format)}`);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      return await response.blob();
    } finally {
      pending = false;
    }
  };
}
