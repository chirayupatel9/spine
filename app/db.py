import sqlite3
import threading
from contextlib import contextmanager

from .config import DB_PATH

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- 'local' | 'spotify'
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    year TEXT,
    uri TEXT,                        -- spotify:album:...
    remote_art TEXT,                 -- spotify image url
    art_file TEXT,                   -- cached file name in ART_DIR
    art_status TEXT DEFAULT 'pending', -- pending | ok | missing
    art_source TEXT,                 -- embedded | folder | itunes | musicbrainz | spotify | manual
    color TEXT,
    text_color TEXT,
    folder TEXT,
    added_at REAL,
    hidden INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    seen INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    track_no INTEGER,
    disc_no INTEGER,
    duration REAL,
    path TEXT,
    mtime REAL,
    uri TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


_conn = _connect()
_conn.executescript(SCHEMA)
_conn.commit()


@contextmanager
def tx():
    with _lock:
        try:
            yield _conn
            _conn.commit()
        except Exception:
            _conn.rollback()
            raise


def query(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    rows = query(sql, args)
    return rows[0] if rows else None


def kv_get(key: str) -> str | None:
    row = one("SELECT value FROM kv WHERE key=?", (key,))
    return row["value"] if row else None


def kv_set(key: str, value: str | None) -> None:
    with tx() as c:
        if value is None:
            c.execute("DELETE FROM kv WHERE key=?", (key,))
        else:
            c.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
