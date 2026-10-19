#!/usr/bin/env python3
"""Fair A/B benchmark: Rust rewrite (release) vs original Bun backend (production).

Measures, against the *same* generated Calibre fixture (never a real library):
  - cold + warm startup readiness (HTTP health vs DB-ready signal)
  - idle RSS and sampled peak RSS (boot init and load phases)
  - latency (p50/p95/mean) and throughput at concurrency 1 and 16 for:
      * cached   GET /api/stats            (LRU HIT after warm-up)
      * cached   GET /api/books first page (LRU HIT after warm-up)
      * uncached GET /api/books?tag=a&tag=b (unique tag pair per request => real miss)
      * uncached GET /api/books/search     (never cached by design)
      * keyset pagination walk (sequential cursor following, c=1)
  - semantic sanity checks between the two implementations (same ids/etags)

Stdlib only. See docs/rust/benchmark-results.md for the evidence report.

Usage:
  python3 scripts/benchmark-backends.py [--books 100000] [--rounds 3]
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import platform
import random
import shutil
import signal
import socket
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT_VERSION = "1.0.0"

# Approved scratch root (override with CALIBER_BENCH_ROOT).
DEFAULT_ROOT = Path(
    os.environ.get(
        "CALIBER_BENCH_ROOT",
        "/private/var/folders/jm/0612flt13mg60d45cnl_5twm0000gn/T/opencode/caliber-bench",
    )
)

# ---------------------------------------------------------------------------
# Fixture generation (Calibre schema, mirrors scripts/generate-test-library.ts)
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE authors (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT NOT NULL DEFAULT ''
);
CREATE TABLE books (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, sort TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP, pubdate TEXT DEFAULT '2000-01-01 00:00:00+00:00',
  series_index REAL NOT NULL DEFAULT 1.0, author_sort TEXT, isbn TEXT DEFAULT '' COLLATE NOCASE,
  lccn TEXT DEFAULT '' COLLATE NOCASE, path TEXT NOT NULL, flags INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL, has_cover INTEGER DEFAULT 0,
  last_modified TEXT DEFAULT '2000-01-01 00:00:00+00:00'
);
CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, lang_code INTEGER NOT NULL, item_order INTEGER NOT NULL DEFAULT 0, link TEXT DEFAULT '' COLLATE NOCASE, UNIQUE(book, lang_code));
CREATE TABLE books_plugin_data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, name TEXT NOT NULL, val TEXT NOT NULL, UNIQUE(book, name));
CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book, publisher));
CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE conversion_options (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(book, format));
CREATE TABLE custom_columns (id INTEGER PRIMARY KEY, label TEXT NOT NULL, name TEXT NOT NULL, datatype TEXT NOT NULL, mark_for_delete INTEGER NOT NULL DEFAULT 0, editable INTEGER NOT NULL DEFAULT 1, display TEXT NOT NULL DEFAULT '{}' COLLATE NOCASE, is_multiple INTEGER NOT NULL DEFAULT 0, normalized INTEGER NOT NULL DEFAULT 0);
CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT);
CREATE TABLE feeds (id INTEGER PRIMARY KEY, title TEXT NOT NULL, script TEXT NOT NULL, updated TEXT);
CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE library_id (id INTEGER PRIMARY KEY CHECK(id = 1), uuid TEXT NOT NULL);
CREATE TABLE metadata_dirtied (id INTEGER PRIMARY KEY, book INTEGER NOT NULL UNIQUE);
CREATE TABLE preferences (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE COLLATE NOCASE, val TEXT NOT NULL);
CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER NOT NULL CHECK(rating > 0 AND rating < 11) UNIQUE);
CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort TEXT COLLATE NOCASE);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE INDEX authors_idx ON authors(sort);
CREATE INDEX books_idx ON books(sort);
CREATE INDEX books_authors_link_aidx ON books_authors_link(author);
CREATE INDEX books_authors_link_bidx ON books_authors_link(book);
CREATE INDEX books_languages_link_bidx ON books_languages_link(book);
CREATE INDEX books_publishers_link_a_idx ON books_publishers_link(publisher);
CREATE INDEX books_publishers_link_b_idx ON books_publishers_link(book);
CREATE INDEX books_ratings_link_bidx ON books_ratings_link(book);
CREATE INDEX books_series_link_book_idx ON books_series_link(book);
CREATE INDEX books_tags_link_aidx ON books_tags_link(tag);
CREATE INDEX books_tags_link_bidx ON books_tags_link(book);
CREATE INDEX comments_idx ON comments(book);
CREATE INDEX data_book_index ON data(book);
CREATE INDEX data_format_index ON data(format);
CREATE INDEX publishers_idx ON publishers(sort);
CREATE INDEX series_idx ON series(sort);
CREATE INDEX tags_idx ON tags(name);
"""

