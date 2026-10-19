//! Small ports of the JS runtime helpers the TS server leans on:
//! date parse/format, `encodeURIComponent`/`decodeURIComponent`, cookie
//! parsing, `toLocaleString`, and `parseBoundedInt`.

use std::time::{SystemTime, UNIX_EPOCH};

/// Strict `^-?\d+$` integer parse then clamp (TS `parseBoundedInt`).
pub fn parse_bounded_int(raw: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    let raw = match raw {
        Some(v) => v.trim(),
        None => return fallback,
    };
    if raw.is_empty()
        || !raw
            .chars()
            .all(|c| c.is_ascii_digit() || (c == '-' && raw.len() > 1))
        || raw == "-"
    {
        return fallback;
    }
    match raw.parse::<i64>() {
        Ok(v) if v.abs() <= (1i64 << 53) => min.max(max.min(v)),
        _ => fallback,
    }
}

/// JavaScript `encodeURIComponent`: unreserved chars stay, everything else is
/// `%XX` of the UTF-8 bytes.
pub fn js_encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// JavaScript `decodeURIComponent`; `Err(())` on malformed input (the TS
/// callers wrap it in try/catch).
pub fn js_decode_uri_component(value: &str) -> Result<String, ()> {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() + 1 {
                return Err(());
            }
            if i + 2 > bytes.len() - 1 {
                return Err(());
            }
            let h = hex(bytes[i + 1]).ok_or(())?;
            let l = hex(bytes[i + 2]).ok_or(())?;
            out.push(h * 16 + l);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// `application/x-www-form-urlencoded` decoding (query strings): `+` is a
/// space, `%XX` decoded. Lenient: malformed escapes pass through verbatim.
pub fn form_url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = (bytes[i + 1] as char).to_digit(16);
                let l = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (h, l) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn parse_hms(part: &str) -> Option<(i64, i64, i64, i64)> {
    // "HH:MM:SS", "HH:MM:SS.mmm", "HH:MM" (lenient)
    let (hms, frac) = match part.split_once('.') {
        Some((a, b)) => (a, b),
        None => (part, ""),
    };
    let segs: Vec<&str> = hms.split(':').collect();
    if segs.is_empty() || segs.len() > 3 {
        return None;
    }
    let h: i64 = segs[0].parse().ok()?;
    let mi: i64 = segs.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let s: i64 = segs.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let millis = if frac.is_empty() {
        0
    } else {
        let padded = format!("{frac:0<3}");
        padded[..3.min(padded.len())].parse::<i64>().ok()?
    };
    if !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..60).contains(&s) {
        return None;
    }
    Some((h, mi, s, millis))
}

fn parse_offset(part: &str) -> Option<i64> {
    let part = part.trim();
    if part.is_empty() || part.eq_ignore_ascii_case("Z") || part.eq_ignore_ascii_case("GMT") {
        return Some(0);
    }
    let (sign, rest) = match part.as_bytes()[0] {
        b'+' => (1i64, &part[1..]),
        b'-' => (-1i64, &part[1..]),
        _ => return None,
    };
    let segs: Vec<&str> = rest.split(':').collect();
    let h: i64 = segs.first()?.parse().ok()?;
    let m: i64 = segs.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(sign * (h * 3600 + m * 60))
}

