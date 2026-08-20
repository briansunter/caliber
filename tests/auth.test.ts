import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const TEST_TIMEOUT = 30_000;

let tempDir = "";
let libraryPath = "";
let configDir = "";
let userDbPath = "";
let baseUrl = "";
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;

function drainPipe(pipe: unknown) {
  if (pipe instanceof ReadableStream) {
    void new Response(pipe).text();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw lastError instanceof Error ? lastError : new Error("Server did not start");
}

function createFixtureLibrary() {
  mkdirSync(libraryPath, { recursive: true });
  const db = new Database(join(libraryPath, "metadata.db"));
  db.exec(`
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT NOT NULL DEFAULT '');
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      sort TEXT,
      timestamp TEXT,
      pubdate TEXT,
      series_index REAL NOT NULL DEFAULT 1.0,
      author_sort TEXT,
      path TEXT NOT NULL,
      flags INTEGER NOT NULL DEFAULT 1,
      uuid TEXT NOT NULL,
      has_cover INTEGER DEFAULT 0,
      last_modified TEXT
    );
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
    CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book, publisher));
    CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT);
    CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
    CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER NOT NULL UNIQUE);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE INDEX authors_idx ON authors(sort);
    CREATE INDEX books_idx ON books(sort);
    CREATE INDEX books_authors_link_aidx ON books_authors_link(author);
    CREATE INDEX books_authors_link_bidx ON books_authors_link(book);
    CREATE INDEX data_book_index ON data(book);
    CREATE INDEX data_format_index ON data(format);
  `);
  db.run("INSERT INTO authors (id, name, sort) VALUES (1, 'Alice Author', 'Author, Alice')");
  db.run(`
    INSERT INTO books
      (id, title, sort, timestamp, pubdate, series_index, author_sort, path, flags, uuid, has_cover, last_modified)
    VALUES
      (1, 'Auth Fixture Book', 'Auth Fixture Book', '2024-01-02 00:00:00+00:00', '2023-01-01 00:00:00+00:00', 1.0, 'Author, Alice', 'Auth Fixture Book', 1, '44444444-4444-4444-4444-444444444444', 0, '2024-01-02 00:00:00+00:00')
  `);
  db.run("INSERT INTO books_authors_link (book, author) VALUES (1, 1)");
  db.run("INSERT INTO data (book, format, uncompressed_size, name) VALUES (1, 'EPUB', 0, 'Auth Fixture Book')");
  db.close();
}

// A users.db from before auth support: no password_hash column. The server
// must migrate it on first use and CLI `user passwd` must work against it.
function createLegacyUserDb() {
  const db = new Database(userDbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL,
      format TEXT NOT NULL,
      location TEXT,
      percentage REAL NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );
  `);
  db.run(
    "INSERT INTO users (username, username_lower, created_at, last_seen_at) VALUES ('legacy', 'legacy', 0, 0)",
  );
  db.close();
}

function serverEnv(port: number) {
  return {
    ...process.env,
    CALIBER_CONFIG_DIR: configDir,
    CALIBER_USER_DB_PATH: userDbPath,
    CALIBRE_LIBRARY_PATH: libraryPath,
    CALIBER_AUTH_ENABLED: "true",
    PORT: String(port),
    NODE_ENV: "test",
  };
}

async function runCli(args: string[], stdinData?: string) {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: serverEnv(0),
    stdin: stdinData === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdinData !== undefined && proc.stdin) {
    proc.stdin.write(stdinData);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/caliber-session=([^;]+)/);
  return match?.[1] ? `caliber-session=${match[1]}` : "";
}

async function json(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = (await response.json().catch(() => null)) as unknown;
  return { response, body };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "caliber-auth-"));
  libraryPath = join(tempDir, "library");
  configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  userDbPath = join(configDir, "users.db");
  createFixtureLibrary();
  createLegacyUserDb();

  const port = await freePort();
  baseUrl = `http://localhost:${port}`;
  serverProcess = Bun.spawn(["bun", "src/index.ts"], {
    cwd: process.cwd(),
    env: serverEnv(port),
    stdout: "pipe",
    stderr: "pipe",
  });

  drainPipe(serverProcess.stdout);
  drainPipe(serverProcess.stderr);
  await waitForServer(baseUrl);
}, TEST_TIMEOUT);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await serverProcess.exited.catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("auth guard", () => {
  test("health stays public", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
  });

  test("API requires auth without a Basic challenge header", async () => {
    const response = await fetch(`${baseUrl}/api/books`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  test("OPDS requires auth and advertises Basic", async () => {
    const response = await fetch(`${baseUrl}/opds`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  test("covers and downloads are protected", async () => {
    const cover = await fetch(`${baseUrl}/api/books/1/cover`);
    expect(cover.status).toBe(401);
    const download = await fetch(`${baseUrl}/api/books/1/download/EPUB`);
    expect(download.status).toBe(401);
  });
});

describe("first-run setup and sessions", () => {
  test("me reports auth required and pending setup", async () => {
    const { response, body } = await json("/api/user/me");
    expect(response.status).toBe(200);
    expect(body).toEqual({ user: null, authRequired: true, needsSetup: true });
  });

  test("setup rejects short passwords", async () => {
    const { response } = await json("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "short" }),
    });
    expect(response.status).toBe(400);
  });

  test("first setup creates an account and starts a session", async () => {
    const { response, body } = await json("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password-123" }),
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({ user: { id: expect.any(Number), username: "alice" } });
    expect(response.headers.get("set-cookie")).toContain("caliber-session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("setup closes after the first account", async () => {
    const { response } = await json("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "sneaky", password: "password-123" }),
    });
    expect(response.status).toBe(403);
  });

  test("session cookie grants API access", async () => {
    const login = await json("/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password-123" }),
    });
    expect(login.response.status).toBe(200);
    const cookie = sessionCookie(login.response);
    expect(cookie).not.toBe("");

    const books = await fetch(`${baseUrl}/api/books`, { headers: { Cookie: cookie } });
    expect(books.status).toBe(200);

    const me = await json("/api/user/me", { headers: { Cookie: cookie } });
    expect(me.body).toEqual({
      user: { id: expect.any(Number), username: "alice" },
      authRequired: true,
      needsSetup: false,
    });
  });

  test("wrong password is rejected", async () => {
    const { response } = await json("/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });
    expect(response.status).toBe(401);
  });

  test("logout revokes the session", async () => {
    const login = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password-123" }),
    });
    const cookie = sessionCookie(login);
    expect(cookie).not.toBe("");

    const logout = await fetch(`${baseUrl}/api/user/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);

    const books = await fetch(`${baseUrl}/api/books`, { headers: { Cookie: cookie } });
    expect(books.status).toBe(401);
  });
});

describe("HTTP Basic auth (OPDS clients)", () => {
  test("Basic credentials work on OPDS feeds", async () => {
    const response = await fetch(`${baseUrl}/opds`, {
      headers: { Authorization: basicAuth("alice", "password-123") },
    });
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("<feed");
  });

  test("Basic credentials work on the JSON API", async () => {
    const response = await fetch(`${baseUrl}/api/books?limit=1`, {
      headers: { Authorization: basicAuth("alice", "password-123") },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: unknown[] };
    expect(body.items?.length).toBe(1);
  });

  test("bad Basic credentials are rejected", async () => {
    const response = await fetch(`${baseUrl}/opds`, {
      headers: { Authorization: basicAuth("alice", "nope") },
    });
    expect(response.status).toBe(401);
  });
});

describe("CLI user management", () => {
  test("user add creates a login-able account via --password-stdin", async () => {
    const add = await runCli(["user", "add", "bob", "--password-stdin"], "bob-password-9\n");
    expect(add.exitCode).toBe(0);
    expect(add.stderr).toBe("");

    const login = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bob-password-9" }),
    });
    expect(login.status).toBe(200);
  });

  test("user add rejects existing accounts with passwords", async () => {
    const add = await runCli(["user", "add", "bob", "--password-stdin"], "bob-password-9\n");
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toContain("user passwd");
  });

  test("user passwd upgrades a pre-auth profile (schema migration)", async () => {
    const passwd = await runCli(
      ["user", "passwd", "legacy", "--password-stdin"],
      "legacy-password-9\n",
    );
    expect(passwd.exitCode).toBe(0);

    const response = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Authorization: basicAuth("legacy", "legacy-password-9") },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { username: string } | null };
    expect(body.user?.username).toBe("legacy");
  });

  test("user list reports accounts", async () => {
    const list = await runCli(["user", "list"]);
    expect(list.exitCode).toBe(0);
    const body = JSON.parse(list.stdout) as {
      users: Array<{ username: string; hasPassword: boolean }>;
    };
    const names = body.users.map((user) => user.username).sort();
    expect(names).toEqual(["alice", "bob", "legacy"]);
    expect(body.users.every((user) => user.hasPassword)).toBe(true);
  });

  test("user remove deletes the account", async () => {
    const remove = await runCli(["user", "remove", "bob"]);
    expect(remove.exitCode).toBe(0);

    const login = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bob-password-9" }),
    });
    expect(login.status).toBe(401);
  });
});

describe("multi-user reading progress", () => {
  test("progress is isolated per user", async () => {
    const put = async (username: string, percentage: number) =>
      fetch(`${baseUrl}/api/user/progress/1`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuth(username, `${username}-password-9`),
        },
        body: JSON.stringify({ format: "EPUB", percentage }),
      });

    const passwdAlice = await runCli(
      ["user", "passwd", "alice", "--password-stdin"],
      "alice-password-9\n",
    );
    expect(passwdAlice.exitCode).toBe(0);
    const passwdLegacy = await runCli(
      ["user", "passwd", "legacy", "--password-stdin"],
      "legacy-password-9\n",
    );
    expect(passwdLegacy.exitCode).toBe(0);

    expect((await put("alice", 10)).status).toBe(200);
    expect((await put("legacy", 90)).status).toBe(200);

    const read = async (username: string) =>
      (
        await (
          await fetch(`${baseUrl}/api/user/progress/1`, {
            headers: { Authorization: basicAuth(username, `${username}-password-9`) },
          })
        ).json()
      ).progress as { percentage: number } | null;

    expect(await read("alice")).toMatchObject({ percentage: 10 });
    expect(await read("legacy")).toMatchObject({ percentage: 90 });
  });
});

describe("login throttling", () => {
  test("repeated failures return 429", async () => {
    let sawTooMany = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/user/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "throttle-me", password: "wrong-password" }),
      });
      if (response.status === 429) {
        sawTooMany = true;
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(sawTooMany).toBe(true);
  }, 30_000);
});