FIRST_NAMES = "James Mary John Patricia Robert Jennifer Michael Linda William Elizabeth David Barbara Richard Susan Joseph Jessica Thomas Sarah Charles Karen Christopher Nancy Daniel Lisa Matthew Betty Anthony Margaret Mark Sandra Donald Ashley Steven Kimberly Paul Emily Andrew Donna Joshua Michelle Kenneth Dorothy Kevin Carol Brian Amanda George Melissa Edward Deborah Ronald Stephanie Timothy Rebecca Jason Sharon Jeffrey Laura Ryan Cynthia Jacob Kathleen Gary Amy Nicholas Shirley Eric Angela Jonathan Helen Anna Larry Brenda Justin Pamela Scott Nicole Brandon Emma Benjamin Samantha Samuel Katherine Gregory Christine Frank Debra Alexander Rachel Raymond Catherine Patrick Carolyn Jack Janet Dennis Ruth Jerry Maria Tyler Heather Aaron Diane".split()
LAST_NAMES = "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez Powell Jenkins Perry Russell".split()
ADJECTIVES = "Silent Hidden Lost Dark Golden Silver Crystal Shadow Broken Eternal Forbidden Ancient Secret Mystic Last First Final Infinite Limited Complete Absolute Relative Total Supreme Ultimate Perfect Ideal Virtual Digital Physical Mental Spiritual Natural Artificial Synthetic Organic Chemical Nuclear Atomic Cosmic Global Universal Galactic Planetary Terrestrial Celestial Heavenly Hellish Demonic Angelic Divine Sacred Profane Holy Unholy Blessed Cursed Lucky Unlucky Fortunate Unfortunate Happy Sad Joyful Sorrowful Angry Peaceful Violent Gentle Strong Weak Powerful Powerless Rich Poor Wealthy Destitute Abundant Scarce Beautiful Ugly Pretty Hideous Attractive Repulsive Pleasant Unpleasant Delightful Distressing Comfortable Uncomfortable Easy Difficult Simple Complex Complicated Straightforward Direct Indirect Clear Unclear Obvious Subtle".split()
NOUNS = "Echo Storm Garden Empire Kingdom Realm World Universe Star Planet Moon Sun Sky Ocean Sea River Mountain Valley Forest Desert Island Continent City Village Tower Castle Palace Temple Church Mosque Synagogue Shrine Gate Door Window Wall Bridge Road Path Way Journey Quest Mission Adventure Odyssey Pilgrimage Voyage Expedition Sword Shield Armor Weapon Tool Instrument Machine Device Artifact Relic Treasure Jewel Gem Stone Rock Crystal Book Scroll Manuscript Text Code Cipher Secret Mystery Legend Myth Fable Story Tale History Chronicle Record Memory Dream Vision Nightmare Fantasy Reality Truth Lie Justice Injustice Freedom Slavery Peace War Love Hate Life Death Birth Rebirth Creation Destruction Beginning End Origin Destination Source Target Cause Effect Reason Purpose".split()
SERIES_PREFIXES = "Chronicles Saga Tales Legends History Book War Fall Rise Return Reign Age Era Time Days Nights Shadow Light Fire Ice Blood Honor Glory Doom Fate Destiny Prophecy Curse Blessing Gift Power Magic Mystery Secret Truth Lie Dream Nightmare Hope Fear Joy Sorrow Love Hate Life Death Birth Rebirth Creation Destruction Beginning End".split()
TAGS = "fiction non-fiction sci-fi fantasy mystery thriller romance horror historical biography autobiography memoir self-help business finance economics politics philosophy psychology science technology computers programming software hardware networking security hacking data analytics statistics mathematics physics chemistry biology medicine health fitness nutrition cooking food travel adventure sports games art music photography design architecture history war military espionage crime detective police legal courtroom drama comedy satire poetry classic modern contemporary vintage rare collectible limited special award-winning bestseller popular obscure underground indie mainstream commercial literary genre pulp paperback hardcover ebook audiobook comic manga graphic-novel anthology collection omnibus complete abridged unabridged illustrated annotated translated original revised updated expanded condensed academic scholarly research reference textbook manual guide handbook encyclopedia dictionary thesaurus atlas almanac directory catalog index".split()
PUBLISHERS = "Penguin Random House HarperCollins Simon & Schuster Hachette Book Group Macmillan Publishers Scholastic Disney Publishing Bloomsbury Oxford University Press Cambridge University Press Harvard University Press Yale University Press MIT Press University of Chicago Press Stanford University Press Princeton University Press Random House Doubleday Knopf Crown Publishing Viking Press Grand Central Publishing St. Martin's Press Tor Books Orbit Books Baen Books DAW Books Ace Books Del Rey Bantam Books Ballantine Books Broadway Books Vintage Books Anchor Books Picador Grove Atlantic W.W. Norton Liveright Publishing Pantheon Books Everyman's Library Library of America New York Review Books NYU Press Columbia University Press".split()
FORMATS = ["EPUB", "MOBI", "AZW3", "PDF", "TXT"]

DATE_MIN = datetime(1900, 1, 1)
DATE_MAX = datetime(2024, 12, 31, 23, 59, 59)


def _uuid(rng: random.Random) -> str:
    raw = [rng.randrange(16) for _ in range(32)]
    raw[12] = 4
    raw[16] = 8 + rng.randrange(4)
    s = "".join(f"{v:x}" for v in raw)
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"


def _isbn(rng: random.Random) -> str:
    body = "978" + str(rng.randrange(10)) + str(rng.randrange(1000, 10000)) + str(rng.randrange(10000, 100000))
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(body))
    return body + str((10 - total % 10) % 10)


def _date(rng: random.Random, lo: datetime, hi: datetime) -> str:
    delta = (hi - lo).total_seconds()
    return (lo + timedelta(seconds=rng.uniform(0, delta))).strftime("%Y-%m-%d %H:%M:%S")


