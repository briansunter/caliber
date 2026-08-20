// Authentication support for Caliber (optional, off by default).
//
// Two standard mechanisms, both resolving to a users.db row:
//   - HTTP Basic Auth (RFC 7617): the mechanism OPDS clients expect; also
//     works for API consumers and MCP.
//   - Server-side session cookie: set by the web login form. The cookie holds
//     a random token; only its SHA-256 hash is stored in the database.
//
// Passwords are hashed with argon2id via Bun.password. Basic verification
// results are cached briefly because argon2 is deliberately slow.

import { AUTH_ENABLED, COOKIE_SECURE, TRUST_PROXY } from "./config";
import {
  countUsersWithPassword,
  createSession,
  createUserWithPassword,
  getCredentialByUsername,
  getSession,
  getUserById,
  deleteSession,
  deleteExpiredSessions,
  setUserPassword,
  type User,
} from "./user-db";

export const SESSION_COOKIE = "caliber-session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MIN_PASSWORD_LENGTH = 8;

const BASIC_CACHE_TTL_MS = 5 * 60 * 1000;
const BASIC_CACHE_MAX_ENTRIES = 10_000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_MAX = 10;

export function authEnabled(): boolean {
  return AUTH_ENABLED;
}

// True when auth is on but no user can log in yet; the web UI offers to
// create the first account and the CLI can add users offline.
export function needsInitialSetup(): boolean {
  return AUTH_ENABLED && countUsersWithPassword() === 0;
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= 512;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// --- Session tokens ---

function sha256Hex(value: string): string {
  return Array.from(new Uint8Array(Bun.CryptoHasher.hash("sha256", value)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sessionCookieHeader(token: string | null): string {
  const base = `${SESSION_COOKIE}=`;
  const attrs = `Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE ? "; Secure" : ""}`;
  if (token === null) {
    return `${base}; ${attrs}; Max-Age=0`;
  }
  return `${base}${token}; ${attrs}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export interface SessionToken {
  token: string;
  expiresAt: number;
}

function randomSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createSessionToken(userId: number): SessionToken {
  const token = randomSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  createSession(sha256Hex(token), userId, expiresAt);
  return { token, expiresAt };
}

export function resolveSessionToken(token: string | undefined | null): User | null {
  if (!token) return null;
  const session = getSession(sha256Hex(token));
  if (!session || session.expiresAt <= Date.now()) return null;
  return getUserById(session.userId);
}

export function revokeSessionToken(token: string | undefined | null): void {
  if (!token) return;
  deleteSession(sha256Hex(token));
}

export function purgeExpiredSessions(): void {
  deleteExpiredSessions();
}

// --- Password login (web form) with a small failure throttle ---

interface FailureEntry {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, FailureEntry>();

function clientKey(req: Request, username: string): string {
  const forwarded = TRUST_PROXY
    ? req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    : undefined;
  const ip = forwarded || "local";
  return `${ip}|${username.trim().toLowerCase()}`;
}

function pruneFailures(now: number): void {
  if (loginFailures.size < 10_000) return;
  for (const [key, entry] of loginFailures) {
    if (entry.resetAt <= now) loginFailures.delete(key);
  }
}

export function loginRateLimited(req: Request, username: string): boolean {
  const now = Date.now();
  pruneFailures(now);
  const entry = loginFailures.get(clientKey(req, username));
  return entry !== undefined && entry.count >= LOGIN_FAILURE_MAX && entry.resetAt > now;
}

function recordLoginFailure(req: Request, username: string): void {
  const now = Date.now();
  const key = clientKey(req, username);
  const entry = loginFailures.get(key);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
  } else {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
  }
}

function clearLoginFailures(req: Request, username: string): void {
  loginFailures.delete(clientKey(req, username));
}

// Verify a username/password pair and update the failure throttle.
// Returns the user on success, null on bad credentials.
export async function authenticateWithPassword(
  req: Request,
  username: string,
  password: string,
): Promise<User | null> {
  const credential = getCredentialByUsername(username);
  const passwordOk =
    credential?.passwordHash != null && credential.passwordHash.length > 0
      ? await verifyPassword(password, credential.passwordHash)
      : false;

  if (!credential || !passwordOk) {
    recordLoginFailure(req, username);
    return null;
  }

  clearLoginFailures(req, username);
  return getUserById(credential.id);
}

// --- HTTP Basic Auth ---

const basicCache = new Map<string, { userId: number; expiresAt: number }>();

function cacheBasicCredential(headerValue: string, userId: number): void {
  if (basicCache.size >= BASIC_CACHE_MAX_ENTRIES) basicCache.clear();
  basicCache.set(sha256Hex(headerValue), { userId, expiresAt: Date.now() + BASIC_CACHE_TTL_MS });
}

export interface BasicCredentials {
  username: string;
  password: string;
}

export function parseBasicAuth(header: string | null): BasicCredentials | null {
  if (!header) return null;
  const spaceIndex = header.indexOf(" ");
  if (spaceIndex === -1) return null;
  const scheme = header.slice(0, spaceIndex);
  const encoded = header.slice(spaceIndex + 1);
  if (!encoded || scheme.toLowerCase() !== "basic") return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (username.length === 0 || password.length === 0) return null;
  return { username, password };
}

async function authenticateBasic(headerValue: string): Promise<User | null> {
  const cacheKey = sha256Hex(headerValue);
  const cached = basicCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) return getUserById(cached.userId);
    basicCache.delete(cacheKey);
  }

  const credentials = parseBasicAuth(headerValue);
  if (!credentials) return null;

  const credential = getCredentialByUsername(credentials.username);
  const passwordOk =
    credential?.passwordHash != null && credential.passwordHash.length > 0
      ? await verifyPassword(credentials.password, credential.passwordHash)
      : false;

  if (!credential || !passwordOk) return null;

  cacheBasicCredential(headerValue, credential.id);
  return getUserById(credential.id);
}

// --- Request authentication ---

export interface AuthenticatedRequest {
  user: User;
  via: "basic" | "session";
}

const requestUserCache = new WeakMap<Request, AuthenticatedRequest>();

function parseCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function sessionTokenFromRequest(req: Request): string | null {
  return parseCookieHeader(req.headers.get("Cookie"), SESSION_COOKIE);
}

// Authenticate a request via Basic auth or the session cookie. Returns null
// for anonymous or invalid credentials. When auth is disabled, always null —
// callers fall back to the username-profile flow.
export async function authenticateRequest(req: Request): Promise<AuthenticatedRequest | null> {
  const cached = requestUserCache.get(req);
  if (cached) return cached;

  const authorization = req.headers.get("Authorization");
  if (authorization) {
    const user = await authenticateBasic(authorization);
    if (user) {
      const result = { user, via: "basic" as const };
      requestUserCache.set(req, result);
      return result;
    }
  }

  const sessionUser = resolveSessionToken(sessionTokenFromRequest(req));
  if (sessionUser) {
    const result = { user: sessionUser, via: "session" as const };
    requestUserCache.set(req, result);
    return result;
  }

  return null;
}

export function setRequestUser(req: Request, authenticated: AuthenticatedRequest): void {
  requestUserCache.set(req, authenticated);
}

// --- User administration (CLI + first-run setup) ---

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

export async function setPasswordForUser(username: string, password: string): Promise<User> {
  if (!isValidPassword(password)) {
    throw new PasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const hash = await hashPassword(password);
  const credential = getCredentialByUsername(username);
  if (!credential) {
    const created = createUserWithPassword(username, hash);
    if (!created) throw new PasswordError("Could not create user");
    return created;
  }
  setUserPassword(credential.id, hash);
  const user = getUserById(credential.id);
  if (!user) throw new PasswordError("Could not update user");
  return user;
}
