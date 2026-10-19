//! File signature used to detect Calibre source-database changes (including
//! uncommitted `-wal`/`-shm` sidecars) and to version on-disk media caches.
//!
//! Mirrors `src/lib/file-signature.ts`. The serialized shape (camelCase,
//! optional sidecar fields omitted) appears inside
//! `<config>/metadata.source.json` and the `.caliber-epub-cache.json` /
//! `.caliber-page-cache.json` meta files, so it must round-trip with files
//! written by the TS implementation.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

fn mtime_ms(md: &fs::Metadata) -> f64 {
    match md.modified().ok() {
        Some(t) => t
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0),
        None => 0.0,
    }
}

/// Signature of a single file: size + mtime in float milliseconds
/// (Node's `stat.mtimeMs`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSignature {
    pub size: u64,
    pub mtime_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shm_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shm_mtime_ms: Option<f64>,
}

/// Signature of just one file, no sidecars.
pub fn source_signature(path: &Path) -> std::io::Result<SourceSignature> {
    let md = fs::metadata(path)?;
    Ok(SourceSignature {
        size: md.len(),
        mtime_ms: mtime_ms(&md),
        wal_size: None,
        wal_mtime_ms: None,
        shm_size: None,
        shm_mtime_ms: None,
    })
}

fn optional_sidecar(path: &Path) -> (u64, f64) {
    match fs::metadata(path) {
        Ok(md) => (md.len(), mtime_ms(&md)),
        Err(_) => (0, 0.0),
    }
}

/// Signature of a SQLite database plus its `-wal`/`-shm` sidecars (missing
/// sidecars count as 0/0.0, matching the TS behavior).
pub fn database_signature(path: &Path) -> SourceSignature {
    let base = source_signature(path).unwrap_or(SourceSignature {
        size: 0,
        mtime_ms: 0.0,
        wal_size: None,
        wal_mtime_ms: None,
        shm_size: None,
        shm_mtime_ms: None,
    });
    let wal = optional_sidecar(Path::new(&format!("{}-wal", path.display())));
    let shm = optional_sidecar(Path::new(&format!("{}-shm", path.display())));
    SourceSignature {
        size: base.size,
        mtime_ms: base.mtime_ms,
        wal_size: Some(wal.0),
        wal_mtime_ms: Some(wal.1),
        shm_size: Some(shm.0),
        shm_mtime_ms: Some(shm.1),
    }
}

/// `isSameSignature` from TS: None sidecars are treated as 0. mtime values
/// compare with a 1µs epsilon: the same stat can wobble by ~1 float ULP at
/// epoch-ms magnitudes (f64 resolution ≈ 0.2µs at 1.8e12 ms), while real
/// Calibre edits change size or mtime by far more than a microsecond.
fn mtime_eq(a: f64, b: f64) -> bool {
    (a - b).abs() <= 0.001
}

pub fn is_same_signature(a: Option<&SourceSignature>, b: &SourceSignature) -> bool {
    match a {
        Some(a) => {
            a.size == b.size
                && mtime_eq(a.mtime_ms, b.mtime_ms)
                && a.wal_size.unwrap_or(0) == b.wal_size.unwrap_or(0)
                && mtime_eq(a.wal_mtime_ms.unwrap_or(0.0), b.wal_mtime_ms.unwrap_or(0.0))
                && a.shm_size.unwrap_or(0) == b.shm_size.unwrap_or(0)
                && mtime_eq(a.shm_mtime_ms.unwrap_or(0.0), b.shm_mtime_ms.unwrap_or(0.0))
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_ts() {
        let sig = SourceSignature {
            size: 10,
            mtime_ms: 1234.5,
            wal_size: None,
            wal_mtime_ms: None,
            shm_size: None,
            shm_mtime_ms: None,
        };
        let json = serde_json::to_string(&sig).unwrap();
        assert_eq!(json, r#"{"size":10,"mtimeMs":1234.5}"#);

        let full = SourceSignature {
            size: 1,
            mtime_ms: 2.0,
            wal_size: Some(3),
            wal_mtime_ms: Some(4.0),
            shm_size: Some(0),
            shm_mtime_ms: Some(0.0),
        };
        let json = serde_json::to_string(&full).unwrap();
        assert!(json.contains("\"walSize\":3"));
        // TS files written by the old implementation round-trip.
        let parsed: SourceSignature =
            serde_json::from_str(r#"{"size":1,"mtimeMs":2,"walSize":3,"walMtimeMs":4}"#).unwrap();
        assert_eq!(parsed.wal_size, Some(3));
        assert_eq!(parsed.shm_size, None);
        // Missing sidecars compare as 0, so a signature with walSize 3 does
        // NOT match one without (TS treats undefined as 0; 3 != 0).
        assert!(!is_same_signature(
            Some(&SourceSignature {
                size: 1,
                mtime_ms: 2.0,
                wal_size: None,
                wal_mtime_ms: None,
                shm_size: None,
                shm_mtime_ms: None
            }),
            &parsed
        ));
        assert!(is_same_signature(
            Some(&SourceSignature {
                size: 1,
                mtime_ms: 2.0,
                wal_size: Some(0),
                wal_mtime_ms: Some(0.0),
                shm_size: None,
                shm_mtime_ms: None
            }),
            &SourceSignature {
                size: 1,
                mtime_ms: 2.0,
                wal_size: None,
                wal_mtime_ms: None,
                shm_size: None,
                shm_mtime_ms: None
            }
        ));
    }
}
