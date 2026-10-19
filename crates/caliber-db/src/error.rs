//! Typed data-layer errors. The server crate owns the HTTP mapping
//! (`InvalidCursor` → 400 `{"error":"Invalid cursor"}`; everything
//! unclassified → 500).

use std::fmt;

#[derive(Debug)]
pub enum DbError {
    /// Corrupt/unparseable cursor or a sort-type mismatch. HTTP 400.
    InvalidCursor,
    /// The snapshot is not built yet (library unset or first publish failed).
    NotReady(String),
    /// Filesystem-level failure (snapshot publish, sidecar write, ...).
    Io(String),
    /// Anything else, including SQLite query failures.
    Internal(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::InvalidCursor => write!(f, "Invalid cursor"),
            DbError::NotReady(m) => write!(f, "Library is not ready: {m}"),
            DbError::Io(m) => write!(f, "{m}"),
            DbError::Internal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        DbError::Internal(format!("database error: {error}"))
    }
}

impl From<String> for DbError {
    fn from(message: String) -> Self {
        DbError::Internal(message)
    }
}
