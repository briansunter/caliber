//! User, auth-management, config, reading-shelf, and progress routes —
//! ported handler-for-handler from src/index.ts.

use crate::backend::{PasswordError, ProgressInput, User, MIN_PASSWORD_LENGTH, SESSION_COOKIE};
use crate::cache::{error_json, json_response};
use crate::guards::{auth_client_key, current_user, LOCAL_SETUP_HOSTS};
use crate::helpers::{cookie_value, js_encode_uri_component, parse_bounded_int, parse_query_pairs};
use crate::state::SharedState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Uri};
use axum::response::Response;
use caliber_common::config::LibrarySelection;
use serde_json::{json, Value};

const USER_COOKIE: &str = "caliber-user";
const USER_COOKIE_MAX_AGE: i64 = 60 * 60 * 24 * 365;
const FORMAT_PATTERN_MAX: usize = 10;

fn is_upper_format(format: &str) -> bool {
    !format.is_empty()
        && format.len() <= FORMAT_PATTERN_MAX
        && format
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn public_user(user: &User) -> Value {
    json!({ "id": user.id, "username": user.username })
}

fn user_cookie_header(state: &SharedState, username: Option<&str>) -> String {
    let base = format!("{USER_COOKIE}=");
    let secure = if state.config.resolved().cookie_secure {
        "; Secure"
    } else {
        ""
    };
    let attrs = format!("Path=/; HttpOnly; SameSite=Lax{secure}");
    match username {
        None => format!("{base}; {attrs}; Max-Age=0"),
        Some(name) => format!(
            "{base}{}; {attrs}; Max-Age={USER_COOKIE_MAX_AGE}",
            js_encode_uri_component(name)
        ),
    }
}

/// JSON body parse with the TS `{"error":"Invalid JSON"}` 400 shape.
fn parse_json_object(body: bytes::Bytes) -> Result<Value, Response> {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return Err(error_json(400, "Invalid JSON")),
    };
    if !parsed.is_object() {
        return Err(error_json(400, "Request body must be an object"));
    }
    Ok(parsed)
}

async fn read_body(request: axum::body::Body) -> bytes::Bytes {
    match http_body_util::BodyExt::collect(request).await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => bytes::Bytes::new(),
    }
}

/// Full login-throttle key `{ip}|{username-lowercase}` (TS `clientKey`).
/// See PARITY.md: this exact string is passed to `login_rate_limited` and
/// `authenticate_with_password`; `authenticate_basic` receives the ip part
/// only (it parses the username itself).
fn throttle_key(state: &SharedState, headers: &HeaderMap, username: &str) -> String {
    let ip = auth_client_key(state, headers);
    format!("{ip}|{}", username.trim().to_lowercase())
}

// ---------------------------------------------------------------------------
// Config: library
// ---------------------------------------------------------------------------

