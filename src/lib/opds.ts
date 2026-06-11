import type {
  BookListItem,
  BookWithDetails,
  CatalogEntry,
  CursorPaginatedResult,
} from "./calibre-optimized";
import { canReadInBrowser, getFormatContentType } from "./book-files";

export const OPDS_NAVIGATION_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
export const OPDS_ACQUISITION_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const OPENSEARCH_TYPE = "application/opensearchdescription+xml";

type OpdsBook = BookListItem | BookWithDetails;

interface NavigationFeedOptions {
  baseUrl: string;
  updated: string;
  totalBooks: number;
}

interface AcquisitionFeedOptions {
  baseUrl: string;
  selfPath: string;
  title: string;
  id: string;
  updated: string;
  result: CursorPaginatedResult<BookListItem>;
  nextPath?: string;
}

interface CatalogFeedOptions {
  baseUrl: string;
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
  selfPath: string;
  updated: string;
  book: BookWithDetails;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function xml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

export function toOpdsDate(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function feedPreamble(_kind: "navigation" | "acquisition"): string {
  return `${XML_DECLARATION}
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/">`;
}

function commonFeedLinks(baseUrl: string, selfPath: string, selfType: string): string {
  return `
  <link rel="self" href="${xml(absoluteUrl(baseUrl, selfPath))}" type="${xml(selfType)}"/>
  <link rel="start" href="${xml(absoluteUrl(baseUrl, "/opds"))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
  <link rel="search" href="${xml(absoluteUrl(baseUrl, "/opds/search.xml"))}" type="${xml(OPENSEARCH_TYPE)}" title="Search Caliber"/>`;
}

function navigationEntry(
  baseUrl: string,
  title: string,
  href: string,
  summary: string,
  updated: string,
  type: string = OPDS_ACQUISITION_TYPE,
): string {
  const absHref = absoluteUrl(baseUrl, href);

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

  return `${feedPreamble("navigation")}
  <title>Caliber</title>
  <id>${xml(absoluteUrl(baseUrl, "/opds"))}</id>
  <updated>${xml(updated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, "/opds", OPDS_NAVIGATION_TYPE)}
  ${navigationEntry(
    baseUrl,
    "All books",
    "/opds/books?sortBy=title&sortOrder=asc",
    `${totalBooks.toLocaleString()} books sorted by title.`,
    updated,
  )}
  ${navigationEntry(
    baseUrl,
    "Recently added",
    "/opds/recent",
    "Newest books in this Calibre library.",
    updated,
  )}
  ${navigationEntry(
    baseUrl,
    "Authors",
    "/opds/authors",
    "Browse books by author.",
    updated,
    OPDS_NAVIGATION_TYPE,
  )}
  ${navigationEntry(
    baseUrl,
    "Series",
    "/opds/series",
    "Browse books by series.",
    updated,
    OPDS_NAVIGATION_TYPE,
  )}
  ${navigationEntry(
    baseUrl,
    "Tags",
    "/opds/tags",
    "Browse books by tag.",
    updated,
    OPDS_NAVIGATION_TYPE,
  )}
  ${navigationEntry(
    baseUrl,
    "Formats",
    "/opds/formats",
    "Browse books by file format.",
    updated,
    OPDS_NAVIGATION_TYPE,
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
    const clean = stripHtml(comments);
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

function formatLinks(book: OpdsBook, baseUrl: string): string {
  return book.formats
    .map((format) => {
      const normalized = format.toUpperCase();
      const type = getFormatContentType(normalized);
      const downloadHref = absoluteUrl(baseUrl, `/api/books/${book.id}/download/${normalized}`);
      const fileHref = absoluteUrl(baseUrl, `/api/books/${book.id}/file/${normalized}`);
      const readLink = canReadInBrowser(normalized)
        ? `    <link rel="alternate" href="${xml(
            absoluteUrl(baseUrl, `/read/${book.id}/${normalized.toLowerCase()}`),
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

function renderBookEntry(book: OpdsBook, baseUrl: string): string {
  const updated = toOpdsDate(book.timestamp || book.pubdate);
  const detailHref = absoluteUrl(baseUrl, `/opds/book/${book.id}`);
  const webHref = absoluteUrl(baseUrl, `/book/${book.id}`);
  const uuid = "uuid" in book && book.uuid ? `urn:uuid:${book.uuid}` : detailHref;
  const coverLinks = book.has_cover
    ? `
    <link rel="http://opds-spec.org/image" href="${xml(
      absoluteUrl(baseUrl, `/api/books/${book.id}/cover`),
    )}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${xml(
      absoluteUrl(baseUrl, `/api/books/${book.id}/thumb`),
    )}" type="image/jpeg"/>`
    : "";
  const categories = bookCategories(book);
  const metadata = bookMetadata(book);

  return `
  <entry>
    <title>${xml(book.title)}</title>
    <id>${xml(uuid)}</id>
    <updated>${xml(updated)}</updated>
${bookAuthors(book)}
${metadata}${categories ? `${categories}\n` : ""}    <summary type="text">${xml(bookSummary(book))}</summary>
    <link rel="alternate" href="${xml(webHref)}" type="text/html" title="Open in Caliber"/>
    <link rel="subsection" href="${xml(detailHref)}" type="${xml(
      OPDS_ACQUISITION_TYPE,
    )}" title="Book details"/>
${coverLinks}
${formatLinks(book, baseUrl)}
  </entry>`;
}

export function renderAcquisitionFeed(options: AcquisitionFeedOptions): string {
  const { baseUrl, selfPath, title, id, updated, result, nextPath } = options;
  const latestItem = result.items[0];
  const feedUpdated = latestItem ? toOpdsDate(latestItem.timestamp || latestItem.pubdate) : updated;
  const nextLink =
    result.hasMore && nextPath
      ? `
  <link rel="next" href="${xml(absoluteUrl(baseUrl, nextPath))}" type="${xml(
    OPDS_ACQUISITION_TYPE,
  )}"/>`
      : "";

  return `${feedPreamble("acquisition")}
  <title>${xml(title)}</title>
  <id>${xml(id)}</id>
  <updated>${xml(feedUpdated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_ACQUISITION_TYPE)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds"))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
${nextLink}
${result.items.map((book) => renderBookEntry(book, baseUrl)).join("")}
</feed>`;
}

function renderCatalogEntry(
  entry: CatalogEntry,
  baseUrl: string,
  updated: string,
  entryHref: (entry: CatalogEntry) => string,
): string {
  const href = absoluteUrl(baseUrl, entryHref(entry));
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
  const nextLink =
    result.hasMore && nextPath
      ? `
  <link rel="next" href="${xml(absoluteUrl(baseUrl, nextPath))}" type="${xml(
    OPDS_NAVIGATION_TYPE,
  )}"/>`
      : "";

  return `${feedPreamble("navigation")}
  <title>${xml(title)}</title>
  <id>${xml(id)}</id>
  <updated>${xml(updated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_NAVIGATION_TYPE)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds"))}" type="${xml(OPDS_NAVIGATION_TYPE)}"/>
${nextLink}
${result.items.map((entry) => renderCatalogEntry(entry, baseUrl, updated, entryHref)).join("")}
</feed>`;
}

export function renderSingleBookFeed(options: SingleBookFeedOptions): string {
  const { baseUrl, selfPath, updated, book } = options;
  const feedUpdated = toOpdsDate(book.timestamp || book.pubdate || updated);

  return `${feedPreamble("acquisition")}
  <title>${xml(book.title)}</title>
  <id>${xml(absoluteUrl(baseUrl, selfPath))}</id>
  <updated>${xml(feedUpdated)}</updated>
  <author><name>Caliber</name></author>
  ${commonFeedLinks(baseUrl, selfPath, OPDS_ACQUISITION_TYPE)}
  <link rel="up" href="${xml(absoluteUrl(baseUrl, "/opds/books"))}" type="${xml(
    OPDS_ACQUISITION_TYPE,
  )}"/>
${renderBookEntry(book, baseUrl)}
</feed>`;
}

export function renderOpenSearchDescription(baseUrl: string): string {
  return `${XML_DECLARATION}
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Caliber</ShortName>
  <Description>Search the Caliber library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${xml(OPDS_ACQUISITION_TYPE)}" template="${xml(
    absoluteUrl(baseUrl, "/opds/search?q={searchTerms}"),
  )}"/>
</OpenSearchDescription>`;
}