def generate_fixture(lib_dir: Path, books: int, seed: int) -> dict:
    """Create <lib_dir>/metadata.db: a seeded, reproducible Calibre library."""
    rng = random.Random(seed)
    lib_dir.mkdir(parents=True, exist_ok=True)
    db_path = lib_dir / "metadata.db"
    if db_path.exists():
        db_path.unlink()
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA_SQL)

    db.executemany("INSERT INTO ratings (rating) VALUES (?)", [(i,) for i in range(1, 11)])
    tag_ids: dict[str, int] = {}
    for name in TAGS:
        tag_ids[name] = db.execute("INSERT INTO tags (name) VALUES (?)", (name,)).lastrowid
    author_ids: dict[str, int] = {}
    series_ids: dict[str, int] = {}
    publisher_ids: dict[str, int] = {}

    batch = 5000
    t0 = time.time()
    for base in range(0, books, batch):
        rows_books, rows_ba, rows_tags, rows_bs = [], [], [], []
        rows_bp, rows_br, rows_data, rows_comments = [], [], [], []
        for i in range(base + 1, min(base + batch, books) + 1):
            title = f"{rng.choice(ADJECTIVES)} {rng.choice(NOUNS)}"
            r = rng.random()
            if r < 0.5:
                title = f"The {title}"
            elif r < 0.65:
                title = f"{title} of {rng.choice(NOUNS)}"
            first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
            uuid = _uuid(rng)
            path = f"Unknown/{(''.join(c if c.isalnum() else ' ' for c in title)).strip()[:50]} ({uuid})"
            rows_books.append(
                (
                    i, title, title.lower(),
                    _date(rng, datetime(2010, 1, 1), DATE_MAX),          # timestamp (added)
                    _date(rng, DATE_MIN, DATE_MAX),                      # pubdate
                    float(rng.randrange(1, 21)),                          # series_index
                    f"{last}, {first}",
                    _isbn(rng), path, uuid,
                    1 if rng.random() > 0.3 else 0,                       # has_cover
                    _date(rng, datetime(2020, 1, 1), DATE_MAX),          # last_modified
                )
            )
            key = f"{first} {last}"
            if key not in author_ids:
                author_ids[key] = db.execute(
                    "INSERT INTO authors (name, sort, link) VALUES (?, ?, '')", (key, f"{last}, {first}")
                ).lastrowid
            rows_ba.append((i, author_ids[key]))
            if rng.random() > 0.5:  # 50% in a series
                sname = f"The {rng.choice(SERIES_PREFIXES)} of {rng.choice(NOUNS)}"
                if sname not in series_ids:
                    series_ids[sname] = db.execute(
                        "INSERT INTO series (name, sort) VALUES (?, ?)", (sname, sname.lower())
                    ).lastrowid
                rows_bs.append((i, series_ids[sname]))
            if rng.random() > 0.3:  # 70% publisher
                pname = rng.choice(PUBLISHERS)
                if pname not in publisher_ids:
                    publisher_ids[pname] = db.execute(
                        "INSERT INTO publishers (name, sort) VALUES (?, ?)", (pname, pname.lower())
                    ).lastrowid
                rows_bp.append((i, publisher_ids[pname]))
            if rng.random() > 0.6:  # 40% rating
                rows_br.append((i, rng.randrange(1, 11)))
            for tname in rng.sample(TAGS, rng.randrange(1, 6)):
                rows_tags.append((i, tag_ids[tname]))
            for fmt in rng.sample(FORMATS, rng.randrange(1, 4)):
                rows_data.append(
                    (i, fmt, rng.randrange(100_000, 10_000_000), "".join(c if c.isalnum() else "_" for c in title)[:30])
                )
            if rng.random() <= 0.7:  # 70% comment
                rows_comments.append((i, f"A {rng.choice(ADJECTIVES).lower()} tale of {rng.choice(NOUNS).lower()}."))
        db.executemany(
            "INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, isbn, path, uuid, has_cover, last_modified) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            rows_books,
        )
        db.executemany("INSERT INTO books_authors_link (book, author) VALUES (?, ?)", rows_ba)
        db.executemany("INSERT OR IGNORE INTO books_tags_link (book, tag) VALUES (?, ?)", rows_tags)
        db.executemany("INSERT INTO books_series_link (book, series) VALUES (?, ?)", rows_bs)
        db.executemany("INSERT INTO books_publishers_link (book, publisher) VALUES (?, ?)", rows_bp)
        db.executemany("INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)", rows_br)
        db.executemany("INSERT INTO data (book, format, uncompressed_size, name) VALUES (?,?,?,?)", rows_data)
        db.executemany("INSERT INTO comments (book, text) VALUES (?,?)", rows_comments)
        db.commit()
        done = min(base + batch, books)
        print(f"  fixture: {done}/{books} books ({done / max(time.time() - t0, 0.001):.0f} books/s)", flush=True)

    db.execute("INSERT INTO library_id (id, uuid) VALUES (1, ?)", (_uuid(rng),))
    db.commit()
    db.executescript("VACUUM; ANALYZE;")
    first_title = db.execute("SELECT title FROM books WHERE id = 1").fetchone()[0]
    tag_id_list = [r[0] for r in db.execute("SELECT id FROM tags ORDER BY id")]
    db.close()
    return {
        "first_title": first_title,
        "broad_query": "golden",
        "narrow_query": first_title.lower(),
        "miss_query": "zzzqxvnope",
        "tag_ids": tag_id_list,
    }


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Environment info
# ---------------------------------------------------------------------------


def cmd_out(args: list[str], cwd: Path | None = None) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=120).stdout.strip()
    except Exception as exc:  # noqa: BLE001
        return f"<unavailable: {exc}>"


