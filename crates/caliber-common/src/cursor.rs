//! Cursor codec shared by the book and catalog listings.
//!
//! Cursors are opaque `base64url` (no padding) strings wrapping a compact
//! JSON object `{"id":...,"sort":...}` where `sort` is a string or a finite
//! number. Decoding is structural and lenient (any key order, both numeric
//! spellings); encoding must stay URL-safe. The DB layer validates that the
//! decoded `sort` type matches the active sort field and rejects mismatches
//! with HTTP 400.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::types::CatalogId;

#[derive(Debug, Clone, PartialEq)]
pub enum CursorSort {
    Text(String),
    Number(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BookCursor {
    pub id: i64,
    pub sort: CursorSort,
}

#[derive(Serialize)]
struct CursorJson<'a> {
    id: i64,
    sort: &'a CursorSort,
}

#[derive(Serialize)]
struct CatalogCursorJson<'a> {
    id: &'a CatalogId,
    sort: &'a str,
}

#[derive(Deserialize)]
struct CursorJsonIn {
    id: serde_json::Number,
    sort: serde_json::Value,
}

#[derive(Deserialize)]
struct CatalogCursorJsonIn {
    id: serde_json::Value,
    sort: String,
}

fn encode_payload(payload: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes())
}

fn decode_payload(cursor: &str) -> Option<Vec<u8>> {
    // Bun's `Buffer.from(cursor, "base64url")` is forgiving; be strict here
    // because TS wraps every decode in try/catch and treats failure as an
    // invalid cursor.
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .ok()
}

impl Serialize for CursorSort {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            CursorSort::Text(s) => serializer.serialize_str(s),
            CursorSort::Number(n) => serializer.serialize_f64(*n),
        }
    }
}

/// Encode a book cursor. Mirrors TS
/// `Buffer.from(JSON.stringify({id, sort})).toString("base64url")`.
pub fn encode_book_cursor(id: i64, sort: &CursorSort) -> String {
    let payload = serde_json::to_string(&CursorJson { id, sort })
        .expect("cursor payload is always serializable");
    encode_payload(&payload)
}

/// Decode a book cursor with TS-equivalent validation: positive safe integer
/// id, string or finite-number sort.
pub fn decode_book_cursor(cursor: &str) -> Option<BookCursor> {
    let bytes = decode_payload(cursor)?;
    let parsed: CursorJsonIn = serde_json::from_slice(&bytes).ok()?;
    if !parsed.id.is_u64() || parsed.id.as_u64()? == 0 || parsed.id.as_u64()? > (1i64 << 53) as u64
    {
        return None;
    }
    let id = parsed.id.as_i64()?;
    let sort = match parsed.sort {
        serde_json::Value::String(s) => CursorSort::Text(s),
        serde_json::Value::Number(n) => {
            let f = n.as_f64()?;
            if !f.is_finite() {
                return None;
            }
            CursorSort::Number(f)
        }
        _ => return None,
    };
    Some(BookCursor { id, sort })
}

/// Encode a catalog cursor `{"id":...,"sort":"..."}` where id is a number or
/// a string (formats use uppercase strings).
pub fn encode_catalog_cursor(id: &CatalogId, sort: &str) -> String {
    let payload = serde_json::to_string(&CatalogCursorJson { id, sort })
        .expect("cursor payload is always serializable");
    encode_payload(&payload)
}

/// Decode a catalog cursor: positive safe integer id or non-empty string id,
/// string sort.
pub fn decode_catalog_cursor(cursor: &str) -> Option<(CatalogId, String)> {
    let bytes = decode_payload(cursor)?;
    let parsed: CatalogCursorJsonIn = serde_json::from_slice(&bytes).ok()?;
    let id = match parsed.id {
        serde_json::Value::Number(n) => {
            let v = n.as_i64()?;
            if v <= 0 || v > (1i64 << 53) {
                return None;
            }
            CatalogId::Num(v)
        }
        serde_json::Value::String(s) => {
            if s.is_empty() {
                return None;
            }
            CatalogId::Text(s)
        }
        _ => return None,
    };
    Some((id, parsed.sort))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_cursor_round_trip() {
        let cursor = encode_book_cursor(42, &CursorSort::Text("foo".into()));
        assert!(!cursor.contains('='));
        assert!(!cursor.contains('+'));
        assert!(!cursor.contains('/'));
        let decoded = decode_book_cursor(&cursor).unwrap();
        assert_eq!(decoded.id, 42);
        assert_eq!(decoded.sort, CursorSort::Text("foo".into()));

        let numeric = encode_book_cursor(7, &CursorSort::Number(3.0));
        let decoded = decode_book_cursor(&numeric).unwrap();
        assert_eq!(decoded.sort, CursorSort::Number(3.0));
    }

    #[test]
    fn decodes_ts_produced_cursor() {
        // Generated with Bun:
        // Buffer.from(JSON.stringify({id: 5, sort: "abc"})).toString("base64url")
        let ts_cursor = "eyJpZCI6NSwic29ydCI6ImFiYyJ9";
        let decoded = decode_book_cursor(ts_cursor).unwrap();
        assert_eq!(decoded.id, 5);
        assert_eq!(decoded.sort, CursorSort::Text("abc".into()));
    }

    #[test]
    fn rejects_invalid_cursors() {
        assert!(decode_book_cursor("!!!not-base64!!!").is_none());
        assert!(decode_book_cursor(&encode_payload("[]")).is_none());
        assert!(decode_book_cursor(&encode_payload("{\"id\":0,\"sort\":\"x\"}")).is_none());
        assert!(decode_book_cursor(&encode_payload("{\"id\":5,\"sort\":true}")).is_none());
        assert!(decode_book_cursor(&encode_payload(
            "{\"id\":5,\"sort\":1.7976931348623157e309}"
        ))
        .is_none());
    }

    #[test]
    fn catalog_cursor_round_trip() {
        let cursor = encode_catalog_cursor(&CatalogId::Num(3), "a");
        let (id, sort) = decode_catalog_cursor(&cursor).unwrap();
        assert_eq!(id, CatalogId::Num(3));
        assert_eq!(sort, "a");

        let cursor = encode_catalog_cursor(&CatalogId::Text("EPUB".into()), "epub");
        let (id, sort) = decode_catalog_cursor(&cursor).unwrap();
        assert_eq!(id, CatalogId::Text("EPUB".into()));
        assert_eq!(sort, "epub");
    }
}