pub async fn config_library_get(State(state): State<SharedState>) -> Response {
    let snapshot = {
        let db = state.db.clone();
        match tokio::task::spawn_blocking(move || db.snapshot_status()).await {
            Ok(s) => s,
            Err(_) => {
                return error_json(500, "Failed to get library config");
            }
        }
    };
    let status = state.config.library_config_status();
    let mut body = match serde_json::to_value(&status) {
        Ok(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    body.insert(
        "libraryId".into(),
        json!(state.config.canonical_library_id()),
    );
    body.insert("ready".into(), json!(state.is_ready()));
    body.insert("stale".into(), json!(snapshot.stale));
    body.insert("refreshing".into(), json!(snapshot.refreshing));
    body.insert("failed".into(), json!(snapshot.failed));
    body.insert("generation".into(), json!(snapshot.generation));
    body.insert("revision".into(), json!(snapshot.revision));
    json_response(
        200,
        &Value::Object(body),
        &[("cache-control", "no-store".into())],
    )
}

pub async fn config_library_put(
    State(state): State<SharedState>,
    request: axum::body::Body,
) -> Response {
    if !LOCAL_SETUP_HOSTS.contains(&state.config.resolved().host.to_lowercase().as_str()) {
        return json_response(
            403,
            &json!({
                "error":
                    "Library selection is available only when Caliber is bound to loopback; configure CALIBRE_LIBRARY_PATH instead"
            }),
            &[("cache-control", "no-store".into())],
        );
    }
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let get_str = |key: &str| -> Option<String> {
        body.get(key).and_then(|v| v.as_str()).map(str::to_string)
    };
    let selection = LibrarySelection {
        database_path: get_str("databasePath"),
        library_path: get_str("libraryPath"),
        db_name: get_str("dbName"),
    };

    let db = state.db.clone();
    let status =
        tokio::task::spawn_blocking(move || db.save_library_config_with_validation(selection))
            .await;
    let status = match status {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => {
            return json_response(400, &json!({ "error": err.to_string() }), &[]);
        }
        Err(_) => return error_json(500, "Could not change the Calibre library"),
    };
    let db = state.db.clone();
    match tokio::task::spawn_blocking(move || db.reconfigure_library()).await {
        Ok(Ok(())) => {}
        _ => return error_json(500, "Could not change the Calibre library"),
    }
    state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    state.cache.clear();
    let mut body = match serde_json::to_value(&status) {
        Ok(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    body.insert("ready".into(), json!(true));
    body.insert("applied".into(), json!(true));
    json_response(
        200,
        &Value::Object(body),
        &[("cache-control", "no-store".into())],
    )
}

// ---------------------------------------------------------------------------
// Config: auth + account management
// ---------------------------------------------------------------------------

fn allow_all_users_as_admins() -> bool {
    std::env::var("CALIBER_ADMIN_RESTRICTED").ok().as_deref() != Some("1")
}

fn host_is_loopback(state: &SharedState) -> bool {
    LOCAL_SETUP_HOSTS.contains(&state.config.resolved().host.to_lowercase().as_str())
}

/// TS `canManageAuth`.
pub async fn can_manage_auth(state: &SharedState, headers: &HeaderMap) -> bool {
    if !state.config.auth_enabled() {
        if !host_is_loopback(state) {
            return false;
        }
        return std::env::var("CALIBER_ALLOW_NOAUTH_ADMIN").ok().as_deref() == Some("1");
    }
    if host_is_loopback(state) {
        return true;
    }
    if !allow_all_users_as_admins() {
        return false;
    }
    current_user(state, headers).await.is_some()
}

const AUTH_MANAGE_403: &str =
    "Authentication settings are available only when Caliber runs on loopback or while signed in";
const ACCOUNT_MANAGE_403: &str =
    "Account management is available only on loopback or while signed in";

pub async fn config_auth_get(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let can_manage = can_manage_auth(&state, &headers).await;
    let users = state.users.clone();
    let (auth_enabled, auth_env_controlled) = {
        let resolved = state.config.resolved();
        (resolved.auth_enabled, resolved.auth_env_controlled)
    };
    let (count, list) = tokio::task::spawn_blocking(move || {
        (users.count_users_with_password(), users.list_auth_users())
    })
    .await
    .unwrap_or((0, Vec::new()));
    let mut body = serde_json::Map::new();
    body.insert("authEnabled".into(), json!(auth_enabled));
    body.insert("hasAccounts".into(), json!(count > 0));
    body.insert("canManage".into(), json!(can_manage));
    body.insert("envControlled".into(), json!(auth_env_controlled));
    if can_manage {
        body.insert(
            "users".into(),
            Value::Array(
                list.iter()
                    .map(|u| {
                        json!({
                            "id": u.id,
                            "username": u.username,
                            "hasPassword": u.has_password,
                        })
                    })
                    .collect(),
            ),
        );
    }
    json_response(
        200,
        &Value::Object(body),
        &[("cache-control", "no-store".into())],
    )
}

pub async fn config_auth_put(
    State(state): State<SharedState>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    if !can_manage_auth(&state, &headers).await {
        return json_response(
            403,
            &json!({ "error": AUTH_MANAGE_403 }),
            &[("cache-control", "no-store".into())],
        );
    }
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) else {
        return error_json(400, "enabled must be a boolean");
    };
    let auth_enabled = state.config.auth_enabled();
    if enabled == auth_enabled {
        return json_response(
            200,
            &json!({ "authEnabled": auth_enabled, "changed": false }),
            &[("cache-control", "no-store".into())],
        );
    }

    let users = state.users.clone();
    let needs_account = enabled
        && tokio::task::spawn_blocking(move || users.count_users_with_password())
            .await
            .unwrap_or(0)
            == 0;
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if needs_account {
        let users = state.users.clone();
        let name = username.clone();
        let valid_username = tokio::task::spawn_blocking(move || users.is_valid_username(&name))
            .await
            .unwrap_or(false);
        if !valid_username {
            return error_json(400, "Invalid username");
        }
        let users = state.users.clone();
        let pass = password.clone();
        let valid_password = tokio::task::spawn_blocking(move || users.is_valid_password(&pass))
            .await
            .unwrap_or(false);
        if !valid_password {
            return error_json(
                400,
                &format!("Password must be at least {MIN_PASSWORD_LENGTH} characters"),
            );
        }
    }

    // Prepare-then-commit: the credential is created BEFORE the toggle is
    // persisted so a failure can never leave auth enabled with no account.
    let mut prepared_user: Option<User> = None;
    if needs_account {
        let users = state.users.clone();
        let name = username.clone();
        let pass = password.clone();
        let result =
            tokio::task::spawn_blocking(move || users.set_password_for_user(&name, &pass)).await;
        match result {
            Ok(Ok(user)) => prepared_user = Some(user),
            Ok(Err(PasswordError(msg))) => return error_json(400, &msg),
            Err(_) => return error_json(500, "Could not update authentication settings"),
        }
    }

    if let Err(err) = state.config.set_auth_enabled(enabled) {
        return json_response(
            400,
            &json!({ "error": err.to_string() }),
            &[("cache-control", "no-store".into())],
        );
    }

    if let Some(user) = prepared_user {
        let users = state.users.clone();
        let user_id = user.id;
        let session = tokio::task::spawn_blocking(move || {
            users.purge_expired_sessions();
            users.create_session_token(user_id)
        })
        .await
        .ok();
        let Some(session) = session else {
            return error_json(500, "Could not update authentication settings");
        };
        let cookie = {
            let users = state.users.clone();
            let token = session.token;
            tokio::task::spawn_blocking(move || users.session_cookie_header(Some(&token)))
                .await
                .unwrap_or_default()
        };
        return json_response(
            200,
            &json!({
                "authEnabled": true,
                "changed": true,
                "user": public_user(&user),
            }),
            &[
                ("set-cookie", cookie),
                ("cache-control", "private, no-store".into()),
            ],
        );
    }

    json_response(
        200,
        &json!({ "authEnabled": state.config.auth_enabled(), "changed": true }),
        &[("cache-control", "no-store".into())],
    )
}

pub async fn auth_users_post(
    State(state): State<SharedState>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    if !can_manage_auth(&state, &headers).await {
        return json_response(
            403,
            &json!({ "error": ACCOUNT_MANAGE_403 }),
            &[("cache-control", "no-store".into())],
        );
    }
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    {
        let users = state.users.clone();
        let name = username.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_username(&name))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(400, "Invalid username");
        }
    }
    {
        let users = state.users.clone();
        let pass = password.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_password(&pass))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(
                400,
                &format!("Password must be at least {MIN_PASSWORD_LENGTH} characters"),
            );
        }
    }
    let users = state.users.clone();
    let existing = {
        let name = username.clone();
        tokio::task::spawn_blocking(move || users.get_credential_by_username(&name))
            .await
            .ok()
            .flatten()
    };
    if let Some(existing) = existing {
        if existing
            .password_hash
            .as_deref()
            .map(|h| !h.is_empty())
            .unwrap_or(false)
        {
            return error_json(
                409,
                &format!("{} already has a password", existing.username),
            );
        }
    }
    let users = state.users.clone();
    let result =
        tokio::task::spawn_blocking(move || users.set_password_for_user(&username, &password))
            .await;
    match result {
        Ok(Ok(user)) => json_response(
            200,
            &json!({ "user": public_user(&user) }),
            &[("cache-control", "no-store".into())],
        ),
        Ok(Err(PasswordError(msg))) => error_json(400, &msg),
        Err(_) => error_json(500, "Could not create user"),
    }
}

