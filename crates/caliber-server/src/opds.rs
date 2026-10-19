//! OPDS feed renderers — faithful port of src/lib/opds.ts. Output is
//! byte-compatible with the TS implementation (XML declaration, media type
//! constants, FORBIDDEN_CONTROLS strip, entry/link shapes).

use caliber_common::types::{BookListItem, BookWithDetails, CatalogEntry, CursorPaginatedResult};
use caliber_common::SortField;

pub const OPDS_NAVIGATION_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";
pub const OPDS_ACQUISITION_TYPE: &str =
    "application/atom+xml;profile=opds-catalog;kind=acquisition";
pub const OPDS_ENTRY_TYPE: &str = "application/atom+xml;type=entry;profile=opds-catalog";
pub const OPENSEARCH_TYPE: &str = "application/opensearchdescription+xml";

const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";

enum BookDetail<'a> {
    List(&'a BookListItem),
    Details(&'a BookWithDetails),
}

impl BookDetail<'_> {
    fn id(&self) -> i64 {
        match self {
            BookDetail::List(b) => b.id,
            BookDetail::Details(b) => b.id,
        }
    }
    fn title(&self) -> &str {
        match self {
            BookDetail::List(b) => &b.title,
            BookDetail::Details(b) => &b.title,
        }
    }
    fn authors(&self) -> &[String] {
        match self {
            BookDetail::List(b) => &b.authors,
            BookDetail::Details(b) => &b.authors,
        }
    }
    fn series(&self) -> Option<&String> {
        match self {
            BookDetail::List(b) => b.series.as_ref(),
            BookDetail::Details(b) => b.series.as_ref(),
        }
    }
    fn series_index(&self) -> f64 {
        match self {
            BookDetail::List(b) => b.series_index,
            BookDetail::Details(b) => b.series_index,
        }
    }
    fn tags(&self) -> &[String] {
        match self {
            BookDetail::List(b) => &b.tags,
            BookDetail::Details(b) => &b.tags,
        }
    }
    fn formats(&self) -> &[String] {
        match self {
            BookDetail::List(b) => &b.formats,
            BookDetail::Details(b) => &b.formats,
        }
    }
    fn has_cover(&self) -> bool {
        match self {
            BookDetail::List(b) => b.has_cover,
            BookDetail::Details(b) => b.has_cover,
        }
    }
    fn uuid(&self) -> Option<&String> {
        match self {
            BookDetail::List(b) => b.uuid.as_ref(),
            BookDetail::Details(b) => b.uuid.as_ref(),
        }
    }
    fn last_modified(&self) -> Option<&String> {
        match self {
            BookDetail::List(b) => b.last_modified.as_ref(),
            BookDetail::Details(b) => b.last_modified.as_ref(),
        }
    }
    fn timestamp(&self) -> &str {
        match self {
            BookDetail::List(b) => &b.timestamp,
            BookDetail::Details(b) => &b.timestamp,
        }
    }
    fn pubdate(&self) -> &str {
        match self {
            BookDetail::List(b) => &b.pubdate,
            BookDetail::Details(b) => &b.pubdate,
        }
    }
    fn comments(&self) -> Option<&String> {
        match self {
            BookDetail::List(_) => None,
            BookDetail::Details(b) => b.comments.as_ref(),
        }
    }
    fn publisher(&self) -> Option<&String> {
        match self {
            BookDetail::List(_) => None,
            BookDetail::Details(b) => b.publisher.as_ref(),
        }
    }
    fn isbn(&self) -> Option<&str> {
        match self {
            BookDetail::List(_) => None,
            BookDetail::Details(b) => Some(b.isbn.as_str()),
        }
    }
}