def sysctl(name: str) -> str:
    return cmd_out(["sysctl", "-n", name])


def collect_env() -> dict:
    return {
        "date_utc": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "script_version": SCRIPT_VERSION,
        "repo": str(REPO),
        "git_commit": cmd_out(["git", "rev-parse", "HEAD"], REPO),
        "git_branch": cmd_out(["git", "branch", "--show-current"], REPO),
        "git_dirty_files": cmd_out(["git", "status", "--short"], REPO).splitlines(),
        "python": sys.version.split()[0],
        "bun": cmd_out(["bun", "--version"]),
        "rustc": cmd_out(["rustc", "--version"]),
        "cargo": cmd_out(["cargo", "--version"]),
        "os": f"{platform.system()} {cmd_out(['sw_vers', '-productVersion'])} ({sysctl('hw.model')})",
        "cpu": sysctl("machdep.cpu.brand_string"),
        "cpu_cores": sysctl("hw.ncpu"),
        "ram_bytes": sysctl("hw.memsize"),
    }


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def http_get_raw(port: int, path: str, timeout: float = 30.0, conn: http.client.HTTPConnection | None = None):
    """Like http_get but also returns the raw body bytes (for hashing)."""
    own = conn is None
    if own:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    t0 = time.perf_counter()
    try:
        conn.request("GET", path, headers={"Accept": "application/json", "Connection": "keep-alive"})
        resp = conn.getresponse()
        data = resp.read()
        elapsed = (time.perf_counter() - t0) * 1000.0
        try:
            body = json.loads(data) if data else None
        except json.JSONDecodeError:
            body = None
        headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, body, data, headers
    finally:
        if own:
            conn.close()


def http_get(port: int, path: str, timeout: float = 30.0, conn: http.client.HTTPConnection | None = None):
    """One GET. Returns (status, parsed_json_or_None, elapsed_ms, bytes, headers)."""
    own = conn is None
    if own:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    t0 = time.perf_counter()
    try:
        conn.request("GET", path, headers={"Accept": "application/json", "Connection": "keep-alive"})
        resp = conn.getresponse()
        data = resp.read()
        elapsed = (time.perf_counter() - t0) * 1000.0
        try:
            body = json.loads(data) if data else None
        except json.JSONDecodeError:
            body = None
        headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, body, elapsed, len(data), headers
    finally:
        if own:
            conn.close()


# ---------------------------------------------------------------------------
# Server process management + RSS sampling
# ---------------------------------------------------------------------------


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def rss_kb(pid: int) -> int:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip())
    except Exception:  # noqa: BLE001
        return 0


class RssSampler(threading.Thread):
    """Samples target RSS on a timeline; phases register (t0, t1) windows and
    peaks are attributed by time range afterwards."""

    def __init__(self, pid: int, interval_ms: int = 50):
        super().__init__(daemon=True)
        self.pid = pid
        self.interval = interval_ms / 1000.0
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self.timeline: list[tuple[float, float]] = []
        self.windows: dict[str, list[tuple[float, float]]] = {}

    def phase(self, name: str) -> "_PhaseCtx":
        return _PhaseCtx(self, name)

    def snapshot(self) -> dict:
        with self._lock:
            out: dict = {}
            for name, spans in self.windows.items():
                vals = [v for (t, v) in self.timeline for (t0, t1) in spans if t0 <= t <= t1 + 0.05]
                out[name] = {
                    "peak_kb": max(vals) if vals else 0,
                    "windows": len(spans),
                    "samples_in_windows": len(vals),
                }
            out["__global_peak_kb__"] = max((v for _, v in self.timeline), default=0)
            out["__samples__"] = len(self.timeline)
            return out

    def run(self):
        while not self._halt.is_set():
            v = rss_kb(self.pid)
            if v:
                with self._lock:
                    self.timeline.append((time.perf_counter(), v))
            time.sleep(self.interval)

    def stop(self):
        self._halt.set()
        self.join(timeout=3.0)


class _PhaseCtx:
    def __init__(self, sampler: RssSampler, name: str):
        self.sampler = sampler
        self.name = name
        self.t0 = 0.0

    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        t1 = time.perf_counter()
        with self.sampler._lock:
            self.sampler.windows.setdefault(self.name, []).append((self.t0, t1))