pub async fn auth_user_delete(
    State(state): State<SharedState>,
    Path(username): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !can_manage_auth(&state, &headers).await {
        return json_response(
            403,
            &json!({ "error": ACCOUNT_MANAGE_403 }),
            &[("cache-control", "no-store".into())],
        );
    }
    let users = state.users.clone();
    let target = {
        let name = username.clone();
        tokio::task::spawn_blocking(move || users.get_credential_by_username(&name))
            .await
            .ok()
            .flatten()
    };
    let Some(target) = target else {
        return error_json(404, "User not found");
    };
    let users = state.users.clone();
    let count = tokio::task::spawn_blocking(move || users.count_users_with_password())
        .await
        .unwrap_or(0);
    if target
        .password_hash
        .as_deref()
        .map(|h| !h.is_empty())
        .unwrap_or(false)
        && count <= 1
    {
        return json_response(
            409,
            &json!({ "error": "Cannot delete the last user with a password" }),
            &[("cache-control", "no-store".into())],
        );
    }
    let users = state.users.clone();
    let removed = {
        let name = username.clone();
        tokio::task::spawn_blocking(move || users.delete_user(&name))
            .await
            .ok()
            .flatten()
    };
    match removed {
        Some(user) => json_response(
            200,
            &json!({ "removed": user.username }),
            &[("cache-control", "no-store".into())],
        ),
        None => error_json(404, "User not found"),
    }
}

