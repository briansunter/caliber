//! Runtime configuration: `config.json` + environment variable resolution.
//!
//! Port of `src/lib/config.ts`. The resolved [`Config`] is created once at
//! startup and shared (`Arc`) by the DB engine, server, and user-state
//! layers. `auth_enabled` and the library selection are mutable at runtime
//! (Settings UI), mirroring the TS live bindings; every mutation is
//! persisted atomically to `config.json`.
//!
//! Both `CALIBRE_LIBRARY_PATH` and `CALIBER_LIBRARY_PATH` are accepted,
//! with Calibre's spelling taking precedence, matching the TS backend.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::wyhash;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 3003;
pub const DEFAULT_DB_NAME: &str = "metadata.db";
pub const DEFAULT_REFRESH_INTERVAL_MS: u64 = 60_000;

#[derive(Debug)]
pub enum ConfigError {
    /// `LibraryConfigError`
    Library(String),
    /// `AuthConfigError`
    Auth(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Library(m) => write!(f, "{m}"),
            ConfigError::Auth(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for ConfigError {}

#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub library_path: PathBuf,
    pub db_name: String,
    pub config_dir: PathBuf,
    pub config_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub base_url: Option<String>,
    pub trust_proxy: bool,
    pub mcp_enabled: bool,
    pub cookie_secure: bool,
    pub db_refresh_interval_ms: u64,
    pub auth_enabled: bool,
    /// CALIBER_AUTH_ENABLED was set at startup: the Settings toggle is
    /// disabled and runtime mutation is rejected.
    pub auth_env_controlled: bool,
}

impl ResolvedConfig {
    pub fn database_path(&self) -> PathBuf {
        self.library_path.join(&self.db_name)
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryConfigStatus {
    pub library_id: String,
    pub library_path: String,
    pub db_name: String,
    pub database_path: String,
    pub configured_database_path: String,
    pub default_database_path: String,
    pub database_exists: bool,
    pub configured_database_exists: bool,
    pub environment_override: bool,
    pub config_file_path: String,
}

pub struct LibrarySelection {
    pub database_path: Option<String>,
    pub library_path: Option<String>,
    pub db_name: Option<String>,
}

struct ConfigInner {
    resolved: RwLock<ResolvedConfig>,
    /// Raw config.json object; mutated fields are merged back on save.
    file: RwLock<Map<String, Value>>,
}

/// Shared configuration handle.
#[derive(Clone)]
pub struct Config(Arc<ConfigInner>);

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("resolved", &self.resolved())
            .finish()
    }
}

pub fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_config_dir() -> PathBuf {
    if let Some(dir) = env::var_os("CALIBER_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        let base = env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"));
        return base.join("caliber");
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"));
    base.join("caliber")
}

pub fn default_library_path() -> PathBuf {
    home_dir().join("Calibre Library")
}

fn read_string(value: &Value, fallback: &str) -> String {
    if let Value::String(s) = value {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    fallback.to_string()
}

pub fn read_boolean_value(value: &Value, fallback: bool) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn env_boolean(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(v) => read_boolean_value(&Value::String(v), fallback),
        Err(_) => fallback,
    }
}

fn expand_user_path(value: &str) -> PathBuf {
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    if let Some(rest) = value.strip_prefix("~\\") {
        return home_dir().join(rest);
    }
    PathBuf::from(value)
}

fn sanitize_db_name(value: &str, fallback: &str) -> String {
    let candidate = if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value.trim().to_string()
    };
    let is_plain_filename = Path::new(&candidate)
        .file_name()
        .map(|f| f == candidate.as_str())
        .unwrap_or(false)
        && candidate != "."
        && candidate != "..";
    if is_plain_filename {
        candidate
    } else {
        fallback.to_string()
    }
}

/// Parse a base URL, keeping only the origin; http/https only. Mirrors
/// `parseBaseUrl` in TS.
pub fn parse_base_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = url::Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Strict `^-?\d+$` integer parse then clamp (TS `parseBoundedInt`).
pub fn parse_bounded_int(raw: &str, fallback: i64, min: i64, max: i64) -> i64 {
    if !raw.chars().all(|c| c.is_ascii_digit() || c == '-') || raw.is_empty() || raw == "-" {
        return fallback;
    }
    match raw.parse::<i64>() {
        Ok(v) if (-((1i64 << 53) - 1)..=((1i64 << 53) - 1)).contains(&v) => min.max(max.min(v)),
        _ => fallback,
    }
}

