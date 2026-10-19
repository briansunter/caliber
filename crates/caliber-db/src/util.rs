//! Small ported helpers: Node-style path semantics, ISO-8601 timestamps, and
//! lenient SQLite value coercion (Bun's `bun:sqlite` returns whatever type the
//! column holds; the TS parser coerces implicitly).

use caliber_common::SourceSignature;
use rusqlite::types::Value as V;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Lexical absolute-path normalization, equivalent to Node's `path.resolve()`
/// (no symlink resolution — that is what [`std::fs::canonicalize`] is for).
pub(crate) fn normalize_path(p: &Path) -> PathBuf {
    let absolute = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                if !out.as_os_str().is_empty() {
                    // Repeated roots after normalization (e.g. "/a/../.."):
                    // keep the root, drop the extra.
                    out = PathBuf::new();
                }
                out.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// Node `path.join` semantics: concatenates path segments and never resets the
/// base when a later segment is absolute (`join("/lib", "/etc")` is
/// `/lib/etc`). `..` segments are kept lexically and resolved later by
/// [`normalize_path`], so containment checks still catch escapes.
pub(crate) fn js_join(base: &Path, middle: &str, file: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for segment in [middle, file] {
        for component in Path::new(segment).components() {
            match component {
                Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
                other => out.push(other.as_os_str()),
            }
        }
    }
    out
}

/// `isSafeLibraryPath` from `calibre-optimized.ts`: the candidate must resolve
/// lexically under the library root, and — when the file exists — must stay
/// under the *real* (symlink-resolved) library root too.
pub(crate) fn is_safe_library_path(library: &Path, file_path: &Path) -> bool {
    let resolved_library = normalize_path(library);
    let lexical_path = normalize_path(file_path);
    if !path_strictly_under(&lexical_path, &resolved_library) {
        return false;
    }
    if file_path.exists() {
        match (
            std::fs::canonicalize(&resolved_library),
            std::fs::canonicalize(file_path),
        ) {
            (Ok(real_library), Ok(real_file)) => {
                return path_strictly_under(&real_file, &real_library);
            }
            _ => return false,
        }
    }
    true
}

/// Component-wise `child` strictly under `parent` (Rust `Path::starts_with`
/// is already component-wise; we additionally reject equality).
fn path_strictly_under(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent) && child != parent
}

/// JavaScript `Number.prototype.toString()` for the finite floats we serialize
/// (integral values print without a decimal point).
fn js_number(value: f64) -> String {
    if value.is_finite() && value == value.trunc() && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        serde_json::to_string(&value).unwrap_or_else(|_| "0".to_string())
    }
}

/// `JSON.stringify(getDatabaseSignature(...))` byte-equivalent rendering
/// (camelCase keys in TS insertion order). Stored in `caliber_fts_meta`.
pub(crate) fn js_signature_json(signature: &SourceSignature) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("\"size\":{}", signature.size));
    parts.push(format!("\"mtimeMs\":{}", js_number(signature.mtime_ms)));
    if let Some(v) = signature.wal_size {
        parts.push(format!("\"walSize\":{v}"));
    }
    if let Some(v) = signature.wal_mtime_ms {
        parts.push(format!("\"walMtimeMs\":{}", js_number(v)));
    }
    if let Some(v) = signature.shm_size {
        parts.push(format!("\"shmSize\":{v}"));
    }
    if let Some(v) = signature.shm_mtime_ms {
        parts.push(format!("\"shmMtimeMs\":{}", js_number(v)));
    }
    format!("{{{}}}", parts.join(","))
}

/// `new Date(...).toISOString()`-style UTC timestamp with milliseconds.
pub(crate) fn iso8601_utc(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Howard Hinnant's `civil_from_days` (proleptic Gregorian, UTC).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

// --- Lenient value coercion (bun:sqlite hands back the raw column type) ---

pub(crate) fn value_string(value: &V) -> String {
    match value {
        V::Null => String::new(),
        V::Integer(i) => i.to_string(),
        V::Real(f) => f.to_string(),
        V::Text(s) => s.clone(),
        V::Blob(b) => String::from_utf8_lossy(b).to_string(),
    }
}

pub(crate) fn value_opt_string(value: &V) -> Option<String> {
    match value {
        V::Null => None,
        other => Some(value_string(other)),
    }
}

pub(crate) fn value_f64(value: &V) -> f64 {
    match value {
        V::Null => 0.0,
        V::Integer(i) => *i as f64,
        V::Real(f) => *f,
        V::Text(s) => s.parse().unwrap_or(0.0),
        V::Blob(_) => 0.0,
    }
}

pub(crate) fn value_opt_i64(value: &V) -> Option<i64> {
    match value {
        V::Null => None,
        V::Integer(i) => Some(*i),
        V::Real(f) if f.is_finite() => Some(*f as i64),
        V::Text(s) => s.parse::<f64>().ok().map(|f| f as i64),
        V::Real(_) => None,
        V::Blob(_) => None,
    }
}

pub(crate) fn value_bool(value: &V) -> bool {
    match value {
        V::Integer(i) => *i != 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_matches_node_resolve() {
        assert_eq!(
            normalize_path(Path::new("/lib/a/b")),
            PathBuf::from("/lib/a/b")
        );
        assert_eq!(
            normalize_path(Path::new("/lib/../etc")),
            PathBuf::from("/etc")
        );
        assert_eq!(
            normalize_path(Path::new("/lib/./x")),
            PathBuf::from("/lib/x")
        );
        assert_eq!(normalize_path(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(
            normalize_path(Path::new("a/b")),
            normalize_path(&std::env::current_dir().unwrap().join("a/b"))
        );
    }

    #[test]
    fn js_join_keeps_absolute_segments_under_base() {
        assert_eq!(
            js_join(Path::new("/lib"), "/etc", "x"),
            PathBuf::from("/lib/etc/x")
        );
        assert_eq!(
            js_join(Path::new("/lib"), "..", "y"),
            PathBuf::from("/lib/../y")
        );
    }

    #[test]
    fn containment_rejects_escapes() {
        let library = Path::new("/lib");
        assert!(is_safe_library_path(library, Path::new("/lib/a/cover.jpg")));
        assert!(!is_safe_library_path(library, Path::new("/lib/../y"))); // lexical resolve -> /y escapes
        assert!(!is_safe_library_path(
            library,
            Path::new("/library-x/cover.jpg")
        ));
        assert!(!is_safe_library_path(library, Path::new("/etc/passwd")));
        assert!(!is_safe_library_path(library, Path::new("/lib")));
    }

    #[test]
    fn iso8601_epoch_and_sample() {
        assert_eq!(
            iso8601_utc(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso8601_utc(UNIX_EPOCH + std::time::Duration::from_millis(86_400_123)),
            "1970-01-02T00:00:00.123Z"
        );
    }

    #[test]
    fn signature_json_matches_js_shape() {
        let sig = SourceSignature {
            size: 10,
            mtime_ms: 1234.0,
            wal_size: Some(0),
            wal_mtime_ms: Some(0.0),
            shm_size: Some(0),
            shm_mtime_ms: Some(0.0),
        };
        assert_eq!(
            js_signature_json(&sig),
            r#"{"size":10,"mtimeMs":1234,"walSize":0,"walMtimeMs":0,"shmSize":0,"shmMtimeMs":0}"#
        );
    }
}