pub async fn auth_user_password(
    State(state): State<SharedState>,
    Path(username): Path<String>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    if !can_manage_auth(&state, &headers).await {
        return json_response(
            403,
            &json!({ "error": ACCOUNT_MANAGE_403 }),
            &[("cache-control", "no-store".into())],
        );
    }
    let users = state.users.clone();
    let target = {
        let name = username.clone();
        tokio::task::spawn_blocking(move || users.get_user_by_username(&name))
            .await
            .ok()
            .flatten()
    };
    let Some(target) = target else {
        return error_json(404, "User not found");
    };
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    {
        let users = state.users.clone();
        let pass = password.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_password(&pass))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(
                400,
                &format!("Password must be at least {MIN_PASSWORD_LENGTH} characters"),
            );
        }
    }
    let users = state.users.clone();
    let result = tokio::task::spawn_blocking(move || {
        users.set_password_for_user(&target.username, &password)
    })
    .await;
    match result {
        Ok(Ok(user)) => json_response(
            200,
            &json!({ "user": public_user(&user) }),
            &[("cache-control", "no-store".into())],
        ),
        Ok(Err(PasswordError(msg))) => error_json(400, &msg),
        Err(_) => error_json(500, "Could not update user"),
    }
}

// ---------------------------------------------------------------------------
// Session / profile routes
// ---------------------------------------------------------------------------

pub async fn user_me(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let user = current_user(&state, &headers).await;
    let auth_enabled = state.config.auth_enabled();
    let needs_setup = {
        let users = state.users.clone();
        tokio::task::spawn_blocking(move || users.needs_initial_setup(auth_enabled))
            .await
            .unwrap_or(false)
    };
    json_response(
        200,
        &json!({
            "user": user.as_ref().map(public_user).unwrap_or(Value::Null),
            "authRequired": auth_enabled,
            "needsSetup": needs_setup,
        }),
        &[("cache-control", "private, no-store".into())],
    )
}