fn refresh_interval(env_raw: Option<String>, file_raw: &Value) -> u64 {
    let raw = match env_raw {
        Some(v) => v,
        None => match file_raw {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            _ => return DEFAULT_REFRESH_INTERVAL_MS,
        },
    };
    // JS Number(raw): "" -> 0, junk -> NaN.
    let parsed: f64 = if raw.trim().is_empty() {
        0.0
    } else {
        raw.trim().parse().unwrap_or(f64::NAN)
    };
    let is_safe_integer =
        parsed.is_finite() && parsed.fract() == 0.0 && parsed.abs() <= (2f64.powi(53) - 1.0);
    if !is_safe_integer {
        return DEFAULT_REFRESH_INTERVAL_MS;
    }
    (parsed as i64).clamp(5_000, 60 * 60 * 1000) as u64
}

impl Config {
    /// Load configuration from the default config directory.
    pub fn load() -> Config {
        Config::load_from(default_config_dir())
    }

    /// Load configuration from an explicit config directory (also used by
    /// tests). Creates the directory and a default config.json when
    /// possible; a read-only directory is tolerated.
    pub fn load_from(config_dir: PathBuf) -> Config {
        let _ = fs::create_dir_all(&config_dir);
        let config_path = config_dir.join("config.json");
        let mut file = Map::new();
        if !config_path.exists() {
            let default = json!({
                "libraryPath": default_library_path(),
                "dbName": DEFAULT_DB_NAME,
                "host": DEFAULT_HOST,
                "baseUrl": null,
                "trustProxy": false,
                "mcpEnabled": false,
                "cookieSecure": env::var("NODE_ENV").ok().as_deref() == Some("production"),
                "dbRefreshIntervalMs": DEFAULT_REFRESH_INTERVAL_MS,
                "authEnabled": false,
            });
            let _ = fs::write(
                &config_path,
                format!("{}\n", serde_json::to_string_pretty(&default).unwrap()),
            );
        }
        if let Ok(raw) = fs::read_to_string(&config_path) {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) {
                file = map;
            }
        }

        let get = |key: &str| file.get(key).cloned().unwrap_or(Value::Null);

