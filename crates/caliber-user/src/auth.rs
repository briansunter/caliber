//! Authentication: argon2id password hashing (PHC, Bun-compatible), session
//! tokens, HTTP Basic parsing with a short-lived cache, and a login failure
//! throttle. Port of `src/lib/auth.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::user_db::{User, UserDb};
use crate::util::{base64url_nopad, now_millis};

pub const SESSION_COOKIE: &str = "caliber-session";
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days
pub const MIN_PASSWORD_LENGTH: usize = 8;

const BASIC_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const BASIC_CACHE_MAX_ENTRIES: usize = 10_000;
const LOGIN_FAILURE_WINDOW_MS: i64 = 15 * 60 * 1000;
const LOGIN_FAILURE_MAX: u32 = 10;
/// Global concurrent argon2 semaphore: hashing is CPU-heavy, so cap parallel
/// verifications across both the form and Basic paths.
const MAX_CONCURRENT_HASHES: usize = 4;

/// Password policy violation from `set_password_for_user` (maps to HTTP 400
/// in the server like the TS `PasswordError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordError(pub String);

impl std::fmt::Display for PasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for PasswordError {}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionToken {
    pub token: String,
    pub expires_at: i64,
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

// --- global argon2 semaphore (max 4 concurrent verifications) ---

struct HashGate {
    max: usize,
    active: Mutex<usize>,
    cv: Condvar,
}

impl HashGate {
    fn new(max: usize) -> Self {
        HashGate {
            max,
            active: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    fn acquire(&self) -> HashGuard<'_> {
        let mut active = self
            .active
            .lock()
            .expect("caliber-user: hash gate poisoned");
        while *active >= self.max {
            active = self
                .cv
                .wait(active)
                .expect("caliber-user: hash gate poisoned");
        }
        *active += 1;
        HashGuard { gate: self }
    }
}

struct HashGuard<'a> {
    gate: &'a HashGate,
}

impl Drop for HashGuard<'_> {
    fn drop(&mut self) {
        let mut active = self
            .gate
            .active
            .lock()
            .expect("caliber-user: hash gate poisoned");
        *active = active.saturating_sub(1);
        self.gate.cv.notify_one();
    }
}

// --- login failure throttle ---

#[derive(Clone, Copy)]
struct FailureEntry {
    count: u32,
    reset_at: i64,
}

#[derive(Clone)]
struct CachedBasic {
    user_id: i64,
    auth_epoch: i64,
    expires_at: i64,
}

pub struct Auth {
    user_db: Arc<UserDb>,
    cookie_secure: bool,
    login_failures: Mutex<HashMap<String, FailureEntry>>,
    basic_cache: Mutex<HashMap<String, CachedBasic>>,
    hash_gate: HashGate,
}

impl Auth {
    /// Contract constructor; the session cookie is emitted without the
    /// `Secure` attribute. Prefer [`Auth::with_cookie_secure`] when the
    /// caller knows `config.cookie_secure`.
    pub fn new(user_db: Arc<UserDb>) -> Auth {
        Auth::with_cookie_secure(user_db, false)
    }

    /// Constructor carrying `config.cookie_secure` so session cookies get
    /// the `Secure` attribute when the deployment is behind HTTPS.
    pub fn with_cookie_secure(user_db: Arc<UserDb>, cookie_secure: bool) -> Auth {
        Auth {
            user_db,
            cookie_secure,
            login_failures: Mutex::new(HashMap::new()),
            basic_cache: Mutex::new(HashMap::new()),
            hash_gate: HashGate::new(MAX_CONCURRENT_HASHES),
        }
    }

    pub fn user_db(&self) -> &UserDb {
        &self.user_db
    }