pub async fn user_login(
    State(state): State<SharedState>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    {
        let users = state.users.clone();
        let name = username.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_username(&name))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(400, "Invalid username");
        }
    }

    if state.config.auth_enabled() {
        let password = body
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let key = throttle_key(&state, &headers, &username);
        {
            let users = state.users.clone();
            let key = key.clone();
            let limited = tokio::task::spawn_blocking(move || users.login_rate_limited(&key))
                .await
                .unwrap_or(false);
            if limited {
                return json_response(
                    429,
                    &json!({ "error": "Too many failed attempts; try again later" }),
                    &[("cache-control", "no-store".into())],
                );
            }
        }
        let user = {
            let users = state.users.clone();
            let key = key.clone();
            let name = username.clone();
            let pass = password.clone();
            tokio::task::spawn_blocking(move || {
                users.authenticate_with_password(&key, &name, &pass)
            })
            .await
            .ok()
            .flatten()
        };
        let Some(user) = user else {
            return json_response(
                401,
                &json!({ "error": "Invalid username or password" }),
                &[("cache-control", "no-store".into())],
            );
        };
        let session = {
            let users = state.users.clone();
            let id = user.id;
            tokio::task::spawn_blocking(move || {
                users.purge_expired_sessions();
                users.create_session_token(id)
            })
            .await
            .ok()
        };
        let Some(session) = session else {
            return error_json(500, "Could not create session");
        };
        let cookie = {
            let users = state.users.clone();
            let token = session.token;
            tokio::task::spawn_blocking(move || users.session_cookie_header(Some(&token)))
                .await
                .unwrap_or_default()
        };
        return json_response(
            200,
            &json!({ "user": public_user(&user) }),
            &[
                ("set-cookie", cookie),
                ("cache-control", "private, no-store".into()),
            ],
        );
    }

    let user = {
        let users = state.users.clone();
        let name = username.clone();
        tokio::task::spawn_blocking(move || users.get_or_create_user(&name))
            .await
            .ok()
            .flatten()
    };
    let Some(user) = user else {
        return error_json(500, "Could not create user");
    };
    let cookie = user_cookie_header(&state, Some(&user.username));
    json_response(
        200,
        &json!({ "user": public_user(&user) }),
        &[
            ("set-cookie", cookie),
            ("cache-control", "private, no-store".into()),
        ],
    )
}

pub async fn auth_setup(
    State(state): State<SharedState>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    // Serialize bootstrap; recheck inside the mutex.
    let _guard = state.setup_mutex.lock().await;
    if !state.config.auth_enabled() {
        return json_response(
            403,
            &json!({ "error": "Authentication is disabled" }),
            &[("cache-control", "no-store".into())],
        );
    }
    let needs_setup = |users: &std::sync::Arc<dyn crate::backend::UserBackend + Send + Sync>| {
        users.needs_initial_setup(true)
    };
    if !needs_setup(&state.users) {
        return json_response(
            403,
            &json!({
                "error":
                    "Setup is already complete; ask an existing user or use the CLI to add accounts"
            }),
            &[("cache-control", "no-store".into())],
        );
    }
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    {
        let users = state.users.clone();
        let name = username.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_username(&name))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(400, "Invalid username");
        }
    }
    {
        let users = state.users.clone();
        let pass = password.clone();
        let valid = tokio::task::spawn_blocking(move || users.is_valid_password(&pass))
            .await
            .unwrap_or(false);
        if !valid {
            return error_json(
                400,
                &format!("Password must be at least {MIN_PASSWORD_LENGTH} characters"),
            );
        }
    }
    {
        let key = throttle_key(&state, &headers, &username);
        let users = state.users.clone();
        let limited = tokio::task::spawn_blocking(move || users.login_rate_limited(&key))
            .await
            .unwrap_or(false);
        if limited {
            return json_response(
                429,
                &json!({ "error": "Too many failed attempts; try again later" }),
                &[("cache-control", "no-store".into())],
            );
        }
    }
    // Recheck after validation: another request may have completed setup.
    if !needs_setup(&state.users) {
        return json_response(
            403,
            &json!({
                "error":
                    "Setup is already complete; ask an existing user or use the CLI to add accounts"
            }),
            &[("cache-control", "no-store".into())],
        );
    }
    let result = {
        let users = state.users.clone();
        let name = username.clone();
        let pass = password.clone();
        tokio::task::spawn_blocking(move || users.set_password_for_user(&name, &pass)).await
    };
    let user = match result {
        Ok(Ok(user)) => user,
        Ok(Err(PasswordError(msg))) => return error_json(400, &msg),
        Err(_) => return error_json(500, "Could not create user"),
    };
    let session = {
        let users = state.users.clone();
        let id = user.id;
        tokio::task::spawn_blocking(move || users.create_session_token(id))
            .await
            .ok()
    };
    let Some(session) = session else {
        return error_json(500, "Could not create session");
    };
    let cookie = {
        let users = state.users.clone();
        let token = session.token;
        tokio::task::spawn_blocking(move || users.session_cookie_header(Some(&token)))
            .await
            .unwrap_or_default()
    };
    json_response(
        200,
        &json!({ "user": public_user(&user) }),
        &[
            ("set-cookie", cookie),
            ("cache-control", "private, no-store".into()),
        ],
    )
}