/// Approximation of `new Date(value).getTime()` for the shapes Calibre and
/// this server emit: `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.f][±HH:MM|Z]`,
/// `YYYY-MM-DDTHH:MM:SS[.f][±HH:MM|Z]`. Naive date-times are treated as UTC
/// (JS would use the local zone; tests run with an explicit offset). Returns
/// epoch milliseconds.
pub fn parse_js_date_millis(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (date_part, time_part) = match value.split_once(['T', ' ']) {
        Some((d, t)) if !t.is_empty() => (d, Some(t)),
        _ => (value, None),
    };
    let mut segs = date_part.split('-');
    let y: i64 = segs.next()?.parse().ok()?;
    let m: i64 = segs.next()?.parse().ok()?;
    let d: i64 = segs.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (h, mi, s, millis, offset_secs) = match time_part {
        Some(t) => {
            // Trim a trailing timezone from the time component.
            let (t_core, tz) = match find_tz_index(t) {
                Some(i) => (&t[..i], &t[i..]),
                None => (t, ""),
            };
            let (h, mi, s, millis) = parse_hms(t_core)?;
            (h, mi, s, millis, parse_offset(tz).unwrap_or(0))
        }
        None => (0, 0, 0, 0, 0),
    };
    let days = days_from_civil(y, m, d);
    let secs = days * 86400 + h * 3600 + mi * 60 + s - offset_secs;
    Some(secs * 1000 + millis)
}

fn find_tz_index(t: &str) -> Option<usize> {
    let bytes = t.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'Z' || b == b'z' {
            return Some(i);
        }
        if b == b'+' && i > 0 {
            return Some(i);
        }
        if b == b'-' && i > 2 {
            return Some(i);
        }
    }
    None
}