    /// argon2id, PHC string. Bun's `Bun.password.verify` accepts these (the
    /// PHC string carries m/t/p, salt, and output).
    pub fn hash_password(&self, password: &str) -> String {
        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::default(), Params::default());
        argon2
            .hash_password(password.as_bytes(), &salt)
            .expect("caliber-user: argon2 hash failed")
            .to_string()
    }

    /// Verifies PHC hashes produced by `Bun.password.hash` (and by
    /// [`Auth::hash_password`]); any parse or verify failure is `false`.
    pub fn verify_password(&self, password: &str, hash: &str) -> bool {
        let Ok(parsed) = PasswordHash::new(hash) else {
            return false;
        };
        // The blanket PasswordVerifier honors the algorithm, version, and
        // m/t/p parameters carried in the PHC string.
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    pub fn is_valid_password(&self, password: &str) -> bool {
        let len = password.chars().count();
        (MIN_PASSWORD_LENGTH..=512).contains(&len)
    }

    /// True when auth is on but no user can log in yet.
    pub fn needs_initial_setup(&self, auth_enabled: bool) -> bool {
        auth_enabled && self.user_db.count_users_with_password() == 0
    }

    // --- session tokens ---

    /// 32 random bytes -> base64url (no padding); the DB stores the
    /// SHA-256 hex of the token string.
    pub fn create_session_token(&self, user_id: i64) -> SessionToken {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = base64url_nopad(&bytes);
        let expires_at = now_millis() + SESSION_TTL_MS;
        self.user_db
            .create_session(&sha256_hex(&token), user_id, expires_at);
        SessionToken { token, expires_at }
    }

    pub fn resolve_session_token(&self, token: Option<&str>) -> Option<User> {
        let token = token.filter(|t| !t.is_empty())?;
        let session = self.user_db.get_session(&sha256_hex(token))?;
        if session.expires_at <= now_millis() {
            return None;
        }
        // Cross-process credential-epoch check: sessions store the epoch at
        // login; a password reset bumps users.auth_epoch and deletes
        // sessions, but a concurrent process may hold a session row written
        // before the bump.
        let current_epoch = self.user_db.get_auth_epoch(session.user_id)?;
        if current_epoch != session.auth_epoch {
            return None;
        }
        self.user_db.get_user_by_id(session.user_id)
    }

    pub fn revoke_session_token(&self, token: Option<&str>) {
        if let Some(token) = token.filter(|t| !t.is_empty()) {
            self.user_db.delete_session(&sha256_hex(token));
        }
    }

    pub fn purge_expired_sessions(&self) {
        self.user_db.delete_expired_sessions();
    }

    pub fn session_cookie_header(&self, token: Option<&str>) -> String {
        let base = format!("{SESSION_COOKIE}=");
        let attrs = format!(
            "Path=/; HttpOnly; SameSite=Lax{}",
            if self.cookie_secure { "; Secure" } else { "" }
        );
        match token {
            None => format!("{base}; {attrs}; Max-Age=0"),
            Some(token) => format!("{base}{token}; {attrs}; Max-Age={}", SESSION_TTL_MS / 1000),
        }
    }

    // --- login throttle (10 failures / 15 min, keyed "{ip}|{username}") ---

    fn prune_failures(map: &mut HashMap<String, FailureEntry>, now: i64) {
        if map.len() < 10_000 {
            return;
        }
        map.retain(|_, entry| entry.reset_at > now);
    }

    pub fn login_rate_limited(&self, client_key: &str) -> bool {
        let now = now_millis();
        let mut map = self
            .login_failures
            .lock()
            .expect("caliber-user: throttle poisoned");
        Self::prune_failures(&mut map, now);
        map.get(client_key)
            .map(|entry| entry.count >= LOGIN_FAILURE_MAX && entry.reset_at > now)
            .unwrap_or(false)
    }

    fn record_login_failure(&self, client_key: &str) {
        let now = now_millis();
        let mut map = self
            .login_failures
            .lock()
            .expect("caliber-user: throttle poisoned");
        match map.get_mut(client_key) {
            Some(entry) if entry.reset_at > now => entry.count += 1,
            _ => {
                map.insert(
                    client_key.to_string(),
                    FailureEntry {
                        count: 1,
                        reset_at: now + LOGIN_FAILURE_WINDOW_MS,
                    },
                );
            }
        }
    }

    fn clear_login_failures(&self, client_key: &str) {
        self.login_failures
            .lock()
            .expect("caliber-user: throttle poisoned")
            .remove(client_key);
    }

    // --- password login ---

    fn verify_credential_password(&self, password: &str, hash: &str) -> bool {
        // Cap concurrent argon2 work like the TS semaphore.
        let _guard = self.hash_gate.acquire();
        self.verify_password(password, hash)
    }

    /// Verifies a username/password pair and updates the failure throttle.
    /// Returns the user on success, `None` on bad credentials.
    pub fn authenticate_with_password(
        &self,
        client_key: &str,
        username: &str,
        password: &str,
    ) -> Option<User> {
        let credential = self.user_db.get_credential_by_username(username);
        let password_ok = match credential.as_ref().and_then(|c| c.password_hash.as_deref()) {
            Some(hash) if !hash.is_empty() => self.verify_credential_password(password, hash),
            _ => false,
        };
        if !password_ok {
            self.record_login_failure(client_key);
            return None;
        }
        let credential = credential.expect("password verified implies credential exists");
        self.clear_login_failures(client_key);
        self.user_db.get_user_by_id(credential.id)
    }

    // --- HTTP Basic auth ---

    /// Port of the TS `parseBasicAuth`: scheme must be `Basic`
    /// (case-insensitive), payload base64-decodes leniently, and both the
    /// username and password (split at the first `:`) must be non-empty.
    pub fn parse_basic_auth(header: &str) -> Option<(String, String)> {
        let space_index = header.find(' ')?;
        let scheme = &header[..space_index];
        let encoded = &header[space_index + 1..];
        if encoded.is_empty() || scheme.to_lowercase() != "basic" {
            return None;
        }
        let decoded_bytes = crate::util::base64_decode_lenient(encoded);
        let decoded = String::from_utf8_lossy(&decoded_bytes).into_owned();
        let separator = decoded.find(':')?;
        let username = decoded[..separator].to_string();
        let password = decoded[separator + 1..].to_string();
        if username.is_empty() || password.is_empty() {
            return None;
        }
        Some((username, password))
    }

    fn cache_basic_credential(&self, header_value: &str, user_id: i64, auth_epoch: i64) {
        let mut cache = self
            .basic_cache
            .lock()
            .expect("caliber-user: basic cache poisoned");
        if cache.len() >= BASIC_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(
            sha256_hex(header_value),
            CachedBasic {
                user_id,
                auth_epoch,
                expires_at: now_millis() + BASIC_CACHE_TTL_MS,
            },
        );
    }

    fn clear_basic_cache_for_user(&self, user_id: i64) {
        self.basic_cache
            .lock()
            .expect("caliber-user: basic cache poisoned")
            .retain(|_, entry| entry.user_id != user_id);
    }

    /// Port of the TS `authenticateBasic`. `client_key` is the ip part only
    /// (see `guards::auth_client_key`); the full throttle key
    /// `"{ip}|{username.trim().to_lowercase()}"` (TS `clientKey`, same string
    /// the form path passes to `authenticate_with_password`) is composed here
    /// exactly once — callers must not pre-compose it.
    pub fn authenticate_basic(&self, client_key: &str, header: &str) -> Option<User> {
        let cache_key = sha256_hex(header);
        {
            let mut cache = self
                .basic_cache
                .lock()
                .expect("caliber-user: basic cache poisoned");
            if let Some(cached) = cache.get(&cache_key).cloned() {
                if cached.expires_at <= now_millis() {
                    cache.remove(&cache_key);
                } else {
                    // Cross-process epoch check against the DB, not just the
                    // in-memory clear performed on password reset.
                    match self.user_db.get_auth_epoch(cached.user_id) {
                        Some(epoch) if epoch == cached.auth_epoch => {
                            drop(cache);
                            return self.user_db.get_user_by_id(cached.user_id);
                        }
                        _ => {
                            cache.remove(&cache_key);
                        }
                    }
                }
            }
        }
        let (username, password) = Self::parse_basic_auth(header)?;
        // TS clientKey: "{ip}|{username.trim().toLowerCase()}" — per-username
        // bucket so failures for one account never lock out another at the
        // same ip, and Basic failures share the form path's key.
        let throttle_key = format!("{client_key}|{}", username.trim().to_lowercase());
        // Same throttle as the form path so OPDS guessing is rate-limited too.
        if self.login_rate_limited(&throttle_key) {
            return None;
        }
        let credential = self.user_db.get_credential_by_username(&username);
        let password_ok = match credential.as_ref().and_then(|c| c.password_hash.as_deref()) {
            Some(hash) if !hash.is_empty() => self.verify_credential_password(&password, hash),
            _ => false,
        };
        if !password_ok {
            self.record_login_failure(&throttle_key);
            return None;
        }
        let credential = credential.expect("password verified implies credential exists");
        self.clear_login_failures(&throttle_key);
        self.cache_basic_credential(header, credential.id, credential.auth_epoch);
        self.user_db.get_user_by_id(credential.id)
    }

    // --- user administration (setup + CLI) ---

    pub fn set_password_for_user(
        &self,
        username: &str,
        password: &str,
    ) -> Result<User, PasswordError> {
        if !self.is_valid_password(password) {
            return Err(PasswordError(format!(
                "Password must be at least {MIN_PASSWORD_LENGTH} characters"
            )));
        }
        let hash = self.hash_password(password);
        let credential = self.user_db.get_credential_by_username(username);
        let credential = match credential {
            None => {
                let created = self
                    .user_db
                    .create_user_with_password(username, &hash)
                    .ok_or_else(|| PasswordError("Could not create user".to_string()))?;
                return Ok(created);
            }
            Some(credential) => credential,
        };
        // set_user_password bumps users.auth_epoch and deletes sessions
        // transactionally (cross-process invalidation via the DB); the extra
        // delete matches the TS flow, and cached Basic entries drop too.
        self.user_db.set_user_password(credential.id, Some(&hash));
        self.user_db.delete_sessions_for_user(credential.id);
        self.clear_basic_cache_for_user(credential.id);
        self.user_db
            .get_user_by_id(credential.id)
            .ok_or_else(|| PasswordError("Could not update user".to_string()))
    }
}