pub async fn user_logout(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let mut cookies: Vec<String> = Vec::new();
    if state.config.auth_enabled() {
        let token = cookie_value(
            headers.get(header::COOKIE).and_then(|v| v.to_str().ok()),
            SESSION_COOKIE,
        );
        {
            let users = state.users.clone();
            let _ =
                tokio::task::spawn_blocking(move || users.revoke_session_token(token.as_deref()))
                    .await;
        }
        cookies.push({
            let users = state.users.clone();
            tokio::task::spawn_blocking(move || users.session_cookie_header(None))
                .await
                .unwrap_or_default()
        });
    }
    cookies.push(user_cookie_header(&state, None));
    let mut response = json_response(
        200,
        &json!({ "ok": true }),
        &[("cache-control", "no-store".into())],
    );
    {
        let headers_mut = response.headers_mut();
        for cookie in cookies {
            if let Ok(value) = cookie.parse() {
                headers_mut.append(header::SET_COOKIE, value);
            }
        }
    }
    response
}

// ---------------------------------------------------------------------------
// Reading shelf + per-book progress
// ---------------------------------------------------------------------------

fn library_id(state: &SharedState) -> String {
    state.config.canonical_library_id()
}

pub async fn reading_get(
    State(state): State<SharedState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(user) = current_user(&state, &headers).await else {
        return json_response(200, &json!({ "items": [] }), &[]);
    };
    let pairs = parse_query_pairs(uri.query());
    let limit = parse_bounded_int(
        pairs
            .iter()
            .find(|(k, _)| k == "limit")
            .map(|(_, v)| v.as_str()),
        200,
        1,
        500,
    ) as u32;
    let lib = library_id(&state);
    let users = state.users.clone();
    let rows = {
        let lib = lib.clone();
        tokio::task::spawn_blocking(move || users.list_progress(user.id, &lib, limit))
            .await
            .unwrap_or_default()
    };
    // Collapse per-format rows: finished > furthest > recent.
    let mut best_by_book: Vec<crate::backend::ProgressRow> = Vec::new();
    for row in rows {
        match best_by_book.iter_mut().find(|r| r.book_id == row.book_id) {
            Some(prev) => {
                let replace = (row.finished as i8) > (prev.finished as i8)
                    || ((row.finished == prev.finished)
                        && (row.furthest_percentage > prev.furthest_percentage
                            || (row.furthest_percentage == prev.furthest_percentage
                                && row.updated_at > prev.updated_at)));
                if replace {
                    *prev = row;
                }
            }
            None => best_by_book.push(row),
        }
    }
    let db = state.db.clone();
    let ids: Vec<i64> = best_by_book.iter().map(|r| r.book_id).collect();
    let books = tokio::task::spawn_blocking(move || db.get_books_by_ids(&ids))
        .await
        .unwrap_or_default();
    let items: Vec<Value> = best_by_book
        .iter()
        .filter_map(|row| {
            let book = books.get(&row.book_id)?;
            Some(json!({
                "book": {
                    "id": book.id,
                    "title": book.title,
                    "authors": book.authors,
                    "series": book.series,
                    "series_index": book.series_index,
                    "formats": book.formats,
                    "has_cover": book.has_cover,
                },
                "progress": {
                    "format": row.format,
                    "percentage": row.percentage,
                    "finished": row.finished,
                    "updatedAt": row.updated_at,
                },
            }))
        })
        .collect();
    json_response(200, &json!({ "items": items }), &[])
}