/// `new Date(ms).toISOString()` — always UTC, millisecond precision.
pub fn iso_string_from_millis(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// HTTP IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT") for Last-Modified.
pub fn http_date_from_unix_secs(secs: i64) -> String {
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, mo, d) = civil_from_days(days);
    let wd = WD[(days.rem_euclid(7)) as usize];
    format!(
        "{wd}, {d:02} {} {y:04} {:02}:{:02}:{:02} GMT",
        MO[(mo - 1) as usize],
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Parse an HTTP IMF-fixdate (the format we emit) back to unix seconds.
pub fn parse_http_date_secs(value: &str) -> Option<i64> {
    // "Sun, 18 Oct 2026 12:00:00 GMT" (weekday token length varies).
    let trimmed = value.trim();
    let rest = match trimmed.find(',') {
        Some(pos) => trimmed[pos + 1..].trim(),
        None => trimmed
            .split_once(' ')
            .map(|(_, remainder)| remainder.trim())
            .unwrap_or(trimmed),
    };
    let mut segs = rest.split_whitespace();
    let d: i64 = segs.next()?.parse().ok()?;
    let mon = segs.next()?;
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let m = MO.iter().position(|m| m.eq_ignore_ascii_case(mon))? as i64 + 1;
    let y: i64 = segs.next()?.parse().ok()?;
    let (h, mi, s, _) = parse_hms(segs.next()?)?;
    Some(days_from_civil(y, m, d) * 86400 + h * 3600 + mi * 60 + s)
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/// `n.toLocaleString()` with the default en-US grouping.
pub fn to_locale_string(n: i64) -> String {
    let negative = n < 0;
    let digits = n.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        grouped.push(c);
        let remaining = digits.len() - i - 1;
        if remaining > 0 && remaining % 3 == 0 {
            grouped.push(',');
        }
    }
    if negative {
        format!("-{grouped}")
    } else {
        grouped
    }
}

/// JS `String(number)` for the f64 values this server prints (series indexes):
/// integral values print without a decimal point.
pub fn js_number_string(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

// ---------------------------------------------------------------------------
// Cookies / query
// ---------------------------------------------------------------------------

/// TS `parseCookies` — semicolon split, URL-decode values, malformed parts
/// ignored.
pub fn parse_cookie_header(header: Option<&str>) -> Vec<(String, String)> {
    let Some(header) = header else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in header.split(';') {
        let Some(eq) = part.find('=') else { continue };
        let name = part[..eq].trim();
        let value = part[eq + 1..].trim();
        if name.is_empty() {
            continue;
        }
        if let Ok(decoded) = js_decode_uri_component(value) {
            out.push((name.to_string(), decoded));
        }
    }
    out
}

/// Single named cookie value (`parseCookieHeader` in auth.ts).
pub fn cookie_value(header: Option<&str>, name: &str) -> Option<String> {
    parse_cookie_header(header)
        .into_iter()
        .find(|(n, _)| n == name)
        .and_then(|(_, v)| if v.is_empty() { None } else { Some(v) })
}

/// Parse a query string into ordered key/value pairs (repeated keys kept),
/// with `application/x-www-form-urlencoded` decoding.
pub fn parse_query_pairs(query: Option<&str>) -> Vec<(String, String)> {
    let Some(query) = query else {
        return Vec::new();
    };
    let query = query.strip_prefix('?').unwrap_or(query);
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (form_url_decode(k), form_url_decode(v)),
            None => (form_url_decode(pair), String::new()),
        })
        .collect()
}

/// `URLSearchParams.set` serialization (values encoded with `+` for spaces).
pub fn form_url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_int_matches_ts() {
        assert_eq!(parse_bounded_int(Some("12"), 5, 1, 100), 12);
        assert_eq!(parse_bounded_int(Some("0"), 5, 1, 100), 1);
        assert_eq!(parse_bounded_int(Some("999"), 5, 1, 100), 100);
        assert_eq!(parse_bounded_int(Some("1e2"), 5, 1, 100), 5);
        assert_eq!(parse_bounded_int(Some(""), 5, 1, 100), 5);
        assert_eq!(parse_bounded_int(None, 50, 1, 100), 50);
    }

    #[test]
    fn js_dates_round_trip() {
        let ms = parse_js_date_millis("2024-01-02 00:00:00+00:00").unwrap();
        assert_eq!(iso_string_from_millis(ms), "2024-01-02T00:00:00.000Z");
        let ms = parse_js_date_millis("2024-06-01T12:30:45.123-05:00").unwrap();
        assert_eq!(iso_string_from_millis(ms), "2024-06-01T17:30:45.123Z");
        let ms = parse_js_date_millis("2024-03-05").unwrap();
        assert_eq!(iso_string_from_millis(ms), "2024-03-05T00:00:00.000Z");
        assert_eq!(parse_js_date_millis("junk"), None);
        let epoch = parse_js_date_millis("1970-01-01T00:00:00.000Z").unwrap();
        assert_eq!(epoch, 0);
    }

    #[test]
    fn http_date_round_trip() {
        let secs = 1760788800i64; // 2025-10-18T12:00:00Z-ish anchor
        let text = http_date_from_unix_secs(secs);
        assert!(text.ends_with("GMT"));
        assert_eq!(parse_http_date_secs(&text), Some(secs));
    }

    #[test]
    fn locale_string_groups_thousands() {
        assert_eq!(to_locale_string(0), "0");
        assert_eq!(to_locale_string(999), "999");
        assert_eq!(to_locale_string(1000), "1,000");
        assert_eq!(to_locale_string(1234567), "1,234,567");
    }

    #[test]
    fn js_number_strings() {
        assert_eq!(js_number_string(1.0), "1");
        assert_eq!(js_number_string(2.5), "2.5");
    }

    #[test]
    fn uri_component() {
        assert_eq!(js_encode_uri_component("a b&c"), "a%20b%26c");
        assert_eq!(js_decode_uri_component("a%20b").unwrap(), "a b");
        assert!(js_decode_uri_component("%zz").is_err());
        // encodeURIComponent does NOT encode !'()*
        assert_eq!(js_encode_uri_component("!'()*"), "!'()*");
    }

    #[test]
    fn cookies_parse() {
        let pairs = parse_cookie_header(Some("a=1; caliber-user=John%20Doe; bad"));
        assert_eq!(pairs[0], ("a".into(), "1".into()));
        assert_eq!(pairs[1], ("caliber-user".into(), "John Doe".into()));
        assert_eq!(
            cookie_value(Some("caliber-user=x"), "caliber-user"),
            Some("x".into())
        );
        assert_eq!(cookie_value(Some("caliber-user="), "caliber-user"), None);
    }
}