class Server:
    """One backend process bound to the fixture with its own cache dir."""

    def __init__(self, backend: str, fixture_dir: Path, cache_dir: Path, run_dir: Path):
        self.backend = backend
        self.fixture_dir = fixture_dir
        self.cache_dir = cache_dir
        self.run_dir = run_dir
        self.port = free_port()
        self.proc: subprocess.Popen | None = None
        self.sampler: RssSampler | None = None
        self.log_path = run_dir / f"{backend}.log"
        self._log_f = None

    def base_env(self) -> dict:
        env = os.environ.copy()
        # Never inherit a real library, users.db, auth policy, or proxy setting.
        # CALIBRE_LIBRARY_PATH takes precedence over the CALIBER alias below.
        for name in list(env):
            if name.startswith(("CALIBER_", "CALIBRE_")):
                env.pop(name)
        env.pop("NODE_ENV", None)
        env.update(
            {
                # NB: config dir only accepts the CALIBER spelling (see
                # src/lib/config.ts + crates/caliber-common/src/config.rs).
                "CALIBER_LIBRARY_PATH": str(self.fixture_dir),
                "CALIBRE_LIBRARY_PATH": str(self.fixture_dir),
                "CALIBER_CONFIG_DIR": str(self.cache_dir),
                "CALIBER_USER_DB_PATH": str(self.cache_dir / "users.db"),
                "CALIBER_AUTH_ENABLED": "false",
                "CALIBER_HOST": "127.0.0.1",
                "PORT": str(self.port),
                "CALIBER_MCP_ENABLED": "false",
                # identical settings for both backends; cache dirs are separate
                "CALIBER_DB_REFRESH_INTERVAL_MS": "60000",
            }
        )
        if self.backend == "bun":
            env["NODE_ENV"] = "production"  # matches `bun start` (package.json)
        return env

    def start(self, cold: bool, timeout_s: float = 600.0) -> dict:
        if cold and self.cache_dir.exists():
            shutil.rmtree(self.cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        argv = [str(REPO / "target/release/caliber-server")] if self.backend == "rust" else ["bun", "src/index.ts"]
        self._log_f = open(self.log_path, "ab")
        t_spawn = time.perf_counter()
        self.proc = subprocess.Popen(
            argv, cwd=REPO, env=self.base_env(), stdout=self._log_f, stderr=self._log_f, stdin=subprocess.DEVNULL
        )
        self.sampler = RssSampler(self.proc.pid)
        self.sampler.start()

        # Poll /api/health (HTTP listening) then /api/config/library (DB ready).
        t_health = None
        deadline = time.perf_counter() + timeout_s
        while time.perf_counter() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"{self.backend} exited during startup (code {self.proc.returncode}); see {self.log_path}")
            try:
                st, _, _, _, _ = http_get(self.port, "/api/health", timeout=2.0)
                if st == 200:
                    t_health = time.perf_counter() - t_spawn
                    break
            except OSError:
                pass
            time.sleep(0.025)
        if t_health is None:
            self.stop()
            raise RuntimeError(f"{self.backend}: /api/health never answered within {timeout_s}s")

        t_ready = None
        while time.perf_counter() < deadline:
            try:
                st, body, _, _, _ = http_get(self.port, "/api/config/library", timeout=5.0)
                if st == 200 and isinstance(body, dict) and body.get("ready") is True:
                    t_ready = time.perf_counter() - t_spawn
                    break
            except OSError:
                pass
            time.sleep(0.025)
        if t_ready is None:
            self.stop()
            raise RuntimeError(f"{self.backend}: /api/config/library never reported ready=true")
        return {
            "cold_cache": cold,
            "port": self.port,
            "cmd": " ".join(argv),
            "t_health_s": round(t_health, 4),
            "t_db_ready_s": round(t_ready, 4),
            "rss_at_ready_kb": rss_kb(self.proc.pid),
            "log": str(self.log_path),
            "pid": self.proc.pid,
        }

    def stop(self):
        if self.sampler:
            self.sampler.stop()
            self.sampler = None
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.proc = None
        if self._log_f:
            self._log_f.close()
            self._log_f = None


# ---------------------------------------------------------------------------
# Load phases
# ---------------------------------------------------------------------------


@dataclass
class PhaseResult:
    backend: str
    round_idx: int
    phase: str
    concurrency: int
    count: int = 0
    errors: int = 0
    non200: int = 0
    lat_ms: list[float] = field(default_factory=list)
    wall_s: float = 0.0
    bytes_total: int = 0
    rss_peak_kb: int = 0
    extra: dict = field(default_factory=dict)


def run_phase(server: Server, round_idx: int, phase: str, url_fn, concurrency: int, n_requests: int) -> PhaseResult:
    """Closed-loop load: `concurrency` threads, each with its own keep-alive connection."""
    res = PhaseResult(backend=server.backend, round_idx=round_idx, phase=phase, concurrency=concurrency)
    counter = {"i": 0}
    lock = threading.Lock()
    res_lock = threading.Lock()

    def worker():
        conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=30.0)
        try:
            while True:
                with lock:
                    if counter["i"] >= n_requests:
                        return
                    counter["i"] += 1
                    idx = counter["i"]
                try:
                    status, _, lat, nbytes, _ = http_get(server.port, url_fn(idx), timeout=30.0, conn=conn)
                    with res_lock:
                        if status != 200:
                            res.non200 += 1
                            if status >= 500:
                                res.errors += 1
                        res.lat_ms.append(lat)
                        res.bytes_total += nbytes
                except Exception:  # noqa: BLE001
                    with res_lock:
                        res.errors += 1
                    try:
                        conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=30.0)
        finally:
            conn.close()

    t0 = time.perf_counter()
    sampler_ctx = server.sampler.phase(f"{phase}_c{concurrency}") if server.sampler else None
    if sampler_ctx:
        sampler_ctx.__enter__()
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(worker) for _ in range(concurrency)]
            for f in futures:
                f.result()
    finally:
        if sampler_ctx:
            sampler_ctx.__exit__()
    res.wall_s = time.perf_counter() - t0
    res.count = len(res.lat_ms)
    if server.sampler:
        phase_snap = server.sampler.snapshot()
        res.rss_peak_kb = int(phase_snap.get(f"{phase}_c{concurrency}", {}).get("peak_kb", 0))
        res.extra["rss_samples_in_window"] = phase_snap.get(f"{phase}_c{concurrency}", {}).get("samples_in_windows", 0)
        res.extra["rss_global_samples_this_boot"] = phase_snap["__samples__"]
    return res