/// F23: strip forbidden XML 1.0 control chars, then escape the five XML
/// entities.
pub fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        let cp = c as u32;
        let forbidden = matches!(cp, 0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F | 0x7F);
        if forbidden {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// TS `stripHtmlTags`.
pub fn strip_html_tags(input: &str) -> String {
    let mut s = replace_tagged(input, "style");
    s = replace_tagged(&s, "script");
    // <[^>]*> → " "
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut consumed_gt = false;
            for inner in chars.by_ref() {
                if inner == '>' {
                    out.push(' ');
                    consumed_gt = true;
                    break;
                }
            }
            let _ = consumed_gt;
        } else {
            out.push(c);
        }
    }
    let lower = out.to_lowercase();
    let out = lower.replace("&nbsp;", " ");
    // \s+ → " " then trim
    let mut collapsed = String::with_capacity(out.len());
    let mut in_ws = false;
    for c in out.chars() {
        if c.is_whitespace() {
            if !in_ws {
                collapsed.push(' ');
                in_ws = true;
            }
        } else {
            collapsed.push(c);
            in_ws = false;
        }
    }
    collapsed.trim().to_string()
}

fn replace_tagged(input: &str, tag: &str) -> String {
    let open_a = format!("<{tag}");
    let lower = input.to_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while i < lower.len() {
        if lower[i..].starts_with(&open_a) {
            let after = &lower[i + open_a.len()..];
            let next = after.find(|c| c == '>').map(|p| i + open_a.len() + p);
            if let Some(start_inner) = next {
                let close = format!("</{tag}");
                if let Some(rel) = lower[start_inner..].find(&close) {
                    let end = start_inner + rel + close.len();
                    // find the closing '>' of the close tag
                    if let Some(gt) = lower[end..].find('>') {
                        out.push(' ');
                        i = end + gt + 1;
                        continue;
                    }
                }
            }
        }
        // copy one full char (multi-byte safe)
        let ch_end = lower[i..]
            .char_indices()
            .nth(1)
            .map(|(p, _)| i + p)
            .unwrap_or(lower.len());
        // Use the original-cased slice; we matched on lowercase only.
        out.push_str(&input[i..ch_end]);
        i = ch_end;
    }
    out
}

/// TS `normalizePathPrefix`.
pub fn normalize_path_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return String::new();
    }
    let prefixed = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    let trimmed_end = prefixed.trim_end_matches('/');
    trimmed_end.to_string()
}

/// TS `withPathPrefix` (idempotent join).
pub fn with_path_prefix(path: &str, prefix: &str) -> String {
    let normalized = normalize_path_prefix(prefix);
    if normalized.is_empty() {
        return path.to_string();
    }
    if path == normalized || path.starts_with(&format!("{normalized}/")) {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("{normalized}{path}")
    } else {
        format!("{normalized}/{path}")
    }
}

/// TS `absoluteUrl` — `new URL(withPathPrefix(path, prefix), baseUrl)`.
/// Paths generated here are absolute and pre-encoded, so origin concat is
/// exact.
pub fn absolute_url(base_url: &str, path: &str, prefix: &str) -> String {
    format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        with_path_prefix(path, prefix)
    )
}

/// TS `getRequestPrefix`: X-Forwarded-Prefix (trusted proxy), then BASE_PATH /
/// CALIBER_BASE_PATH env, then the path component of CALIBER_BASE_URL.
pub fn get_request_prefix(trust_proxy: bool, headers: &axum::http::HeaderMap) -> String {
    if trust_proxy {
        if let Some(forwarded) = headers
            .get("x-forwarded-prefix")
            .and_then(|v| v.to_str().ok())
        {
            let first = forwarded.split(',').next().unwrap_or("").trim();
            if !first.is_empty() {
                return normalize_path_prefix(first);
            }
        }
    }
    let configured = std::env::var("BASE_PATH")
        .ok()
        .or_else(|| std::env::var("CALIBER_BASE_PATH").ok())
        .map(|v| normalize_path_prefix(&v))
        .unwrap_or_default();
    if !configured.is_empty() {
        return configured;
    }
    if let Ok(base_url) = std::env::var("CALIBER_BASE_URL") {
        let trimmed = base_url.trim().to_string();
        if !trimmed.is_empty() {
            if let Ok(url) = url::Url::parse(&trimmed) {
                let derived = normalize_path_prefix(url.path());
                if !derived.is_empty() {
                    return derived;
                }
            }
        }
    }
    String::new()
}

