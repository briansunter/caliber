import type {
  BookListItem,
  BookWithDetails,
  CatalogEntry,
  CursorPaginatedResult,
} from "./calibre-optimized";
import { canReadInBrowser, getFormatContentType } from "./book-files";
import { stripHtmlTags } from "./utils";

export const OPDS_NAVIGATION_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
export const OPDS_ACQUISITION_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const OPDS_ENTRY_TYPE = "application/atom+xml;type=entry;profile=opds-catalog";
export const OPENSEARCH_TYPE = "application/opensearchdescription+xml";

type OpdsBook = BookListItem | BookWithDetails;

interface NavigationFeedOptions {
  baseUrl: string;
  pathPrefix?: string;
  updated: string;
  totalBooks: number;
}

interface AcquisitionFeedOptions {
  baseUrl: string;
  pathPrefix?: string;
  selfPath: string;
  title: string;
  id: string;
  updated: string;
  result: CursorPaginatedResult<BookListItem>;
  nextPath?: string;
}

interface CatalogFeedOptions {
  baseUrl: string;
  pathPrefix?: string;
  selfPath: string;
  title: string;
  id: string;
  updated: string;
  result: CursorPaginatedResult<CatalogEntry>;
  nextPath?: string;
  entryHref: (entry: CatalogEntry) => string;
}