def run_walk(server: Server, round_idx: int, pages: int, limit: int = 50) -> PhaseResult:
    """Sequential keyset pagination: follow nextCursor page to page (c=1)."""
    res = PhaseResult(backend=server.backend, round_idx=round_idx, phase="pagination_walk", concurrency=1)
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=30.0)
    cursor = None
    ctx = server.sampler.phase("pagination_walk_c1") if server.sampler else None
    if ctx:
        ctx.__enter__()
    t_all = time.perf_counter()
    try:
        for page in range(pages):
            url = f"/api/books?sortBy=title&sortOrder=asc&limit={limit}&includeTotal=0"
            if cursor:
                url += f"&cursor={urllib.parse.quote(cursor, safe='')}"
            status, body, lat, nbytes, _ = http_get(server.port, url, conn=conn)
            if status != 200 or not isinstance(body, dict):
                res.errors += 1
                break
            res.lat_ms.append(lat)
            res.bytes_total += nbytes
            cursor = body.get("nextCursor")
            if not cursor:
                res.extra["walk_ended_early_at_page"] = page + 1
                break
    finally:
        if ctx:
            ctx.__exit__()
        conn.close()
    res.wall_s = time.perf_counter() - t_all
    res.count = len(res.lat_ms)
    if server.sampler:
        res.rss_peak_kb = int(server.sampler.snapshot().get("pagination_walk_c1", {}).get("peak_kb", 0))
    return res


def semantic_capture(server: Server, probes: dict) -> dict:
    """Canonical responses for cross-backend semantic comparison."""
    cap: dict = {}
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=60.0)
    try:
        st, body, _, _, headers = http_get(server.port, "/api/stats", conn=conn)
        cap["stats"] = body if st == 200 else {"__status__": st}
        st, body, raw, headers = http_get_raw(server.port, "/api/books?sortBy=title&sortOrder=asc&limit=50", conn=conn)
        cap["first_page_ids"] = [b["id"] for b in body.get("items", [])] if isinstance(body, dict) else None
        cap["first_page_etag"] = headers.get("etag")
        cap["first_page_body_sha256"] = hashlib.sha256(raw).hexdigest() if raw else None
        # tag-filtered first page (unique-ish subset; parity evidence)
        tag = probes["tag_ids"][0]
        st, body, _, _, _ = http_get(server.port, f"/api/books?tag={tag}&limit=25&includeTotal=1", conn=conn)
        cap["tag_page_ids"] = [b["id"] for b in body.get("items", [])] if isinstance(body, dict) else None
        cap["tag_page_total"] = body.get("total") if isinstance(body, dict) else None
        # 5-page cursor walk ids
        ids, cursor = [], None
        for _ in range(5):
            url = "/api/books?sortBy=title&sortOrder=asc&limit=50&includeTotal=0"
            if cursor:
                url += f"&cursor={urllib.parse.quote(cursor, safe='')}"
            st, body, _, _, _ = http_get(server.port, url, conn=conn)
            if st != 200 or not isinstance(body, dict):
                ids.append(None)
                break
            ids.append([b["id"] for b in body.get("items", [])])
            cursor = body.get("nextCursor")
            if not cursor:
                break
        cap["walk_page_ids"] = ids
        for key in ("broad_query", "narrow_query", "miss_query"):
            q = urllib.parse.quote(probes[key])
            st, body, _, _, _ = http_get(server.port, f"/api/books/search?q={q}&limit=50", conn=conn)
            cap[f"search_{key}_ids"] = (
                sorted(b["id"] for b in body.get("items", [])) if isinstance(body, dict) and st == 200 else None
            )
            cap[f"search_{key}_total"] = body.get("total") if isinstance(body, dict) else None
    finally:
        conn.close()
    return cap


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------


def pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def summarize(phases: list[PhaseResult]) -> dict:
    by_key: dict[tuple, list[PhaseResult]] = {}
    for ph in phases:
        by_key.setdefault((ph.phase, ph.concurrency), []).append(ph)
    out = {}
    for (phase, conc), group in sorted(by_key.items()):
        lats = sorted(x for ph in group for x in ph.lat_ms)
        total_req = sum(ph.count for ph in group)
        errors = sum(ph.errors + ph.non200 for ph in group)
        rps_list = [ph.count / ph.wall_s for ph in group if ph.wall_s > 0]
        avg_bytes = [ph.bytes_total / ph.count for ph in group if ph.count]
        out[f"{phase}@c{conc}"] = {
            "rounds": len(group),
            "requests": total_req,
            "errors": errors,
            "p50_ms": round(pct(lats, 0.50), 3),
            "p95_ms": round(pct(lats, 0.95), 3),
            "mean_ms": round(statistics.mean(lats), 3) if lats else 0,
            "min_ms": round(lats[0], 3) if lats else 0,
            "max_ms": round(lats[-1], 3) if lats else 0,
            "rps_mean": round(statistics.mean(rps_list), 1) if rps_list else 0,
            "rss_peak_kb": max(ph.rss_peak_kb for ph in group),
            "avg_body_bytes": round(statistics.mean(avg_bytes)) if avg_bytes else 0,
        }
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--books", type=int, default=100_000)
    ap.add_argument("--seed", type=int, default=20261018)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--concurrency", default="1,16")
    ap.add_argument("--req-c1", type=int, default=50, help="requests per scenario/round at c=1")
    ap.add_argument("--req-c16", type=int, default=320, help="total requests per scenario/round at c=16")
    ap.add_argument("--walk-pages", type=int, default=10)
    ap.add_argument("--fixture-root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--outdir", type=Path, default=REPO / "docs/rust")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--regen-fixture", action="store_true")
    ap.add_argument("--backends", default="rust,bun")
    args = ap.parse_args()

    conc_levels = [int(c) for c in args.concurrency.split(",")]
    backends = args.backends.split(",")
    run_id = time.strftime("%Y%m%d-%H%M%S")
    run_dir = args.fixture_root / f"run-{run_id}"
    fixture_dir = args.fixture_root / f"fixture-{args.books}-{args.seed}"
    args.outdir.mkdir(parents=True, exist_ok=True)

    print(f"== caliber backend benchmark (run {run_id}) ==")
    env_info = collect_env()

    # 1. Fixture --------------------------------------------------------------
    manifest = {"seed": args.seed, "books": args.books, "generator": f"scripts/benchmark-backends.py v{SCRIPT_VERSION}"}
    manifest_path = fixture_dir / "manifest.json"
    if manifest_path.exists() and not args.regen_fixture and json.loads(manifest_path.read_text()) == manifest:
        print(f"fixture: reusing {fixture_dir}")
    else:
        print(f"fixture: generating {args.books} books (seed {args.seed}) at {fixture_dir}")
        generate_fixture(fixture_dir, args.books, args.seed)
        manifest_path.write_text(json.dumps(manifest, indent=2))
    db_path = fixture_dir / "metadata.db"
    probes = None
    db = sqlite3.connect(db_path)
    first_title = db.execute("SELECT title FROM books WHERE id=1").fetchone()[0]
    probes = {
        "first_title": first_title,
        "broad_query": "golden",
        "narrow_query": first_title.lower(),
        "miss_query": "zzzqxvnope",
        "tag_ids": [r[0] for r in db.execute("SELECT id FROM tags ORDER BY id")],
    }
    fixture_info = {
        "path": str(db_path),
        "seed": args.seed,
        "books": db.execute("SELECT COUNT(*) FROM books").fetchone()[0],
        "authors": db.execute("SELECT COUNT(*) FROM authors").fetchone()[0],
        "series": db.execute("SELECT COUNT(*) FROM series").fetchone()[0],
        "tags": db.execute("SELECT COUNT(*) FROM tags").fetchone()[0],
        "size_bytes": db_path.stat().st_size,
        "sha256": sha256_file(db_path),
        "probe_queries": {k: v for k, v in probes.items() if k != "tag_ids"},
    }
    db.close()
    print(f"fixture: {fixture_info['books']} books, {fixture_info['size_bytes'] / 1e6:.1f} MB db")

    # 2. Build Rust release -----------------------------------------------------
    build_info = {"command": "cargo build --release", "skipped": args.skip_build}
    if not args.skip_build:
        t0 = time.time()
        r = subprocess.run(["cargo", "build", "--release"], cwd=REPO, capture_output=True, text=True)
        build_info["exit"] = r.returncode
        build_info["wall_s"] = round(time.time() - t0, 1)
        if r.returncode != 0:
            print(r.stdout[-4000:])
            print(r.stderr[-4000:])
            return 1
        print(f"build: cargo build --release ok in {build_info['wall_s']}s")
    if not (REPO / "target/release/caliber-server").exists():
        print("ERROR: target/release/caliber-server missing")
        return 1

    results = {
        "meta": env_info,
        "fixture": fixture_info,
        "build": build_info,
        "config": {
            "rounds": args.rounds,
            "concurrency": conc_levels,
            "req_per_scenario_c1": args.req_c1,
            "req_per_scenario_c16": args.req_c16,
            "walk_pages": args.walk_pages,
            "api_cache": "LRU 100 entries, 60s TTL (both backends); search never cached",
            "note": "same fixture db read-only; separate CALIBER_CONFIG_DIR per backend; defaults otherwise",
        },
        "startup": [],
        "phases": [],
        "semantic": {},
        "captures": {},
        "aggregates": {},
    }

    tag_ids = probes["tag_ids"]

    def tag_pair_url(salt: int):
        """Unique tag-pair per request index -> guaranteed LRU cache miss."""

        def url(i: int) -> str:
            n = salt + i
            a = tag_ids[(n // len(tag_ids)) % len(tag_ids)]
            b = tag_ids[n % len(tag_ids)]
            if a == b:
                b = tag_ids[(n + 1) % len(tag_ids)]
            return f"/api/books?tag={a}&tag={b}&limit=50&includeTotal=0"

        return url

    q_broad = urllib.parse.quote(probes["broad_query"])
    q_narrow = urllib.parse.quote(probes["narrow_query"])
    q_miss = urllib.parse.quote(probes["miss_query"])

    servers: dict[str, Server] = {}
    captures: dict[str, dict] = {}
    try:
        # 3. Cold boot (fresh cache) + semantic capture per backend ---------------
        for be in backends:
            srv = Server(be, fixture_dir, args.fixture_root / f"cache-{be}-{run_id}", run_dir)
            servers[be] = srv
            print(f"[{be}] cold boot (empty cache dir)...")
            info = srv.start(cold=True)
            conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=60.0)
            _, _, lat_cold, _, _ = http_get(srv.port, "/api/stats", conn=conn)  # genuine LRU miss
            _, _, lat_warm, _, _ = http_get(srv.port, "/api/stats", conn=conn)  # immediate HIT
            conn.close()
            info["stats_cold_miss_ms"] = round(lat_cold, 3)
            info["stats_warm_hit_ms"] = round(lat_warm, 3)
            snap = srv.sampler.snapshot()
            info["rss_peak_during_boot_kb"] = snap["__global_peak_kb__"]
            info["rss_boot_timeline"] = [[round(t, 3), v] for (t, v) in srv.sampler.timeline]
            info["cache_files_after_boot"] = [
                [str(p.relative_to(srv.cache_dir)), p.stat().st_size]
                for p in sorted(srv.cache_dir.rglob("*"))
                if p.is_file()
            ]
            results["startup"].append({"backend": be, **info})
            print(
                f"[{be}] cold: health={info['t_health_s']}s ready={info['t_db_ready_s']}s "
                f"boot_rss_peak={info['rss_peak_during_boot_kb']}KB stats_miss={info['stats_cold_miss_ms']}ms"
            )
            captures[be] = semantic_capture(srv, probes)
            srv.stop()
        results["captures"] = captures

        if len(captures) == 2:
            a, b = captures[backends[0]], captures[backends[1]]
            results["semantic"] = {
                "stats_payload_equal": a["stats"] == b["stats"],
                "stats_value": a["stats"],
                "first_page_ids_equal": a["first_page_ids"] == b["first_page_ids"],
                "first_page_etag_equal": a["first_page_etag"] == b["first_page_etag"],
                "first_page_body_sha256_rust": a["first_page_body_sha256"],
                "first_page_body_sha256_bun": b["first_page_body_sha256"],
                "tag_page_ids_equal": a["tag_page_ids"] == b["tag_page_ids"],
                "tag_page_total": a["tag_page_total"],
                "walk_page_ids_equal": a["walk_page_ids"] == b["walk_page_ids"],
                "search_broad_ids_equal": a["search_broad_query_ids"] == b["search_broad_query_ids"],
                "search_narrow_ids_equal": a["search_narrow_query_ids"] == b["search_narrow_query_ids"],
                "search_miss_ids_equal": a["search_miss_query_ids"] == b["search_miss_query_ids"],
                "search_broad_total": a["search_broad_query_total"],
                "search_narrow_total": a["search_narrow_query_total"],
                "search_miss_total": a["search_miss_query_total"],
            }
            print("semantic:", json.dumps(results["semantic"], default=str)[:400])

        # 4. Load rounds, alternating order to cancel drift ------------------------
        for rnd in range(1, args.rounds + 1):
            order = list(backends) if rnd % 2 == 1 else list(reversed(backends))
            print(f"-- round {rnd}/{args.rounds} order={order}")
            salt = rnd * 100000
            scenarios = [
                ("health", lambda i: "/api/health", False),
                ("stats_hit", lambda i: "/api/stats", True),
                ("books_first_page_hit", lambda i: "/api/books?sortBy=title&sortOrder=asc&limit=50", True),
                ("books_tag_pair_miss", tag_pair_url(salt), False),
                ("search_broad", lambda i: f"/api/books/search?q={q_broad}&limit=50", False),
                ("search_narrow", lambda i: f"/api/books/search?q={q_narrow}&limit=50", False),
                ("search_miss_zero", lambda i: f"/api/books/search?q={q_miss}&limit=50", False),
            ]
            for be in order:
                srv = servers[be]
                info = srv.start(cold=False)  # warm cache dir from cold boot
                conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=30.0)
                http_get(srv.port, "/api/health", conn=conn)
                http_get(srv.port, "/api/books?limit=5", conn=conn)
                time.sleep(0.5)
                idle = statistics.median([rss_kb(srv.proc.pid) for _ in range(5)])
                info["idle_rss_kb"] = int(idle)
                results["startup"].append({"backend": be, "round": rnd, **info})
                for name, url_fn, warm in scenarios:  # untimed warm-up for HIT scenarios
                    if warm:
                        http_get(srv.port, url_fn(0), conn=conn)
                conn.close()

                for name, url_fn, _warm in scenarios:
                    for c in conc_levels:
                        n = args.req_c1 if c == 1 else args.req_c16
                        ph = run_phase(srv, rnd, name, url_fn, c, n)
                        results["phases"].append(ph)
                        s = summarize([ph])[f"{name}@c{c}"]
                        print(
                            f"[{be}] r{rnd} {name}@c{c}: n={ph.count} err={ph.errors + ph.non200} "
                            f"p50={s['p50_ms']}ms p95={s['p95_ms']}ms rps={s['rps_mean']} peak={ph.rss_peak_kb}KB"
                        )
                if 1 in conc_levels:
                    ph = run_walk(srv, rnd, args.walk_pages)
                    results["phases"].append(ph)
                    s = summarize([ph])["pagination_walk@c1"]
                    print(
                        f"[{be}] r{rnd} pagination_walk: pages={ph.count} err={ph.errors} "
                        f"p50={s['p50_ms']}ms p95={s['p95_ms']}ms"
                    )
                srv.stop()

        for be in backends:
            results["aggregates"][be] = summarize([p for p in results["phases"] if p.backend == be])

    finally:
        for srv in servers.values():
            srv.stop()

    results["phases"] = [p.__dict__ for p in results["phases"]]
    json_path = args.outdir / "benchmark-results.json"
    json_path.write_text(json.dumps(results, indent=2, default=str))
    print(f"\nwrote {json_path}")
    print(json.dumps(results["aggregates"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
