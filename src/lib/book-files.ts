const FORMAT_CONTENT_TYPES: Record<string, string> = {
  EPUB: "application/epub+zip",
  MOBI: "application/x-mobipocket-ebook",
  AZW: "application/vnd.amazon.ebook",
  AZW3: "application/vnd.amazon.ebook",
  KFX: "application/vnd.amazon.ebook",
  PDF: "application/pdf",
  TXT: "text/plain; charset=utf-8",
  HTML: "text/html; charset=utf-8",
  HTM: "text/html; charset=utf-8",
  RTF: "application/rtf",
  DOC: "application/msword",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  FB2: "application/x-fictionbook+xml",
  DJVU: "image/vnd.djvu",
  CBZ: "application/vnd.comicbook+zip",
  CBR: "application/vnd.comicbook-rar",
  CB7: "application/x-cb7",
};

const PATH_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript; charset=utf-8",
  ncx: "application/x-dtbncx+xml",
  opf: "application/oebps-package+xml",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xhtml: "application/xhtml+xml; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};

const BROWSER_READABLE_FORMATS = new Set(["EPUB", "PDF", "CBZ", "CBR"]);

export function getFormatContentType(format: string): string {
  return FORMAT_CONTENT_TYPES[format.toUpperCase()] ?? "application/octet-stream";
}

export function getPathContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return PATH_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function canReadInBrowser(format: string): boolean {
  return BROWSER_READABLE_FORMATS.has(format.toUpperCase());
}

export function getSafeBookFilename(title: string | null | undefined, format: string): string {
  const normalizedTitle = title?.normalize("NFKC");
  const printableTitle = normalizedTitle
    ? Array.from(normalizedTitle)
        .filter((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return character !== "/" && character !== "\\" && codePoint >= 32 && codePoint !== 127;
        })
        .join("")
    : "";
  const safeTitle =
    printableTitle
      .replace(/[?%*:|"<>]/g, "-")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/^\.+$/, "")
      .slice(0, 160) || "book";

  return `${safeTitle}.${format.toLowerCase()}`;
}
