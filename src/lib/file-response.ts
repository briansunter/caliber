export interface ByteRange {
  start: number;
  end: number;
}

/** Scope validators to the captured source, including across library switches. */
export function fileEntityTag(filePath: string, size: number, mtimeMs: number): string {
  return `"${Bun.hash(filePath).toString(36)}-${size}-${mtimeMs}"`;
}

/** Parse one byte range without accepting trailing or imprecise offsets. */
export function parseByteRange(rangeHeader: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;
  const startPart = match[1] ?? "";
  const endPart = match[2] ?? "";
  if (!startPart) {
    const suffixLength = Number(endPart);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(startPart);
  const end = endPart ? Number(endPart) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

/** If-None-Match uses weak comparison and accepts a list of validators. */
export function matchesEntityTag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const normalized = etag.replace(/^W\//, "");
  return header.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === normalized;
  });
}

export function ifRangeAllowsRange(ifRange: string | null, etag: string, mtimeMs: number): boolean {
  if (!ifRange) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return ifRange === etag;
  const parsed = Date.parse(ifRange);
  return Number.isFinite(parsed) && Math.floor(mtimeMs / 1000) <= Math.floor(parsed / 1000);
}

export async function serveLocalFile(
  req: Request,
  filePath: string,
  options: {
    contentType: string;
    contentDisposition?: string;
    cacheControl?: string;
    contentSecurityPolicy?: string;
  },
): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  const fileStat = await file.stat();
  const mtimeMs = fileStat.mtime?.getTime() || 0;
  const lastModified = fileStat.mtime?.toUTCString();
  const etag = fileEntityTag(filePath, fileStat.size, mtimeMs);
  const includeBody = req.method !== "HEAD";
  const rangeHeader = req.headers.get("Range");
  const rangeAllowed = ifRangeAllowsRange(req.headers.get("If-Range"), etag, mtimeMs);
  const baseHeaders = new Headers({
    "Content-Type": options.contentType,
    "Cache-Control": options.cacheControl ?? "no-cache",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  });
  if (lastModified) baseHeaders.set("Last-Modified", lastModified);
  if (options.contentDisposition)
    baseHeaders.set("Content-Disposition", options.contentDisposition);
  if (options.contentSecurityPolicy) {
    baseHeaders.set("Content-Security-Policy", options.contentSecurityPolicy);
  }

  if (matchesEntityTag(req.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (rangeHeader && rangeAllowed) {
    const range = parseByteRange(rangeHeader, fileStat.size);
    if (!range) {
      baseHeaders.set("Content-Range", `bytes */${fileStat.size}`);
      return new Response(null, { status: 416, headers: baseHeaders });
    }
    baseHeaders.set("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
    baseHeaders.set("Content-Length", String(range.end - range.start + 1));
    return new Response(includeBody ? file.slice(range.start, range.end + 1) : null, {
      status: 206,
      headers: baseHeaders,
    });
  }

  baseHeaders.set("Content-Length", String(fileStat.size));
  // Bun automatically slices BunFile response bodies for Range requests.
  // A stream preserves the full response after a stale If-Range without
  // allocating the entire book in memory.
  const body = !includeBody ? null : rangeHeader && !rangeAllowed ? file.stream() : file;
  return new Response(body, { headers: baseHeaders });
}