pub async fn reading_delete(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(user) = current_user(&state, &headers).await else {
        return error_json(401, "Not signed in");
    };
    let lib = library_id(&state);
    let users = state.users.clone();
    let (removed, deletion) = {
        let lib = lib.clone();
        tokio::task::spawn_blocking(move || {
            let removed = users.clear_progress(user.id, &lib);
            let deletion = users.library_deletion(user.id, &lib);
            (removed, deletion)
        })
        .await
        .unwrap_or((0, Default::default()))
    };
    json_response(
        200,
        &json!({ "removed": removed, "deletionSeq": deletion.seq }),
        &[("cache-control", "private, no-store".into())],
    )
}

/// `?format=` optional; invalid → `None` marker distinct from absent.
fn parse_format_query(pairs: &[(String, String)]) -> Result<Option<String>, ()> {
    match pairs.iter().find(|(k, _)| k == "format") {
        None => Ok(None),
        Some((_, value)) => {
            let format = value.trim().to_ascii_uppercase();
            if is_upper_format(&format) {
                Ok(Some(format))
            } else {
                Err(())
            }
        }
    }
}

pub async fn progress_get(
    State(state): State<SharedState>,
    Path(book_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(book_id) = crate::routes_books::parse_book_id(&book_id) else {
        return error_json(400, "Invalid book id");
    };
    let Some(user) = current_user(&state, &headers).await else {
        return json_response(
            200,
            &json!({ "progress": Value::Null }),
            &[("cache-control", "private, no-store".into())],
        );
    };
    let pairs = parse_query_pairs(uri.query());
    let format = match parse_format_query(&pairs) {
        Ok(format) => format,
        Err(()) => return error_json(400, "Invalid format"),
    };
    let lib = library_id(&state);
    let users = state.users.clone();
    let (progress, formats, deletion) = {
        let lib = lib.clone();
        let fmt = format.clone();
        tokio::task::spawn_blocking(move || {
            let progress = users.get_progress(user.id, &lib, book_id, fmt.as_deref());
            let formats = users.list_progress_formats(user.id, &lib, book_id);
            let deletion = users.progress_deletion(user.id, &lib, book_id, fmt.as_deref());
            (progress, formats, deletion)
        })
        .await
        .unwrap_or((None, Vec::new(), Default::default()))
    };
    let server_seq = progress.as_ref().map(|p| p.server_seq);
    json_response(
        200,
        &json!({
            "progress": progress,
            "formats": formats,
            "serverSeq": server_seq,
            "deletionSeq": deletion.seq,
        }),
        &[("cache-control", "private, no-store".into())],
    )
}

async fn handle_progress_write(
    state: &SharedState,
    _headers: &HeaderMap,
    book_id: i64,
    user: &User,
    lib: &str,
    book_formats: &[String],
    request: axum::body::Body,
) -> Response {
    let body = match parse_json_object(read_body(request).await) {
        Ok(body) => body,
        Err(response) => return response,
    };
    // S3 identity enforcement.
    let expected_user = body
        .get("expectedUserId")
        .or_else(|| body.get("userId"))
        .and_then(|v| v.as_i64());
    if let Some(expected) = expected_user {
        if expected != user.id {
            return error_json(401, "Principal mismatch");
        }
    }
    let expected_library = body
        .get("expectedLibraryId")
        .or_else(|| body.get("libraryId"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty());
    if let Some(expected) = expected_library {
        if expected != lib {
            return error_json(409, "Library mismatch");
        }
    }
    let format = body
        .get("format")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_uppercase())
        .unwrap_or_default();
    if !is_upper_format(&format) || !book_formats.iter().any(|f| f == &format) {
        return error_json(400, "Invalid book format");
    }
    let input = ProgressInput {
        format: format.clone(),
        location: body
            .get("location")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        percentage: body.get("percentage").and_then(|v| v.as_f64()),
        finished: body
            .get("finished")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        mutation_id: body
            .get("mutationId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        client_ts: body.get("clientTs").and_then(|v| v.as_i64()),
        base_revision: body.get("baseRevision").and_then(|v| v.as_i64()),
        base_deletion_seq: body.get("baseDeletionSeq").and_then(|v| v.as_i64()),
        force: body.get("force").and_then(Value::as_bool).unwrap_or(false)
            || body
                .get("forceResurrect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
    };
    let users = state.users.clone();
    let user_id = user.id;
    let (result, deletion) = {
        let lib = lib.to_string();
        let fmt = format.clone();
        tokio::task::spawn_blocking(move || {
            let result = users.upsert_progress(user_id, &lib, book_id, &input);
            let deletion = users.progress_deletion(user_id, &lib, book_id, Some(&fmt));
            (result, deletion)
        })
        .await
        .unwrap_or_else(|_| {
            (
                crate::backend::UpsertProgressResult {
                    progress: None,
                    applied: false,
                    reason: Some("internal error".into()),
                },
                Default::default(),
            )
        })
    };
    let server_seq = result.progress.as_ref().map(|p| p.server_seq);
    let mut body = serde_json::Map::new();
    body.insert(
        "progress".into(),
        serde_json::to_value(&result.progress).unwrap_or(Value::Null),
    );
    body.insert("applied".into(), json!(result.applied));
    if let Some(reason) = &result.reason {
        body.insert("reason".into(), json!(reason));
    }
    body.insert("serverSeq".into(), json!(server_seq));
    body.insert("deletionSeq".into(), json!(deletion.seq));
    json_response(
        200,
        &Value::Object(body),
        &[("cache-control", "private, no-store".into())],
    )
}

pub async fn progress_put(
    State(state): State<SharedState>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    progress_write_shared(state, book_id, headers, request).await
}

pub async fn progress_post(
    State(state): State<SharedState>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    progress_write_shared(state, book_id, headers, request).await
}

async fn progress_write_shared(
    state: SharedState,
    book_id: String,
    headers: HeaderMap,
    request: axum::body::Body,
) -> Response {
    let Some(book_id) = crate::routes_books::parse_book_id(&book_id) else {
        return error_json(400, "Invalid book id");
    };
    let Some(user) = current_user(&state, &headers).await else {
        return error_json(401, "Not signed in");
    };
    // S3: catalog context captured BEFORE the body is awaited.
    let lib = library_id(&state);
    let db = state.db.clone();
    let book = tokio::task::spawn_blocking(move || db.get_book(book_id)).await;
    match book {
        Ok(Ok(Some(book))) => {
            handle_progress_write(
                &state,
                &headers,
                book_id,
                &user,
                &lib,
                &book.formats,
                request,
            )
            .await
        }
        Ok(Ok(None)) => error_json(404, "Book not found"),
        Ok(Err(_)) | Err(_) => error_json(500, "Failed to get book"),
    }
}

pub async fn progress_delete(
    State(state): State<SharedState>,
    Path(book_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(book_id) = crate::routes_books::parse_book_id(&book_id) else {
        return error_json(400, "Invalid book id");
    };
    let Some(user) = current_user(&state, &headers).await else {
        return error_json(401, "Not signed in");
    };
    let pairs = parse_query_pairs(uri.query());
    let format = match parse_format_query(&pairs) {
        Ok(format) => format,
        Err(()) => return error_json(400, "Invalid format"),
    };
    let lib = library_id(&state);
    let users = state.users.clone();
    let (removed, deletion) = {
        let lib = lib.clone();
        let fmt = format.clone();
        tokio::task::spawn_blocking(move || {
            let removed = users.delete_progress(user.id, &lib, book_id, fmt.as_deref());
            let deletion = users.progress_deletion(user.id, &lib, book_id, fmt.as_deref());
            (removed, deletion)
        })
        .await
        .unwrap_or((false, Default::default()))
    };
    json_response(
        200,
        &json!({ "removed": removed, "deletionSeq": deletion.seq }),
        &[("cache-control", "private, no-store".into())],
    )
}