interface SingleBookFeedOptions {
  baseUrl: string;
  pathPrefix?: string;
  selfPath: string;
  updated: string;
  book: BookWithDetails;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

// F23: strip forbidden XML control chars before escaping.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional XML 1.0 forbidden-range strip
const FORBIDDEN_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
function xml(value: unknown): string {
  return String(value ?? "")
    .replace(FORBIDDEN_CONTROLS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Normalize a deployment path prefix (X-Forwarded-Prefix / BASE_PATH). */
export function normalizePathPrefix(prefix: string | null | undefined): string {
  if (!prefix) return "";
  let normalized = prefix.trim();
  if (!normalized || normalized === "/") return "";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized.replace(/\/+$/, "");
}

/** Join a prefix and an absolute path without double slashes. Idempotent: a
 * path that already carries the prefix is returned unchanged. */
export function withPathPrefix(path: string, prefix: string | null | undefined): string {
  const normalized = normalizePathPrefix(prefix);
  if (!normalized) return path;
  if (path === normalized || path.startsWith(`${normalized}/`)) return path;
  return `${normalized}${path.startsWith("/") ? path : `/${path}`}`;
}

// F24: absoluteUrl respects the deployment prefix via shared helper.
function absoluteUrl(baseUrl: string, path: string, prefix: string | null | undefined = ""): string {
  return new URL(withPathPrefix(path, prefix), baseUrl).toString();
}

/** Resolve the request path prefix from proxy headers / BASE_PATH env. */
export function getRequestPrefix(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("X-Forwarded-Prefix");
    if (forwarded?.trim()) return normalizePathPrefix(forwarded.split(",")[0]?.trim());
  }
  const configured = normalizePathPrefix(process.env.BASE_PATH ?? process.env.CALIBER_BASE_PATH);
  if (configured) return configured;
  // Derive from CALIBER_BASE_URL when it mounts Caliber under a sub-path
  // (e.g. https://host/prefix); origin-only values normalize to "".
  const baseUrl = process.env.CALIBER_BASE_URL?.trim();
  if (baseUrl) {
    try {
      const derived = normalizePathPrefix(new URL(baseUrl).pathname);
      if (derived) return derived;
    } catch {
      // Invalid base URL: no prefix.
    }
  }
  return "";
}

export function toOpdsDate(value: string | null | undefined): string {
  if (!value) return "1970-01-01T00:00:00.000Z";

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

function feedPreamble(_kind: "navigation" | "acquisition"): string {
  return `${XML_DECLARATION}
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/">`;
}

function commonFeedLinks(
  baseUrl: string,
  selfPath: string,
  selfType: string,
  prefix: string | null | undefined = "",
): string {
  return `
  <link rel="self" href="${xml(absoluteUrl(baseUrl, selfPath, prefix))}" type="${xml(selfType)}"/>
  <link rel="start" href="${xml(absoluteUrl(baseUrl, "/opds", prefix))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
  <link rel="search" href="${xml(absoluteUrl(baseUrl, "/opds/search.xml", prefix))}" type="${xml(OPENSEARCH_TYPE)}" title="Search Caliber"/>`;
}

function navigationEntry(
  baseUrl: string,
  title: string,
  href: string,
  summary: string,
  updated: string,
  type: string = OPDS_NAVIGATION_TYPE,
  prefix: string | null | undefined = "",
): string {
  const absHref = absoluteUrl(baseUrl, href, prefix);

  return `
  <entry>
    <title>${xml(title)}</title>
    <id>${xml(absHref)}</id>
    <updated>${xml(updated)}</updated>
    <content type="text">${xml(summary)}</content>
    <link rel="subsection" href="${xml(absHref)}" type="${xml(type)}"/>
  </entry>`;
}

export function renderNavigationFeed(options: NavigationFeedOptions): string {
  const { baseUrl, updated, totalBooks } = options;
  const prefix = options.pathPrefix ?? "";

  return `${feedPreamble("navigation")}
  <title>Caliber</title>
  <id>${xml(absoluteUrl(baseUrl, "/opds", prefix))}</id>
  <updated>${xml(updated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, "/opds", OPDS_NAVIGATION_TYPE, prefix)}
  ${navigationEntry(
    baseUrl,
    "All books",
    "/opds/books?sortBy=title&sortOrder=asc",
    `${totalBooks.toLocaleString()} books sorted by title.`,
    updated,
    OPDS_ACQUISITION_TYPE,
    prefix,
  )}
  ${navigationEntry(
    baseUrl,
    "Recently added",
    "/opds/recent",
    "Newest books in this Calibre library.",
    updated,
    OPDS_ACQUISITION_TYPE,
    prefix,
  )}
  ${navigationEntry(
    baseUrl,
    "Authors",
    "/opds/authors",
    "Browse books by author.",
    updated,
    OPDS_NAVIGATION_TYPE,
    prefix,
  )}
  ${navigationEntry(
    baseUrl,
    "Series",
    "/opds/series",
    "Browse books by series.",
    updated,
    OPDS_NAVIGATION_TYPE,
    prefix,
  )}
  ${navigationEntry(
    baseUrl,
    "Tags",
    "/opds/tags",
    "Browse books by tag.",
    updated,
    OPDS_NAVIGATION_TYPE,
    prefix,
  )}
  ${navigationEntry(
    baseUrl,
    "Formats",
    "/opds/formats",
    "Browse books by file format.",
    updated,
    OPDS_NAVIGATION_TYPE,
    prefix,
  )}
</feed>`;
}

function bookAuthors(book: OpdsBook): string {
  const authors = book.authors.length > 0 ? book.authors : ["Unknown"];
  return authors.map((author) => `    <author><name>${xml(author)}</name></author>`).join("\n");
}

function bookSummary(book: OpdsBook): string {
  const comments = "comments" in book ? book.comments : null;
  if (comments) {
    const clean = stripHtmlTags(comments);
    if (clean.length > 0) return clean;
  }

  const parts = [
    book.series ? `Series: ${book.series} #${book.series_index}` : null,
    book.tags.length > 0 ? `Tags: ${book.tags.join(", ")}` : null,
    book.formats.length > 0 ? `Formats: ${book.formats.join(", ")}` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("\n") : "No description available.";
}

function bookCategories(book: OpdsBook): string {
  return book.tags
    .map((tag) => `    <category term="${xml(tag)}" label="${xml(tag)}"/>`)
    .join("\n");
}

function bookMetadata(book: OpdsBook): string {
  const details = book as Partial<BookWithDetails>;
  const publisher = details.publisher
    ? `    <dcterms:publisher>${xml(details.publisher)}</dcterms:publisher>\n`
    : "";
  const isbn = details.isbn
    ? `    <dcterms:identifier>ISBN:${xml(details.isbn)}</dcterms:identifier>\n`
    : "";

  return `${publisher}${isbn}`;
}

// F21: lightweight DTO ensure — guarantees the minimal acquisition shape
// (id/title/link-critical fields) without carrying heavy detail payloads.
export function ensureOpdsBookDto<T extends OpdsBook>(book: T): T {
  if (Array.isArray(book.formats)) return book;
  return { ...book, formats: [] as string[] };
}

// F22: entry updated prefers Calibre last_modified, then timestamp/pubdate.
export function bookUpdated(book: OpdsBook, fallback?: string | null): string {
  const lastModified = "last_modified" in book ? book.last_modified : null;
  return toOpdsDate(lastModified || book.timestamp || book.pubdate || fallback || null);
}

// F22: acquisition feed updated = max(last_modified) across items.
export function acquisitionFeedUpdated(items: OpdsBook[], fallback: string): string {
  let maxTime = 0;
  for (const item of items) {
    const lastModified = "last_modified" in item ? item.last_modified : null;
    const candidate = lastModified || item.timestamp || item.pubdate || fallback;
    const time = Date.parse(candidate);
    if (Number.isFinite(time) && time > maxTime) maxTime = time;
  }
  return maxTime > 0 ? new Date(maxTime).toISOString() : toOpdsDate(fallback);
}

function formatLinks(book: OpdsBook, baseUrl: string, prefix: string | null | undefined = ""): string {
  return book.formats
    .map((format) => {
      const normalized = format.toUpperCase();
      const type = getFormatContentType(normalized);
      // F24: acquisition/artwork links stay under /opds so OPDS clients
      // authenticate with the challenge-capable OPDS routes.
      const downloadHref = absoluteUrl(baseUrl, `/opds/book/${book.id}/download/${normalized}`, prefix);
      const fileHref = absoluteUrl(baseUrl, `/opds/book/${book.id}/file/${normalized}`, prefix);
      const readLink = canReadInBrowser(normalized)
        ? `    <link rel="alternate" href="${xml(
            absoluteUrl(baseUrl, `/read/${book.id}/${normalized.toLowerCase()}`, prefix),
          )}" type="text/html" title="Read ${xml(normalized)}"/>`
        : "";

      return `    <link rel="http://opds-spec.org/acquisition/open-access" href="${xml(
        downloadHref,
      )}" type="${xml(type)}" title="Download ${xml(normalized)}"/>
    <link rel="alternate" href="${xml(fileHref)}" type="${xml(type)}" title="Open ${xml(
      normalized,
    )}"/>
${readLink}`.trimEnd();
    })
    .join("\n");
}

function renderBookEntryContents(
  book: OpdsBook,
  baseUrl: string,
  prefix: string | null | undefined = "",
): string {
  const dto = ensureOpdsBookDto(book);
  const updated = bookUpdated(dto);
  const detailHref = absoluteUrl(baseUrl, `/opds/book/${dto.id}`, prefix);
  const completeHref = absoluteUrl(baseUrl, `/opds/book/${dto.id}/complete`, prefix);
  const webHref = absoluteUrl(baseUrl, `/book/${dto.id}`, prefix);
  // F21: always use urn:uuid when the list query provided a uuid.
  const uuid = "uuid" in dto && dto.uuid ? `urn:uuid:${dto.uuid}` : detailHref;
  const coverLinks = dto.has_cover
    ? `
    <link rel="http://opds-spec.org/image" href="${xml(
      absoluteUrl(baseUrl, `/opds/book/${dto.id}/cover`, prefix),
    )}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${xml(
      absoluteUrl(baseUrl, `/opds/book/${dto.id}/thumb`, prefix),
    )}" type="image/jpeg"/>`
    : "";
  const categories = bookCategories(dto);
  const metadata = bookMetadata(dto);

  return `    <title>${xml(dto.title)}</title>
    <id>${xml(uuid)}</id>
    <updated>${xml(updated)}</updated>
${bookAuthors(dto)}
${metadata}${categories ? `${categories}\n` : ""}    <summary type="text">${xml(bookSummary(dto))}</summary>
    <link rel="alternate" href="${xml(webHref)}" type="text/html" title="Open in Caliber"/>
    <link rel="subsection" href="${xml(detailHref)}" type="${xml(
      OPDS_ACQUISITION_TYPE,
    )}" title="Book details"/>
    <link rel="alternate" href="${xml(completeHref)}" type="${xml(
      OPDS_ENTRY_TYPE,
    )}" title="Complete entry"/>
${coverLinks}
${formatLinks(dto, baseUrl, prefix)}`;
}

function renderBookEntry(book: OpdsBook, baseUrl: string, prefix: string | null | undefined = ""): string {
  return `
  <entry>
${renderBookEntryContents(book, baseUrl, prefix)}
  </entry>`;
}

export function renderAcquisitionFeed(options: AcquisitionFeedOptions): string {
  const { baseUrl, selfPath, title, id, updated, result, nextPath } = options;
  const prefix = options.pathPrefix ?? "";
  // F22: feed updated = max(last_modified) of items, not the first item.
  const feedUpdated =
    result.items.length > 0 ? acquisitionFeedUpdated(result.items, updated) : toOpdsDate(updated);
  const nextLink =
    result.hasMore && nextPath
      ? `
  <link rel="next" href="${xml(absoluteUrl(baseUrl, nextPath, prefix))}" type="${xml(
    OPDS_ACQUISITION_TYPE,
  )}"/>`
      : "";

  return `${feedPreamble("acquisition")}
  <title>${xml(title)}</title>
  <id>${xml(id)}</id>
  <updated>${xml(feedUpdated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_ACQUISITION_TYPE, prefix)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds", prefix))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
${nextLink}
${result.items.map((book) => renderBookEntry(book, baseUrl, prefix)).join("")}
</feed>`;
}

function renderCatalogEntry(
  entry: CatalogEntry,
  baseUrl: string,
  updated: string,
  entryHref: (entry: CatalogEntry) => string,
  prefix: string | null | undefined = "",
): string {
  const href = absoluteUrl(baseUrl, entryHref(entry), prefix);
  const label = entry.bookCount === 1 ? "1 book" : `${entry.bookCount.toLocaleString()} books`;

  return `
  <entry>
    <title>${xml(entry.title)}</title>
    <id>${xml(href)}</id>
    <updated>${xml(updated)}</updated>
    <content type="text">${xml(label)}</content>
    <link rel="subsection" href="${xml(href)}" type="${xml(OPDS_ACQUISITION_TYPE)}"/>
  </entry>`;
}

export function renderCatalogFeed(options: CatalogFeedOptions): string {
  const { baseUrl, selfPath, title, id, updated, result, nextPath, entryHref } = options;
  const prefix = options.pathPrefix ?? "";
  const nextLink =
    result.hasMore && nextPath
      ? `
  <link rel="next" href="${xml(absoluteUrl(baseUrl, nextPath, prefix))}" type="${xml(
    OPDS_NAVIGATION_TYPE,
  )}"/>`
      : "";

  return `${feedPreamble("navigation")}
  <title>${xml(title)}</title>
  <id>${xml(id)}</id>
  <updated>${xml(updated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_NAVIGATION_TYPE, prefix)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds", prefix))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
${nextLink}
${result.items.map((entry) => renderCatalogEntry(entry, baseUrl, updated, entryHref, prefix)).join("")}
</feed>`;
}

export function renderSingleBookFeed(options: SingleBookFeedOptions): string {
  const { baseUrl, selfPath, updated, book } = options;
  const prefix = options.pathPrefix ?? "";
  const feedUpdated = bookUpdated(book, updated);

  return `${feedPreamble("acquisition")}
  <title>${xml(book.title)}</title>
  <id>${xml(absoluteUrl(baseUrl, selfPath, prefix))}</id>
  <updated>${xml(feedUpdated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_ACQUISITION_TYPE, prefix)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds/books", prefix))}" type="${xml(
    OPDS_ACQUISITION_TYPE,
  )}"/>
${renderBookEntry(book, baseUrl, prefix)}
</feed>`;
}

export interface CompleteEntryOptions {
  baseUrl: string;
  pathPrefix?: string;
  book: BookWithDetails;
}

// OPDS complete entry: a bare <entry> document (not a <feed>) served with
// `application/atom+xml;type=entry;profile=opds-catalog`, as referenced by
// the acquisition "Complete entry" alternate link.
export function renderBookCompleteEntry(options: CompleteEntryOptions): string {
  const prefix = options.pathPrefix ?? "";
  return `${XML_DECLARATION}
<entry xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/">
${renderBookEntryContents(options.book, options.baseUrl, prefix)}
</entry>`;
}

export function renderOpenSearchDescription(baseUrl: string, prefix: string | null | undefined = ""): string {
  return `${XML_DECLARATION}
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Caliber</ShortName>
  <Description>Search the Caliber library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${xml(OPDS_ACQUISITION_TYPE)}" template="${xml(
    absoluteUrl(baseUrl, "/opds/search?q={searchTerms}", prefix),
  )}"/>
</OpenSearchDescription>`;
}
