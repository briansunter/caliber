//! Small helpers shared by the user-db and auth modules.
//!
//! These reimplement the exact JavaScript semantics the TS implementation
//! relies on: `Date.now()`, base64 (URL-safe for tokens, Node's lenient
//! standard-alphabet decoder for Basic auth), ECMAScript string
//! trim/slice/`\s` character sets, and `Number.parseInt(s, 10)`.

/// Milliseconds since the Unix epoch (`Date.now()`).
pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Standard base64 with the URL-safe alphabet and no padding — the session
/// token wire format (TS: `btoa(...)` with `+`/`/` mapped to `-`/`_` and
/// trailing `=` stripped).
pub(crate) fn base64url_nopad(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_URL[(n >> 18) as usize & 0x3f] as char);
        out.push(B64_URL[(n >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(B64_URL[(n >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(B64_URL[n as usize & 0x3f] as char);
        }
    }
    out
}

/// Node's lenient base64 decoder (`Buffer.from(s, "base64")`): characters
/// outside the standard alphabet (including whitespace and padding) are
/// ignored; leftover bits that do not form a full byte are dropped.
pub(crate) fn base64_decode_lenient(input: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in input.as_bytes() {
        if let Some(v) = val(c) {
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push(((acc >> bits) & 0xff) as u8);
            }
        }
    }
    out
}

/// ECMAScript `String.prototype.trim` whitespace (WhiteSpace +
/// LineTerminator). Note this excludes U+FEFF, which `\s` does match.
fn is_js_trim_char(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000D}'
        | '\u{0020}'
        | '\u{00A0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}')
}

/// ECMAScript regexp `\s` class: the trim set plus U+FEFF (BOM).
pub(crate) fn is_js_regex_ws(c: char) -> bool {
    is_js_trim_char(c) || c == '\u{FEFF}'
}

/// ECMAScript `String.prototype.trim`.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_trim_char)
}

/// ECMAScript `String.prototype.slice(0, n)` (positive n), truncating on a
/// char boundary. JS counts UTF-16 code units; this counts `char`s, which
/// only differs for astral-plane characters at the cut point.
pub(crate) fn js_slice(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// ECMAScript `Number.parseInt(s, 10)`: skip leading JS whitespace, an
/// optional sign, then leading decimal digits; trailing junk is ignored.
/// Returns `None` where JS would produce `NaN`. Values that overflow i64
/// also return `None` (callers compare against the textual form, which can
/// never match an overflow magnitude anyway).
pub(crate) fn js_parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start_matches(is_js_trim_char);
    let mut chars = t.chars().peekable();
    let negative = match chars.peek() {
        Some('+') => {
            chars.next();
            false
        }
        Some('-') => {
            chars.next();
            true
        }
        _ => false,
    };
    let mut digits = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            digits.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    digits
        .parse::<i64>()
        .ok()
        .map(|v| if negative { -v } else { v })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_js_btoa_replacement() {
        // btoa("A") = "QQ==" -> strip padding -> "QQ"
        assert_eq!(base64url_nopad(b"A"), "QQ");
        assert_eq!(base64url_nopad(b"AB"), "QUI");
        assert_eq!(base64url_nopad(b"ABC"), "QUJD");
        // 32 bytes -> 43 chars, no padding, URL-safe alphabet only.
        let bytes: Vec<u8> = (0..32).collect();
        let token = base64url_nopad(&bytes);
        assert_eq!(token.len(), 43);
        assert!(token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn base64_decode_is_lenient_like_node() {
        assert_eq!(base64_decode_lenient("dXNlcjpwYXNz"), b"user:pass");
        // padding and whitespace ignored
        assert_eq!(base64_decode_lenient("dXNlcjpwYXNz=="), b"user:pass");
        assert_eq!(base64_decode_lenient(" dXNl cjpw YXNz "), b"user:pass");
        // invalid junk characters skipped
        assert_eq!(base64_decode_lenient("dXNlcj*pwYXNz"), b"user:pass");
        assert!(base64_decode_lenient("").is_empty());
        assert!(base64_decode_lenient("!!!!").is_empty());
    }

    #[test]
    fn js_parse_int_matches_number_parse_int() {
        assert_eq!(js_parse_int("12"), Some(12));
        assert_eq!(js_parse_int("  12  "), Some(12));
        assert_eq!(js_parse_int("12abc"), Some(12)); // parseInt ignores trailing junk
        assert_eq!(js_parse_int("+12"), Some(12));
        assert_eq!(js_parse_int("-12"), Some(-12));
        assert_eq!(js_parse_int(""), None); // NaN
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int("1e2"), Some(1)); // stops at 'e'
        assert_eq!(js_parse_int("9999999999999999999999"), None); // overflow ~ NaN-equivalent
    }

    #[test]
    fn js_trim_and_slice_edges() {
        assert_eq!(js_trim("  a b  "), "a b");
        assert_eq!(js_trim("\u{00A0}x\u{FEFF}"), "x\u{FEFF}"); // NBSP trimmed, BOM kept
        assert_eq!(js_slice("abcdefghij", 4), "abcd");
        assert_eq!(js_slice("abc", 10), "abc");
        assert_eq!(js_slice("", 3), "");
    }
}