/// TS `toOpdsDate`: parse then ISO-8601 UTC; epoch fallback.
pub fn to_opds_date(value: &str) -> String {
    match crate::helpers::parse_js_date_millis(value) {
        Some(ms) => crate::helpers::iso_string_from_millis(ms),
        None => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

fn feed_preamble() -> &'static str {
    &"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:opds=\"http://opds-spec.org/2010/catalog\" xmlns:dcterms=\"http://purl.org/dc/terms/\">"
}

fn common_feed_links(base_url: &str, self_path: &str, self_type: &str, prefix: &str) -> String {
    format!(
        "\n  <link rel=\"self\" href=\"{s}\" type=\"{t}\"/>\n  <link rel=\"start\" href=\"{n}\" type=\"{nt}\"/>\n  <link rel=\"search\" href=\"{x}\" type=\"{xt}\" title=\"Search Caliber\"/>",
        s = xml_escape(&absolute_url(base_url, self_path, prefix)),
        t = xml_escape(self_type),
        n = xml_escape(&absolute_url(base_url, "/opds", prefix)),
        nt = xml_escape(OPDS_NAVIGATION_TYPE),
        x = xml_escape(&absolute_url(base_url, "/opds/search.xml", prefix)),
        xt = xml_escape(OPENSEARCH_TYPE),
    )
}

fn navigation_entry(
    base_url: &str,
    title: &str,
    href: &str,
    summary: &str,
    updated: &str,
    kind: &str,
    prefix: &str,
) -> String {
    let abs = absolute_url(base_url, href, prefix);
    format!(
        "\n  <entry>\n    <title>{t}</title>\n    <id>{i}</id>\n    <updated>{u}</updated>\n    <content type=\"text\">{c}</content>\n    <link rel=\"subsection\" href=\"{h}\" type=\"{ty}\"/>\n  </entry>",
        t = xml_escape(title),
        i = xml_escape(&abs),
        u = xml_escape(updated),
        c = xml_escape(summary),
        h = xml_escape(&abs),
        ty = xml_escape(kind),
    )
}

pub struct NavigationFeedOptions<'a> {
    pub base_url: &'a str,
    pub path_prefix: &'a str,
    pub updated: &'a str,
    pub total_books: i64,
}

pub fn render_navigation_feed(options: &NavigationFeedOptions) -> String {
    let NavigationFeedOptions {
        base_url,
        path_prefix,
        updated,
        total_books,
    } = options;
    let books_label = format!(
        "{} books sorted by title.",
        crate::helpers::to_locale_string(*total_books)
    );
    format!(
        "{pre}\n  <title>Caliber</title>\n  <id>{id}</id>\n  <updated>{up}</updated>\n  <author><name>Caliber</name></author>\n  {links}\n  {e1}\n  {e2}\n  {e3}\n  {e4}\n  {e5}\n  {e6}\n</feed>",
        pre = feed_preamble(),
        id = xml_escape(&absolute_url(base_url, "/opds", path_prefix)),
        up = xml_escape(updated),
        links = common_feed_links(base_url, "/opds", OPDS_NAVIGATION_TYPE, path_prefix),
        e1 = navigation_entry(base_url, "All books", "/opds/books?sortBy=title&sortOrder=asc", &books_label, updated, OPDS_ACQUISITION_TYPE, path_prefix),
        e2 = navigation_entry(base_url, "Recently added", "/opds/recent", "Newest books in this Calibre library.", updated, OPDS_ACQUISITION_TYPE, path_prefix),
        e3 = navigation_entry(base_url, "Authors", "/opds/authors", "Browse books by author.", updated, OPDS_NAVIGATION_TYPE, path_prefix),
        e4 = navigation_entry(base_url, "Series", "/opds/series", "Browse books by series.", updated, OPDS_NAVIGATION_TYPE, path_prefix),
        e5 = navigation_entry(base_url, "Tags", "/opds/tags", "Browse books by tag.", updated, OPDS_NAVIGATION_TYPE, path_prefix),
        e6 = navigation_entry(base_url, "Formats", "/opds/formats", "Browse books by file format.", updated, OPDS_NAVIGATION_TYPE, path_prefix),
    )
}

