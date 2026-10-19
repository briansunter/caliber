//! Integration tests for `Auth` — argon2 interop (including literal
//! Bun-produced PHC vectors), session lifecycle + epoch invalidation, login
//! throttle, Basic auth parsing/caching, and cookie rendering.

use caliber_user::{
    Auth, PasswordError, UserDb, MIN_PASSWORD_LENGTH, SESSION_COOKIE, SESSION_TTL_MS,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tempfile::TempDir;

// Generated with Bun 1.4.2: `await Bun.password.hash("password123")`.
// argon2id, m=65536 KiB, t=2, p=1 — parameters carried in the PHC string.
const BUN_HASH_PASSWORD123: &str = "$argon2id$v=19$m=65536,t=2,p=1$Gv9LQOEwBp8VkXw7EUB7e0qmV3NVLLVgYnr6KlXTs9s$BSA06Ror2NAivqhnYD3MF9RpW5W0sfoY6VoxCTNLHeI";
const BUN_HASH_VECTOR2: &str = "$argon2id$v=19$m=65536,t=2,p=1$LCrMvYPO+pYzrCHJYYkUvaj/qJ22qArnJcbpxYPu4C4$MSiBpsuD/eUj1ix3DSBTQhf92UUyIo8vv20vGPbxr3g";

fn setup() -> (TempDir, Auth) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("users.db");
    let db = UserDb::open_at(&path);
    (dir, Auth::new(Arc::new(db)))
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// Minimal standard-alphabet base64 encoder (with padding) for Basic headers.
fn b64_std(data: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.as_bytes().chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn basic_header(credentials: &str) -> String {
    format!("Basic {}", b64_std(credentials))
}

// --- password hashing -------------------------------------------------------

#[test]
fn argon2_round_trip() {
    let (_dir, auth) = setup();
    let hash = auth.hash_password("round-trip-password");
    assert!(hash.starts_with("$argon2id$v=19$m="), "PHC prefix: {hash}");
    assert!(auth.verify_password("round-trip-password", &hash));
    assert!(!auth.verify_password("wrong-password", &hash));
    // Different salts each time.
    assert_ne!(hash, auth.hash_password("round-trip-password"));
    // Malformed hashes fail closed.
    assert!(!auth.verify_password("x", "not-a-phc-hash"));
    assert!(!auth.verify_password("x", ""));
}

#[test]
fn verifies_bun_produced_phc_hashes() {
    let (_dir, auth) = setup();
    assert!(auth.verify_password("password123", BUN_HASH_PASSWORD123));
    assert!(!auth.verify_password("password124", BUN_HASH_PASSWORD123));
    assert!(auth.verify_password("caliber-test-vector", BUN_HASH_VECTOR2));
    assert!(!auth.verify_password("caliber-test-vecto", BUN_HASH_VECTOR2));
}

#[test]
fn hash_output_is_phc_argon2id() {
    let (_dir, auth) = setup();
    let hash = auth.hash_password("phc-shape-check");
    let parts: Vec<&str> = hash.split('$').collect();
    // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, digest]
    assert_eq!(parts[1], "argon2id");
    assert!(parts[3].starts_with("m="));
    assert_eq!(parts.len(), 6);
}

#[test]
fn password_length_policy() {
    let (_dir, auth) = setup();
    assert!(!auth.is_valid_password("1234567"));
    assert!(auth.is_valid_password("12345678"));
    assert!(auth.is_valid_password(&"x".repeat(512)));
    assert!(!auth.is_valid_password(&"x".repeat(513)));
    assert_eq!(MIN_PASSWORD_LENGTH, 8);
}

// --- sessions -----------------------------------------------------------------

#[test]
fn session_create_resolve_revoke() {
    let (_dir, auth) = setup();
    let user = auth
        .set_password_for_user("alice", "password-123")
        .expect("user");
    let session = auth.create_session_token(user.id);
    assert_eq!(session.token.len(), 43, "32 bytes -> 43 base64url chars");
    assert!(session
        .token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert!(session.expires_at > 0);
    // Resolves to the user; None/empty tokens resolve to nothing.
    let resolved = auth
        .resolve_session_token(Some(&session.token))
        .expect("resolves");
    assert_eq!(resolved.id, user.id);
    assert_eq!(resolved.username, "alice");
    assert!(auth.resolve_session_token(None).is_none());
    assert!(auth.resolve_session_token(Some("")).is_none());
    assert!(auth.resolve_session_token(Some("garbage-token")).is_none());
    // The DB row stores the sha256 hex of the token, never the token itself.
    let stored = auth
        .user_db()
        .get_session(&sha256_hex(&session.token))
        .expect("row");
    assert_eq!(stored.user_id, user.id);
    assert_eq!(stored.expires_at, session.expires_at);
    assert_eq!(stored.auth_epoch, 0);
    // Two tokens for the same user are independent.
    let second = auth.create_session_token(user.id);
    assert_ne!(session.token, second.token);
    // Revoke kills exactly that session.
    auth.revoke_session_token(Some(&session.token));
    assert!(auth.resolve_session_token(Some(&session.token)).is_none());
    assert!(auth.resolve_session_token(Some(&second.token)).is_some());
    auth.revoke_session_token(None); // no-op
}

#[test]
fn session_ttl_is_30_days() {
    assert_eq!(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    assert_eq!(SESSION_COOKIE, "caliber-session");
}

#[test]
fn password_rotation_invalidates_sessions() {
    let (_dir, auth) = setup();
    let user = auth
        .set_password_for_user("bob", "first-password-1")
        .expect("user");
    let session = auth.create_session_token(user.id);
    assert!(auth.resolve_session_token(Some(&session.token)).is_some());
    // Rotation bumps the epoch and deletes the sessions transactionally.
    auth.set_password_for_user("bob", "second-password-2")
        .expect("rotate");
    assert!(auth.resolve_session_token(Some(&session.token)).is_none());
    assert_eq!(auth.user_db().get_auth_epoch(user.id), Some(1));
    // Old password no longer authenticates; the new one does.
    assert!(auth
        .authenticate_with_password("local|bob", "bob", "first-password-1")
        .is_none());
    assert!(auth
        .authenticate_with_password("local|bob", "bob", "second-password-2")
        .is_some());
}

#[test]
fn stale_epoch_session_rejected_cross_process() {
    let (dir, auth) = setup();
    let user = auth
        .set_password_for_user("carol", "carol-password-1")
        .expect("user");
    let session = auth.create_session_token(user.id);
    assert!(auth.resolve_session_token(Some(&session.token)).is_some());
    // Simulate another process bumping the epoch without touching sessions.
    let conn = Connection::open(dir.path().join("users.db")).unwrap();
    conn.execute(
        "UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?",
        [user.id],
    )
    .unwrap();
    drop(conn);
    assert!(auth.resolve_session_token(Some(&session.token)).is_none());
}

#[test]
fn expired_session_rejected_and_purged() {
    let (_dir, auth) = setup();
    let user = auth
        .set_password_for_user("dave", "dave-password-1")
        .expect("user");
    let stale = now_millis_helper() - 10_000;
    auth.user_db()
        .create_session(&sha256_hex("stale-token"), user.id, stale);
    assert!(auth.resolve_session_token(Some("stale-token")).is_none());
    assert_eq!(
        auth.user_db()
            .get_session(&sha256_hex("stale-token"))
            .is_some(),
        true
    );
    auth.purge_expired_sessions();
    assert!(auth
        .user_db()
        .get_session(&sha256_hex("stale-token"))
        .is_none());
}

fn now_millis_helper() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// --- login throttle --------------------------------------------------------------

#[test]
fn ten_failures_limit_then_success_clears() {
    let (_dir, auth) = setup();
    auth.set_password_for_user("erin", "erin-password-1")
        .expect("user");
    let key = "local|erin";
    for _ in 0..9 {
        assert!(auth
            .authenticate_with_password(key, "erin", "wrong")
            .is_none());
        assert!(!auth.login_rate_limited(key), "limited only at 10");
    }
    assert!(auth
        .authenticate_with_password(key, "erin", "wrong")
        .is_none());
    assert!(auth.login_rate_limited(key), "10th failure trips the limit");
    // The limit is enforced by the caller (the TS login route checks it
    // before calling authenticateWithPassword and returns 429); the function
    // itself does not re-check, so a direct call with the correct password
    // still succeeds — and clears the failure window.
    let recovered = auth
        .authenticate_with_password(key, "erin", "erin-password-1")
        .expect("throttle is the route's job");
    assert_eq!(recovered.username, "erin");
    assert!(!auth.login_rate_limited(key), "success clears the window");
    // ...but only for that client+username key.
    assert!(!auth.login_rate_limited("local|frank"));
    // A successful login elsewhere clears its own key.
    auth.set_password_for_user("frank", "frank-password-1")
        .expect("user");
    assert!(auth
        .authenticate_with_password("local|frank", "frank", "frank-password-1")
        .is_some());
    assert!(!auth.login_rate_limited("local|frank"));
    // Unknown usernames also record failures (no user enumeration oracle).
    assert!(auth
        .authenticate_with_password("local|ghost", "ghost", "whatever-x")
        .is_none());
    assert!(
        !auth.login_rate_limited("local|ghost"),
        "single failure is not limited"
    );
}

// --- HTTP Basic --------------------------------------------------------------------

#[test]
fn parse_basic_auth_cases() {
    let parse = |h: &str| Auth::parse_basic_auth(h);
    assert_eq!(
        parse("Basic dXNlcjpwYXNz"),
        Some(("user".into(), "pass".into()))
    );
    assert_eq!(
        parse("basic dXNlcjpwYXNz"),
        Some(("user".into(), "pass".into()))
    );
    assert_eq!(
        parse("BASIC dXNlcjpwYXNz"),
        Some(("user".into(), "pass".into()))
    );
    // Leading whitespace in the payload is ignored by the lenient decoder.
    assert_eq!(
        parse("Basic  dXNlcjpwYXNz"),
        Some(("user".into(), "pass".into()))
    );
    // First colon splits; password may contain colons.
    let with_colon = basic_header("user:pa:ss");
    assert_eq!(parse(&with_colon), Some(("user".into(), "pa:ss".into())));
    // Failures.
    assert_eq!(parse("Bearer dXNlcjpwYXNz"), None, "wrong scheme");
    assert_eq!(parse("Basic"), None, "no space");
    assert_eq!(parse("Basic "), None, "empty payload");
    assert_eq!(parse(""), None, "empty header");
    assert_eq!(parse("Basic dXNlcg=="), None, "no colon");
    assert_eq!(parse("Basic Og=="), None, "empty username");
    assert_eq!(parse("Basic dXNlcjo="), None, "empty password");
}

#[test]
fn authenticate_basic_flow() {
    let (_dir, auth) = setup();
    let user = auth
        .set_password_for_user("gina", "gina-password-1")
        .expect("user");
    let good = basic_header("gina:gina-password-1");
    // The client key is the ip part only; the username part of the throttle
    // key is composed inside authenticate_basic.
    let resolved = auth.authenticate_basic("local", &good).expect("auth ok");
    assert_eq!(resolved.id, user.id);
    // Second hit goes through the 5-minute cache (keyed by the header, so a
    // different ip sees it too).
    assert!(auth.authenticate_basic("10.0.0.1", &good).is_some());
    // Wrong password fails and records a failure for "{ip}|{username}".
    let bad = basic_header("gina:nope");
    assert!(auth.authenticate_basic("10.0.0.2", &bad).is_none());
    assert!(
        !auth.login_rate_limited("10.0.0.2|gina"),
        "one failure is not limited"
    );
    // Unparseable headers never reach the credential check.
    assert!(auth
        .authenticate_basic("10.0.0.3", "Basic %%invalid%%")
        .is_none());
    // The throttle applies to the Basic path too: with a header that is not
    // yet cached, a limited client is rejected even with valid credentials.
    let good_uncached = format!("Basic  {}", b64_std("gina:gina-password-1"));
    for i in 0..10 {
        assert!(
            auth.authenticate_basic("10.0.0.4", &bad).is_none(),
            "attempt {i}"
        );
    }
    assert!(auth.login_rate_limited("10.0.0.4|gina"));
    assert!(
        auth.authenticate_basic("10.0.0.4", &good_uncached)
            .is_none(),
        "throttled"
    );
    // ...but the cache lookup precedes the throttle check (as in TS), so an
    // already-cached valid header still authenticates for a limited client.
    assert!(
        auth.authenticate_basic("10.0.0.4", &good).is_some(),
        "cached bypasses throttle"
    );
    // User without a password cannot use Basic.
    auth.user_db().get_or_create_user("profile-only");
    assert!(auth
        .authenticate_basic("local", &basic_header("profile-only:whatever1"))
        .is_none());
}

#[test]
fn basic_failures_lock_only_that_username_at_an_ip() {
    let (_dir, auth) = setup();
    auth.set_password_for_user("gina", "gina-password-1")
        .expect("user");
    auth.set_password_for_user("hank", "hank-password-1")
        .expect("user");
    // 10 failed Basic attempts for gina from one ip trip gina's bucket...
    let bad_gina = basic_header("gina:nope");
    for i in 0..10 {
        assert!(
            auth.authenticate_basic("10.9.9.9", &bad_gina).is_none(),
            "{i}"
        );
    }
    assert!(auth.login_rate_limited("10.9.9.9|gina"));
    // ...but never another username at the same ip: hank's bucket is empty
    // and his valid (uncached) credentials still work.
    assert!(!auth.login_rate_limited("10.9.9.9|hank"));
    let hank = auth
        .authenticate_basic("10.9.9.9", &basic_header("hank:hank-password-1"))
        .expect("other username unaffected");
    assert_eq!(hank.username, "hank");
    // Gina stays locked out even with valid, uncached credentials.
    let gina_uncached = format!("Basic  {}", b64_std("gina:gina-password-1"));
    assert!(
        auth.authenticate_basic("10.9.9.9", &gina_uncached)
            .is_none(),
        "locked-out username rejected"
    );
}

#[test]
fn basic_and_form_share_the_throttle_key() {
    let (_dir, auth) = setup();
    auth.set_password_for_user("gina", "gina-password-1")
        .expect("user");
    // Form-path failures (caller passes the full key, routes_user-style)...
    for _ in 0..10 {
        assert!(auth
            .authenticate_with_password("10.8.8.8|gina", "gina", "wrong-pass")
            .is_none());
    }
    assert!(auth.login_rate_limited("10.8.8.8|gina"));
    // ...are seen by the Basic path at the same ip: valid, uncached
    // credentials are rejected before any argon2 work.
    let good_uncached = format!("Basic  {}", b64_std("gina:gina-password-1"));
    assert!(
        auth.authenticate_basic("10.8.8.8", &good_uncached)
            .is_none(),
        "form failures throttle Basic"
    );
    // Normalization matches TS clientKey (trim + lowercase): an uppercase
    // Basic username lands in the same bucket as the form's "gina", so it is
    // rejected too — while a different username at the ip is not.
    let upper = format!("Basic  {}", b64_std("GINA:gina-password-1"));
    assert!(
        auth.authenticate_basic("10.8.8.8", &upper).is_none(),
        "uppercase shares the lowercase bucket"
    );
    auth.set_password_for_user("hank", "hank-password-1")
        .expect("user");
    assert!(auth
        .authenticate_basic("10.8.8.8", &basic_header("hank:hank-password-1"))
        .is_some());
    // The reverse direction: Basic failures surface on the form-path key.
    for _ in 0..10 {
        assert!(auth
            .authenticate_basic("10.7.7.7", &basic_header("hank:nope"))
            .is_none());
    }
    assert!(auth.login_rate_limited("10.7.7.7|hank"));
}

#[test]
fn basic_cache_epoch_recheck_after_rotation() {
    let (_dir, auth) = setup();
    let user = auth
        .set_password_for_user("hank", "hank-password-1")
        .expect("user");
    let header = basic_header("hank:hank-password-1");
    assert!(
        auth.authenticate_basic("local", &header).is_some(),
        "primes the cache"
    );
    // Rotation invalidates the cached entry via the DB epoch check.
    auth.set_password_for_user("hank", "hank-password-2")
        .expect("rotate");
    assert!(auth.authenticate_basic("10.0.0.2", &header).is_none());
    // The new credential works and re-primes the cache.
    let fresh = basic_header("hank:hank-password-2");
    let resolved = auth
        .authenticate_basic("10.0.0.3", &fresh)
        .expect("new creds");
    assert_eq!(resolved.id, user.id);
    assert!(auth.authenticate_basic("10.0.0.4", &fresh).is_some());
}

// --- cookies -------------------------------------------------------------------------

#[test]
fn session_cookie_header_format() {
    let (_dir, auth) = setup();
    assert_eq!(
        auth.session_cookie_header(Some("abc123")),
        "caliber-session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
    );
    assert_eq!(
        auth.session_cookie_header(None),
        "caliber-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    );
    // Secure flag comes from config.cookie_secure at construction time.
    let dir = tempfile::tempdir().unwrap();
    let db = UserDb::open_at(&dir.path().join("users.db"));
    let secure = Auth::with_cookie_secure(Arc::new(db), true);
    assert_eq!(
        secure.session_cookie_header(Some("abc123")),
        "caliber-session=abc123; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000"
    );
    assert_eq!(
        secure.session_cookie_header(None),
        "caliber-session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"
    );
}

// --- administration -------------------------------------------------------------------

#[test]
fn needs_initial_setup_tracks_password_accounts() {
    let (_dir, auth) = setup();
    assert!(auth.needs_initial_setup(true), "auth on + no accounts");
    assert!(
        !auth.needs_initial_setup(false),
        "auth off never needs setup"
    );
    auth.user_db().get_or_create_user("profile-only");
    assert!(
        auth.needs_initial_setup(true),
        "password-less profiles do not count"
    );
    auth.set_password_for_user("admin", "admin-password-1")
        .expect("create");
    assert!(!auth.needs_initial_setup(true));
}

#[test]
fn set_password_for_user_create_and_rotate() {
    let (_dir, auth) = setup();
    // Short passwords are rejected with the exact TS message.
    let err = auth.set_password_for_user("ivy", "short").unwrap_err();
    assert_eq!(
        err,
        PasswordError("Password must be at least 8 characters".to_string())
    );
    assert_eq!(err.to_string(), "Password must be at least 8 characters");
    let err = auth
        .set_password_for_user("ivy", &"x".repeat(513))
        .unwrap_err();
    assert_eq!(err.0, "Password must be at least 8 characters");
    // Create.
    let created = auth
        .set_password_for_user("ivy", "ivy-password-1")
        .expect("create");
    assert_eq!(created.username, "ivy");
    assert!(auth
        .user_db()
        .get_credential_by_username("ivy")
        .unwrap()
        .password_hash
        .is_some());
    // Rotate.
    let rotated = auth
        .set_password_for_user("ivy", "ivy-password-2")
        .expect("rotate");
    assert_eq!(rotated.id, created.id);
    assert_eq!(auth.user_db().get_auth_epoch(created.id), Some(1));
    assert!(auth
        .authenticate_with_password("local|ivy", "ivy", "ivy-password-2")
        .is_some());
    // Whitespace-normalized usernames hit the same account.
    let again = auth
        .set_password_for_user("  IVY ", "ivy-password-3")
        .expect("rotate via normalize");
    assert_eq!(again.id, created.id);
}

#[test]
fn user_db_accessor_shares_the_database() {
    let (_dir, auth) = setup();
    let created = auth.user_db().get_or_create_user("shared").expect("user");
    let found = auth.user_db().get_user_by_id(created.id).expect("same db");
    assert_eq!(found.username, "shared");
}