        let library_path_env = env::var("CALIBRE_LIBRARY_PATH")
            .ok()
            .or_else(|| env::var("CALIBER_LIBRARY_PATH").ok());
        let library_path = match library_path_env {
            Some(v) => expand_user_path(&v),
            None => expand_user_path(&read_string(
                &get("libraryPath"),
                &default_library_path().to_string_lossy(),
            )),
        };
        let db_name = sanitize_db_name(
            &env::var("CALIBRE_DB_NAME")
                .unwrap_or_else(|_| read_string(&get("dbName"), DEFAULT_DB_NAME)),
            DEFAULT_DB_NAME,
        );
        let host = env::var("CALIBER_HOST")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_string())
            .unwrap_or_else(|| read_string(&get("host"), DEFAULT_HOST));
        let port_raw = env::var("PORT")
            .or_else(|_| env::var("CALIBER_PORT"))
            .unwrap_or_else(|_| "3003".to_string());
        let port = parse_bounded_int(&port_raw, DEFAULT_PORT as i64, 1, 65535) as u16;
        let base_url = env::var("CALIBER_BASE_URL")
            .ok()
            .and_then(|v| parse_base_url(&v))
            .or_else(|| match get("baseUrl") {
                Value::String(s) => parse_base_url(&s),
                _ => None,
            });
        let trust_proxy = env_boolean(
            "CALIBER_TRUST_PROXY",
            read_boolean_value(&get("trustProxy"), false),
        );
        let mcp_enabled = env_boolean(
            "CALIBER_MCP_ENABLED",
            read_boolean_value(&get("mcpEnabled"), false),
        );
        let cookie_secure = env_boolean(
            "CALIBER_COOKIE_SECURE",
            read_boolean_value(
                &get("cookieSecure"),
                env::var("NODE_ENV").ok().as_deref() == Some("production"),
            ),
        );
        let auth_env_controlled = env::var("CALIBER_AUTH_ENABLED").is_ok();
        let auth_enabled = env_boolean(
            "CALIBER_AUTH_ENABLED",
            read_boolean_value(&get("authEnabled"), false),
        );

        let resolved = ResolvedConfig {
            library_path,
            db_name,
            config_dir: config_dir.clone(),
            config_path: config_path.clone(),
            host,
            port,
            base_url,
            trust_proxy,
            mcp_enabled,
            cookie_secure,
            db_refresh_interval_ms: refresh_interval(
                env::var("CALIBER_DB_REFRESH_INTERVAL_MS").ok(),
                &get("dbRefreshIntervalMs"),
            ),
            auth_enabled,
            auth_env_controlled,
        };

        Config(Arc::new(ConfigInner {
            resolved: RwLock::new(resolved),
            file: RwLock::new(file),
        }))
    }

    pub fn resolved(&self) -> ResolvedConfig {
        self.0.resolved.read().unwrap().clone()
    }

    pub fn auth_enabled(&self) -> bool {
        self.0.resolved.read().unwrap().auth_enabled
    }

    pub fn library_path(&self) -> PathBuf {
        self.0.resolved.read().unwrap().library_path.clone()
    }

    pub fn database_path(&self) -> PathBuf {
        self.resolved().database_path()
    }

    /// Canonical library identity (`CALIBER_LIBRARY_ID` override or
    /// `lib-<hash>`). Reads the override live like the TS implementation.
    pub fn canonical_library_id(&self) -> String {
        wyhash::canonical_library_id(
            &self.library_path().to_string_lossy(),
            env::var("CALIBER_LIBRARY_ID").ok().as_deref(),
        )
    }

    fn persist(&self) {
        let (config_path, snapshot) = {
            let resolved = self.0.resolved.read().unwrap();
            (resolved.config_path.clone(), None::<()>)
        };
        let _ = snapshot;
        let file = self.0.file.read().unwrap().clone();
        let dir = config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        if fs::create_dir_all(&dir).is_err() {
            return; // read-only config dir: change applies, does not persist
        }
        let tmp = config_path.with_file_name(format!("config.json.tmp-{}", std::process::id()));
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(&Value::Object(file)).unwrap()
        );
        if fs::write(&tmp, body).is_err() {
            return;
        }
        if fs::rename(&tmp, &config_path).is_err() {
            let _ = fs::remove_file(&config_path);
            let _ = fs::rename(&tmp, &config_path);
        }
    }

    /// Toggle authentication at runtime (`setAuthEnabled`). Rejected when
    /// CALIBER_AUTH_ENABLED controls the setting.
    pub fn set_auth_enabled(&self, enabled: bool) -> Result<(), ConfigError> {
        {
            let resolved = self.0.resolved.read().unwrap();
            if resolved.auth_env_controlled {
                return Err(ConfigError::Auth(
                    "Authentication is controlled by the CALIBER_AUTH_ENABLED environment variable"
                        .into(),
                ));
            }
        }
        {
            let mut resolved = self.0.resolved.write().unwrap();
            resolved.auth_enabled = enabled;
        }
        self.0
            .file
            .write()
            .unwrap()
            .insert("authEnabled".into(), Value::Bool(enabled));
        self.persist();
        Ok(())
    }

    /// True when CALIBRE_LIBRARY_PATH / CALIBER_LIBRARY_PATH /
    /// CALIBRE_DB_NAME are overriding the config file.
    pub fn library_env_override(&self) -> bool {
        env::var("CALIBRE_LIBRARY_PATH").is_ok()
            || env::var("CALIBER_LIBRARY_PATH").is_ok()
            || env::var("CALIBRE_DB_NAME").is_ok()
    }

    /// Validate a requested library selection (all checks except the SQLite
    /// schema probe, which lives in caliber-db). Returns the resolved
    /// (library_path, db_name) pair.
    pub fn prepare_library_selection(
        &self,
        selection: &LibrarySelection,
    ) -> Result<(PathBuf, String), ConfigError> {
        if self.library_env_override() {
            return Err(ConfigError::Library(
                "Library selection is controlled by CALIBRE_LIBRARY_PATH/CALIBRE_DB_NAME environment variables".into(),
            ));
        }
        let resolved = self.resolved();
        let mut library_path = match &selection.library_path {
            Some(v) if !v.trim().is_empty() => expand_user_path(v.trim()),
            _ => resolved.library_path.clone(),
        };
        let mut db_name = selection
            .db_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| resolved.db_name.clone());

        if let Some(requested) = selection
            .database_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let candidate = expand_user_path(requested);
            let md = fs::metadata(&candidate).map_err(|_| {
                ConfigError::Library(format!(
                    "Database path does not exist: {}",
                    candidate.display()
                ))
            })?;
            if md.is_file() {
                library_path = candidate
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default();
                db_name = candidate
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();
            } else if md.is_dir() {
                library_path = candidate;
            } else {
                return Err(ConfigError::Library(
                    "Database path must be a file or directory".into(),
                ));
            }
        }

        let sanitized = sanitize_db_name(&db_name, "");
        if sanitized.is_empty() {
            return Err(ConfigError::Library(
                "Database filename must be a single filename".into(),
            ));
        }
        db_name = sanitized;

        let library_path = {
            let cwd_relative = if library_path.is_absolute() {
                library_path
            } else {
                env::current_dir().unwrap_or_default().join(&library_path)
            };
            std::fs::canonicalize(&cwd_relative).map_err(|_| {
                ConfigError::Library(format!(
                    "Library directory does not exist: {}",
                    cwd_relative.display()
                ))
            })?
        };
        if !library_path.is_dir() {
            return Err(ConfigError::Library(format!(
                "Library directory does not exist: {}",
                library_path.display()
            )));
        }
        let database_path = library_path.join(&db_name);
        if !database_path.exists() {
            return Err(ConfigError::Library(format!(
                "Calibre database does not exist: {}",
                database_path.display()
            )));
        }
        let snapshot_db = resolved.config_dir.join("metadata.db");
        if let (Ok(a), Ok(b)) = (
            fs::canonicalize(&database_path),
            fs::canonicalize(&snapshot_db),
        ) {
            if a == b {
                return Err(ConfigError::Library(
                    "The Calibre database must be outside Caliber's cache directory".into(),
                ));
            }
        }
        Ok((library_path, db_name))
    }

    /// Persist + apply a validated library selection
    /// (`saveLibraryConfig` tail). Callers must have run the schema
    /// validation between `prepare_library_selection` and this.
    pub fn apply_library_selection(
        &self,
        library_path: &Path,
        db_name: &str,
    ) -> LibraryConfigStatus {
        {
            let mut resolved = self.0.resolved.write().unwrap();
            resolved.library_path = library_path.to_path_buf();
            resolved.db_name = db_name.to_string();
        }
        let mut file = self.0.file.write().unwrap();
        file.insert(
            "libraryPath".into(),
            Value::String(library_path.to_string_lossy().to_string()),
        );
        file.insert("dbName".into(), Value::String(db_name.to_string()));
        drop(file);
        self.persist();
        self.library_config_status()
    }

    pub fn library_config_status(&self) -> LibraryConfigStatus {
        let resolved = self.resolved();
        let file = self.0.file.read().unwrap();
        let get = |key: &str| file.get(key).cloned().unwrap_or(Value::Null);
        let configured_library = expand_user_path(&read_string(
            &get("libraryPath"),
            &default_library_path().to_string_lossy(),
        ));
        let configured_db = sanitize_db_name(
            &read_string(&get("dbName"), DEFAULT_DB_NAME),
            DEFAULT_DB_NAME,
        );
        drop(file);

        let configured_database_path = configured_library.join(&configured_db);
        let default_database_path = default_library_path().join(DEFAULT_DB_NAME);
        let database_path = resolved.database_path();

        LibraryConfigStatus {
            library_id: self.canonical_library_id(),
            library_path: resolved.library_path.to_string_lossy().to_string(),
            db_name: resolved.db_name.clone(),
            database_path: database_path.to_string_lossy().to_string(),
            configured_database_path: configured_database_path.to_string_lossy().to_string(),
            default_database_path: default_database_path.to_string_lossy().to_string(),
            database_exists: database_path.exists(),
            configured_database_exists: configured_database_path.exists(),
            environment_override: self.library_env_override(),
            config_file_path: resolved.config_path.to_string_lossy().to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_boolean_matches_ts() {
        for (raw, expected) in [
            ("1", true),
            ("true", true),
            ("YES", true),
            (" On ", true),
            ("0", false),
            ("false", false),
            ("no", false),
            ("off", false),
            ("junk", false),
        ] {
            assert_eq!(
                read_boolean_value(&Value::String(raw.into()), false),
                expected,
                "{raw}"
            );
        }
        assert!(read_boolean_value(&Value::Bool(true), false));
        assert!(!read_boolean_value(&Value::Null, false));
        assert!(read_boolean_value(&Value::Null, true));
    }

    #[test]
    fn base_url_origin_only() {
        assert_eq!(
            parse_base_url("https://books.example.test/x/y"),
            Some("https://books.example.test".into())
        );
        assert_eq!(
            parse_base_url("http://h:8080"),
            Some("http://h:8080".into())
        );
        assert_eq!(parse_base_url("ftp://h"), None);
        assert_eq!(parse_base_url("  "), None);
        assert_eq!(parse_base_url("not a url"), None);
    }

    #[test]
    fn sanitize_db_name_rejects_paths() {
        assert_eq!(sanitize_db_name("metadata.db", "x"), "metadata.db");
        assert_eq!(sanitize_db_name("..", "fallback"), "fallback");
        assert_eq!(sanitize_db_name(".", "fallback"), "fallback");
        assert_eq!(sanitize_db_name("a/b.db", "fallback"), "fallback");
        assert_eq!(sanitize_db_name("  ", "fallback"), "fallback");
    }

    #[test]
    fn bounded_int_strict() {
        assert_eq!(parse_bounded_int("12", 5, 1, 100), 12);
        assert_eq!(parse_bounded_int("0", 5, 1, 100), 1);
        assert_eq!(parse_bounded_int("999", 5, 1, 100), 100);
        assert_eq!(parse_bounded_int("1e2", 5, 1, 100), 5);
        assert_eq!(parse_bounded_int("", 5, 1, 100), 5);
        assert_eq!(parse_bounded_int("-3", 5, 1, 100), 1);
        assert_eq!(parse_bounded_int("-9223372036854775808", 5, 1, 100), 5);
        assert_eq!(parse_bounded_int("9223372036854775807", 5, 1, 100), 5);
        assert_eq!(parse_bounded_int("9007199254740992", 5, 1, 100), 5);
        assert_eq!(parse_bounded_int("-9007199254740992", 5, 1, 100), 5);
    }

    #[test]
    fn refresh_interval_clamps() {
        assert_eq!(refresh_interval(Some("1000".into()), &Value::Null), 5_000);
        assert_eq!(refresh_interval(Some("60000".into()), &Value::Null), 60_000);
        assert_eq!(
            refresh_interval(Some("99999999".into()), &Value::Null),
            3_600_000
        );
        assert_eq!(refresh_interval(Some("junk".into()), &Value::Null), 60_000);
        assert_eq!(refresh_interval(None, &json!(30_000)), 30_000);
    }

    #[test]
    fn prepare_selection_validates_paths() {
        let dir = std::env::temp_dir().join(format!("caliber-cfg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = Config::load_from(dir.clone());
        let lib = dir.join("lib");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("metadata.db"), b"placeholder").unwrap();

        let ok = config
            .prepare_library_selection(&LibrarySelection {
                database_path: Some(lib.join("metadata.db").to_string_lossy().to_string()),
                library_path: None,
                db_name: None,
            })
            .unwrap();
        assert_eq!(ok.0, fs::canonicalize(&lib).unwrap());
        assert_eq!(ok.1, "metadata.db");

        let err = config
            .prepare_library_selection(&LibrarySelection {
                database_path: Some(dir.join("missing.db").to_string_lossy().to_string()),
                library_path: None,
                db_name: None,
            })
            .unwrap_err();
        assert!(matches!(err, ConfigError::Library(_)));
        let _ = fs::remove_dir_all(&dir);
    }
}
