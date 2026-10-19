//! caliber-user: user accounts, sessions, authentication, and per-user
//! reading progress backed by `users.db`.
//!
//! Rust port of `src/lib/user-db.ts` and `src/lib/auth.ts` from the
//! TypeScript implementation. The on-disk database stays compatible with
//! databases written by the TS app: identical schema and migrations, and
//! argon2id PHC password hashes that `Bun.password` can produce and verify
//! interchangeably (the PHC string carries all parameters).
//!
//! See `docs/rust/CONTRACT.md` section B for the binding API contract.

mod auth;
mod user_db;
mod util;

pub use auth::{
    Auth, PasswordError, SessionToken, MIN_PASSWORD_LENGTH, SESSION_COOKIE, SESSION_TTL_MS,
};
pub use user_db::{
    is_valid_location_for_format, is_valid_username, normalize_library_id, normalize_username,
    sanitize_location_for_format, AuthUserRow, ProgressDeletionInfo, ProgressInput, ProgressRow,
    SessionRow, UpsertProgressResult, User, UserDb, UserWithCredential, USERNAME_MAX,
};
