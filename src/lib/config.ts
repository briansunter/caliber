import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

function defaultConfigDir(): string {
  if (process.env.CALIBER_CONFIG_DIR) return process.env.CALIBER_CONFIG_DIR;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "caliber");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "caliber");
}

const CONFIG_DIR = defaultConfigDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface ConfigFile {
  libraryPath?: unknown;
  dbName?: unknown;
  host?: unknown;
  baseUrl?: unknown;
  trustProxy?: unknown;
  mcpEnabled?: unknown;
  cookieSecure?: unknown;
  dbRefreshIntervalMs?: unknown;
}

interface ResolvedConfig {
  libraryPath: string;
  dbName: string;
  host: string;
  baseUrl: string | null;
  trustProxy: boolean;
  mcpEnabled: boolean;
  cookieSecure: boolean;
  dbRefreshIntervalMs: number;
}

const DEFAULTS: ResolvedConfig = {
  libraryPath: join(homedir(), "Calibre Library"),
  dbName: "metadata.db",
  host: "127.0.0.1",
  baseUrl: null,
  trustProxy: false,
  mcpEnabled: false,
  cookieSecure: process.env.NODE_ENV === "production",
  dbRefreshIntervalMs: 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  return readBoolean(process.env[name], fallback);
}

function sanitizeDbName(value: unknown, fallback: string): string {
  const candidate = readString(value, fallback);
  return candidate === basename(candidate) && candidate !== "." && candidate !== ".."
    ? candidate
    : fallback;
}

export class LibraryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryConfigError";
  }
}

function validateCalibreDatabase(databasePath: string): void {
  let database: Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true });
    const rows = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tables = new Set(rows.map((row) => row.name));
    const requiredTables = ["books", "authors", "data", "books_authors_link"];
    const missing = requiredTables.filter((table) => !tables.has(table));
    if (missing.length > 0) {
      throw new LibraryConfigError(
        `This file is not a supported Calibre database; missing ${missing.join(", ")}`,
      );
    }
  } catch (error) {
    if (error instanceof LibraryConfigError) throw error;
    throw new LibraryConfigError(`Could not read the Calibre database: ${databasePath}`);
  } finally {
    database?.close();
  }
}

function replaceFile(temporaryPath: string, targetPath: string): void {
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    unlinkSync(targetPath);
    renameSync(temporaryPath, targetPath);
  }
}

function parseBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function loadConfig(): ConfigFile {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {
    // A read-only config directory is valid in container deployments. Runtime
    // caches will still fail with a useful filesystem error if they are needed.
  }

  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(
        CONFIG_PATH,
        `${JSON.stringify(
          {
            libraryPath: DEFAULTS.libraryPath,
            dbName: DEFAULTS.dbName,
            host: DEFAULTS.host,
            baseUrl: DEFAULTS.baseUrl,
            trustProxy: DEFAULTS.trustProxy,
            mcpEnabled: DEFAULTS.mcpEnabled,
            cookieSecure: DEFAULTS.cookieSecure,
            dbRefreshIntervalMs: DEFAULTS.dbRefreshIntervalMs,
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
    } catch {
      // Environment variables remain sufficient for a stateless deployment.
    }
    return {};
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

const config = loadConfig();

// Environment variables override the optional config file. CALIBRE_* matches
// Calibre's spelling; CALIBER_* is accepted for app-specific settings and as a
// convenient alias for the library path.
const libraryPath =
  expandUserPath(
    process.env.CALIBRE_LIBRARY_PATH ||
      process.env.CALIBER_LIBRARY_PATH ||
      readString(config.libraryPath, DEFAULTS.libraryPath),
  );
const dbName = sanitizeDbName(
  process.env.CALIBRE_DB_NAME || config.dbName,
  DEFAULTS.dbName,
);

export let LIBRARY_PATH = libraryPath;
export let DB_NAME = dbName;
export const HOST = process.env.CALIBER_HOST || readString(config.host, DEFAULTS.host);
export const PORT = process.env.PORT || process.env.CALIBER_PORT || "3003";
export const PUBLIC_BASE_URL = parseBaseUrl(process.env.CALIBER_BASE_URL || config.baseUrl);
export const TRUST_PROXY = readEnvBoolean(
  "CALIBER_TRUST_PROXY",
  readBoolean(config.trustProxy, DEFAULTS.trustProxy),
);
export const MCP_ENABLED = readEnvBoolean(
  "CALIBER_MCP_ENABLED",
  readBoolean(config.mcpEnabled, DEFAULTS.mcpEnabled),
);
export const COOKIE_SECURE = readEnvBoolean(
  "CALIBER_COOKIE_SECURE",
  readBoolean(config.cookieSecure, DEFAULTS.cookieSecure),
);
const configuredRefreshInterval = Number(
  process.env.CALIBER_DB_REFRESH_INTERVAL_MS ?? config.dbRefreshIntervalMs,
);
export const DB_REFRESH_INTERVAL_MS = Number.isSafeInteger(configuredRefreshInterval)
  ? Math.min(60 * 60 * 1000, Math.max(5_000, configuredRefreshInterval))
  : DEFAULTS.dbRefreshIntervalMs;
export const CONFIG_DIR_PATH = CONFIG_DIR;
export const CONFIG_FILE_PATH = CONFIG_PATH;

export interface LibraryConfigStatus {
  libraryPath: string;
  dbName: string;
  databasePath: string;
  configuredDatabasePath: string;
  defaultDatabasePath: string;
  databaseExists: boolean;
  configuredDatabaseExists: boolean;
  environmentOverride: boolean;
  configFilePath: string;
}

function databasePathFor(libraryPath: string, dbName: string): string {
  return join(resolve(expandUserPath(libraryPath)), dbName);
}

export function getLibraryConfigStatus(): LibraryConfigStatus {
  const configuredLibraryPath = readString(config.libraryPath, DEFAULTS.libraryPath);
  const configuredDbName = sanitizeDbName(config.dbName, DEFAULTS.dbName);
  return {
    libraryPath: LIBRARY_PATH,
    dbName: DB_NAME,
    databasePath: databasePathFor(LIBRARY_PATH, DB_NAME),
    configuredDatabasePath: databasePathFor(configuredLibraryPath, configuredDbName),
    defaultDatabasePath: databasePathFor(DEFAULTS.libraryPath, DEFAULTS.dbName),
    databaseExists: existsSync(databasePathFor(LIBRARY_PATH, DB_NAME)),
    configuredDatabaseExists: existsSync(
      databasePathFor(configuredLibraryPath, configuredDbName),
    ),
    environmentOverride: Boolean(
      process.env.CALIBRE_LIBRARY_PATH ||
        process.env.CALIBER_LIBRARY_PATH ||
        process.env.CALIBRE_DB_NAME,
    ),
    configFilePath: CONFIG_PATH,
  };
}

/** Persist a library selection for the next server start. */
export function saveLibraryConfig(selection: {
  databasePath?: string;
  libraryPath?: string;
  dbName?: string;
}): LibraryConfigStatus {
  if (
    process.env.CALIBRE_LIBRARY_PATH ||
    process.env.CALIBER_LIBRARY_PATH ||
    process.env.CALIBRE_DB_NAME
  ) {
    throw new LibraryConfigError(
      "Library selection is controlled by CALIBRE_LIBRARY_PATH/CALIBRE_DB_NAME environment variables",
    );
  }

  const requestedDatabasePath = selection.databasePath?.trim();
  let libraryPath = expandUserPath(selection.libraryPath?.trim() || LIBRARY_PATH);
  let dbName = selection.dbName?.trim() || DB_NAME;

  if (requestedDatabasePath) {
    const candidate = resolve(expandUserPath(requestedDatabasePath));
    let candidateStat: ReturnType<typeof statSync>;
    try {
      candidateStat = statSync(candidate);
    } catch {
      throw new LibraryConfigError(`Database path does not exist: ${candidate}`);
    }

    if (candidateStat.isFile()) {
      libraryPath = dirname(candidate);
      dbName = basename(candidate);
    } else if (candidateStat.isDirectory()) {
      libraryPath = candidate;
    } else {
      throw new LibraryConfigError("Database path must be a file or directory");
    }
  }

  dbName = sanitizeDbName(dbName, "");
  if (!dbName) throw new LibraryConfigError("Database filename must be a single filename");

  libraryPath = resolve(libraryPath);
  const libraryStat = (() => {
    try {
      return statSync(libraryPath);
    } catch {
      return null;
    }
  })();
  if (!libraryStat?.isDirectory()) {
    throw new LibraryConfigError(`Library directory does not exist: ${libraryPath}`);
  }

  const databasePath = join(libraryPath, dbName);
  if (!existsSync(databasePath)) {
    throw new LibraryConfigError(`Calibre database does not exist: ${databasePath}`);
  }
  if (resolve(databasePath) === resolve(join(CONFIG_DIR, "metadata.db"))) {
    throw new LibraryConfigError("The Calibre database must be outside Caliber's cache directory");
  }
  validateCalibreDatabase(databasePath);

  mkdirSync(CONFIG_DIR, { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ ...config, libraryPath, dbName }, null, 2)}\n`,
  );
  replaceFile(temporaryPath, CONFIG_PATH);
  config.libraryPath = libraryPath;
  config.dbName = dbName;
  LIBRARY_PATH = libraryPath;
  DB_NAME = dbName;
  return getLibraryConfigStatus();
}