fn book_authors(book: &BookDetail) -> String {
    let authors: Vec<String> = if book.authors().is_empty() {
        vec!["Unknown".to_string()]
    } else {
        book.authors().to_vec()
    };
    authors
        .iter()
        .map(|a| format!("    <author><name>{}</name></author>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn book_summary(book: &BookDetail) -> String {
    if let Some(comments) = book.comments() {
        let clean = strip_html_tags(comments);
        if !clean.is_empty() {
            return clean;
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(series) = book.series() {
        parts.push(format!(
            "Series: {} #{}",
            series,
            crate::helpers::js_number_string(book.series_index())
        ));
    }
    if !book.tags().is_empty() {
        parts.push(format!("Tags: {}", book.tags().join(", ")));
    }
    if !book.formats().is_empty() {
        parts.push(format!("Formats: {}", book.formats().join(", ")));
    }
    if parts.is_empty() {
        "No description available.".to_string()
    } else {
        parts.join("\n")
    }
}

fn book_categories(book: &BookDetail) -> String {
    book.tags()
        .iter()
        .map(|t| {
            format!(
                "    <category term=\"{t}\" label=\"{t}\"/>",
                t = xml_escape(t)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn book_metadata(book: &BookDetail) -> String {
    let mut out = String::new();
    if let Some(publisher) = book.publisher() {
        out.push_str(&format!(
            "    <dcterms:publisher>{}</dcterms:publisher>\n",
            xml_escape(publisher)
        ));
    }
    if let Some(isbn) = book.isbn() {
        if !isbn.is_empty() {
            out.push_str(&format!(
                "    <dcterms:identifier>ISBN:{}</dcterms:identifier>\n",
                xml_escape(isbn)
            ));
        }
    }
    out
}

/// F22: entry updated prefers last_modified, then timestamp/pubdate.
fn book_updated(book: &BookDetail, fallback: Option<&str>) -> String {
    let candidate = book
        .last_modified()
        .filter(|s| !s.is_empty())
        .map(String::as_str)
        .unwrap_or_else(|| {
            if !book.timestamp().is_empty() {
                book.timestamp()
            } else if !book.pubdate().is_empty() {
                book.pubdate()
            } else {
                fallback.unwrap_or("")
            }
        });
    to_opds_date(candidate)
}

/// F22: acquisition feed updated = max(last_modified) across items.
pub fn acquisition_feed_updated(items: &[BookListItem], fallback: &str) -> String {
    let mut max_time: Option<i64> = None;
    for item in items {
        let candidate = item
            .last_modified
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if !item.timestamp.is_empty() {
                    &item.timestamp
                } else {
                    &item.pubdate
                }
            });
        if let Some(ms) = crate::helpers::parse_js_date_millis(candidate) {
            max_time = Some(match max_time {
                Some(current) if current >= ms => current,
                _ => ms,
            });
        }
    }
    match max_time {
        Some(t) if t > 0 => crate::helpers::iso_string_from_millis(t),
        _ => to_opds_date(fallback),
    }
}

fn format_links(book: &BookDetail, base_url: &str, prefix: &str) -> String {
    book.formats()
        .iter()
        .map(|format| {
            let normalized = format.to_ascii_uppercase();
            let ty = crate::files::format_content_type_for(&normalized);
            let download_href = absolute_url(
                base_url,
                &format!("/opds/book/{}/download/{normalized}", book.id()),
                prefix,
            );
            let file_href = absolute_url(
                base_url,
                &format!("/opds/book/{}/file/{normalized}", book.id()),
                prefix,
            );
            let read_link = if crate::files::can_read_in_browser_pub(&normalized) {
                format!(
                    "    <link rel=\"alternate\" href=\"{}\" type=\"text/html\" title=\"Read {}\"/>",
                    xml_escape(&absolute_url(
                        base_url,
                        &format!("/read/{}/{}", book.id(), normalized.to_ascii_lowercase()),
                        prefix
                    )),
                    xml_escape(&normalized)
                )
            } else {
                String::new()
            };
            let mut out = format!(
                "    <link rel=\"http://opds-spec.org/acquisition/open-access\" href=\"{}\" type=\"{}\" title=\"Download {}\"/>\n    <link rel=\"alternate\" href=\"{}\" type=\"{}\" title=\"Open {}\"/>",
                xml_escape(&download_href),
                xml_escape(ty),
                xml_escape(&normalized),
                xml_escape(&file_href),
                xml_escape(ty),
                xml_escape(&normalized),
            );
            if !read_link.is_empty() {
                out.push('\n');
                out.push_str(&read_link);
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_book_entry_contents(book: &BookDetail, base_url: &str, prefix: &str) -> String {
    let updated = book_updated(book, None);
    let detail_href = absolute_url(base_url, &format!("/opds/book/{}", book.id()), prefix);
    let complete_href = absolute_url(
        base_url,
        &format!("/opds/book/{}/complete", book.id()),
        prefix,
    );
    let web_href = absolute_url(base_url, &format!("/book/{}", book.id()), prefix);
    let uuid = match book.uuid() {
        Some(u) if !u.is_empty() => format!("urn:uuid:{}", u),
        _ => detail_href.clone(),
    };
    let cover_links = if book.has_cover() {
        format!(
            "\n    <link rel=\"http://opds-spec.org/image\" href=\"{}\" type=\"image/jpeg\"/>\n    <link rel=\"http://opds-spec.org/image/thumbnail\" href=\"{}\" type=\"image/jpeg\"/>",
            xml_escape(&absolute_url(base_url, &format!("/opds/book/{}/cover", book.id()), prefix)),
            xml_escape(&absolute_url(base_url, &format!("/opds/book/{}/thumb", book.id()), prefix)),
        )
    } else {
        String::new()
    };
    let categories = book_categories(book);
    let metadata = book_metadata(book);
    let categories_section = if categories.is_empty() {
        String::new()
    } else {
        format!("{categories}\n")
    };
    format!(
        "    <title>{t}</title>\n    <id>{i}</id>\n    <updated>{u}</updated>\n{a}\n{m}{c}    <summary type=\"text\">{s}</summary>\n    <link rel=\"alternate\" href=\"{w}\" type=\"text/html\" title=\"Open in Caliber\"/>\n    <link rel=\"subsection\" href=\"{d}\" type=\"{dt}\" title=\"Book details\"/>\n    <link rel=\"alternate\" href=\"{cc}\" type=\"{ct}\" title=\"Complete entry\"/>\n{cl}\n{fl}",
        t = xml_escape(book.title()),
        i = xml_escape(&uuid),
        u = xml_escape(&updated),
        a = book_authors(book),
        m = metadata,
        c = categories_section,
        s = xml_escape(&book_summary(book)),
        w = xml_escape(&web_href),
        d = xml_escape(&detail_href),
        dt = xml_escape(OPDS_ACQUISITION_TYPE),
        cc = xml_escape(&complete_href),
        ct = xml_escape(OPDS_ENTRY_TYPE),
        cl = cover_links,
        fl = format_links(book, base_url, prefix),
    )
}

fn render_book_entry(book: &BookDetail, base_url: &str, prefix: &str) -> String {
    format!(
        "\n  <entry>\n{c}\n  </entry>",
        c = render_book_entry_contents(book, base_url, prefix)
    )
}

pub struct AcquisitionFeedOptions<'a> {
    pub base_url: &'a str,
    pub path_prefix: &'a str,
    pub self_path: &'a str,
    pub title: &'a str,
    pub id: &'a str,
    pub updated: &'a str,
    pub result: &'a CursorPaginatedResult<BookListItem>,
    pub next_path: Option<String>,
}

pub fn render_acquisition_feed(options: &AcquisitionFeedOptions) -> String {
    let AcquisitionFeedOptions {
        base_url,
        path_prefix,
        self_path,
        title,
        id,
        updated,
        result,
        next_path,
    } = options;
    let feed_updated = if !result.items.is_empty() {
        acquisition_feed_updated(&result.items, updated)
    } else {
        to_opds_date(updated)
    };
    let next_link = if result.has_more && next_path.is_some() {
        format!(
            "\n  <link rel=\"next\" href=\"{}\" type=\"{}\"/>",
            xml_escape(&absolute_url(
                base_url,
                next_path.as_deref().unwrap_or(""),
                path_prefix
            )),
            xml_escape(OPDS_ACQUISITION_TYPE)
        )
    } else {
        String::new()
    };
    let entries = result
        .items
        .iter()
        .map(|b| render_book_entry(&BookDetail::List(b), base_url, path_prefix))
        .collect::<String>();
    format!(
        "{pre}\n  <title>{t}</title>\n  <id>{i}</id>\n  <updated>{u}</updated>\n  <author><name>Caliber</name></author>\n  {links}\n  <link rel=\"up\" href=\"{up}\" type=\"{upt}\"/>\n{n}\n{e}</feed>",
        pre = feed_preamble(),
        t = xml_escape(title),
        i = xml_escape(id),
        u = xml_escape(&feed_updated),
        links = common_feed_links(base_url, self_path, OPDS_ACQUISITION_TYPE, path_prefix),
        up = xml_escape(&absolute_url(base_url, "/opds", path_prefix)),
        upt = xml_escape(OPDS_NAVIGATION_TYPE),
        n = next_link,
        e = entries,
    )
}

fn render_catalog_entry(
    entry: &CatalogEntry,
    base_url: &str,
    updated: &str,
    entry_href: &str,
    prefix: &str,
) -> String {
    let href = absolute_url(base_url, entry_href, prefix);
    let label = if entry.book_count == 1 {
        "1 book".to_string()
    } else {
        format!(
            "{} books",
            crate::helpers::to_locale_string(entry.book_count)
        )
    };
    format!(
        "\n  <entry>\n    <title>{t}</title>\n    <id>{i}</id>\n    <updated>{u}</updated>\n    <content type=\"text\">{c}</content>\n    <link rel=\"subsection\" href=\"{h}\" type=\"{ty}\"/>\n  </entry>",
        t = xml_escape(&entry.title),
        i = xml_escape(&href),
        u = xml_escape(updated),
        c = xml_escape(&label),
        h = xml_escape(&href),
        ty = xml_escape(OPDS_ACQUISITION_TYPE),
    )
}

pub struct CatalogFeedOptions<'a> {
    pub base_url: &'a str,
    pub path_prefix: &'a str,
    pub self_path: &'a str,
    pub title: &'a str,
    pub id: &'a str,
    pub updated: &'a str,
    pub result: &'a CursorPaginatedResult<CatalogEntry>,
    pub next_path: Option<String>,
    pub entry_hrefs: Vec<String>,
}

pub fn render_catalog_feed(options: &CatalogFeedOptions) -> String {
    let CatalogFeedOptions {
        base_url,
        path_prefix,
        self_path,
        title,
        id,
        updated,
        result,
        next_path,
        entry_hrefs,
    } = options;
    let next_link = if result.has_more && next_path.is_some() {
        format!(
            "\n  <link rel=\"next\" href=\"{}\" type=\"{}\"/>",
            xml_escape(&absolute_url(
                base_url,
                next_path.as_deref().unwrap_or(""),
                path_prefix
            )),
            xml_escape(OPDS_NAVIGATION_TYPE)
        )
    } else {
        String::new()
    };
    let entries = result
        .items
        .iter()
        .zip(entry_hrefs.iter())
        .map(|(e, href)| render_catalog_entry(e, base_url, updated, href, path_prefix))
        .collect::<String>();
    format!(
        "{pre}\n  <title>{t}</title>\n  <id>{i}</id>\n  <updated>{u}</updated>\n  <author><name>Caliber</name></author>\n  {links}\n  <link rel=\"up\" href=\"{up}\" type=\"{upt}\"/>\n{n}\n{e}</feed>",
        pre = feed_preamble(),
        t = xml_escape(title),
        i = xml_escape(id),
        u = xml_escape(updated),
        links = common_feed_links(base_url, self_path, OPDS_NAVIGATION_TYPE, path_prefix),
        up = xml_escape(&absolute_url(base_url, "/opds", path_prefix)),
        upt = xml_escape(OPDS_NAVIGATION_TYPE),
        n = next_link,
        e = entries,
    )
}

pub struct SingleBookFeedOptions<'a> {
    pub base_url: &'a str,
    pub path_prefix: &'a str,
    pub self_path: &'a str,
    pub updated: &'a str,
    pub book: &'a BookWithDetails,
}

pub fn render_single_book_feed(options: &SingleBookFeedOptions) -> String {
    let SingleBookFeedOptions {
        base_url,
        path_prefix,
        self_path,
        updated,
        book,
    } = options;
    let feed_updated = book_updated(&BookDetail::Details(book), Some(updated));
    format!(
        "{pre}\n  <title>{t}</title>\n  <id>{i}</id>\n  <updated>{u}</updated>\n  <author><name>Caliber</name></author>\n  {links}\n  <link rel=\"up\" href=\"{up}\" type=\"{upt}\"/>\n{e}\n</feed>",
        pre = feed_preamble(),
        t = xml_escape(&book.title),
        i = xml_escape(&absolute_url(base_url, self_path, path_prefix)),
        u = xml_escape(&feed_updated),
        links = common_feed_links(base_url, self_path, OPDS_ACQUISITION_TYPE, path_prefix),
        up = xml_escape(&absolute_url(base_url, "/opds/books", path_prefix)),
        upt = xml_escape(OPDS_ACQUISITION_TYPE),
        e = render_book_entry(&BookDetail::Details(book), base_url, path_prefix),
    )
}

/// F23 complete entry: a bare `<entry>` document.
pub fn render_book_complete_entry(
    base_url: &str,
    path_prefix: &str,
    book: &BookWithDetails,
) -> String {
    format!(
        "{decl}\n<entry xmlns=\"http://www.w3.org/2005/Atom\" xmlns:opds=\"http://opds-spec.org/2010/catalog\" xmlns:dcterms=\"http://purl.org/dc/terms/\">\n{c}\n</entry>",
        decl = XML_DECLARATION,
        c = render_book_entry_contents(&BookDetail::Details(book), base_url, path_prefix)
    )
}

pub fn render_open_search_description(base_url: &str, prefix: &str) -> String {
    format!(
        "{decl}\n<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n  <ShortName>Caliber</ShortName>\n  <Description>Search the Caliber library</Description>\n  <InputEncoding>UTF-8</InputEncoding>\n  <OutputEncoding>UTF-8</OutputEncoding>\n  <Url type=\"{t}\" template=\"{tpl}\"/>\n</OpenSearchDescription>",
        decl = XML_DECLARATION,
        t = xml_escape(OPDS_ACQUISITION_TYPE),
        tpl = xml_escape(&absolute_url(base_url, "/opds/search?q={searchTerms}", prefix)),
    )
}

/// SortField → string used in next-page links.
pub fn sort_field_str(sort: SortField) -> &'static str {
    sort.as_str()
}
