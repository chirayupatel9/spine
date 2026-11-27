import sqlite3
import threading
from contextlib import contextmanager

from .config import DB_PATH

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- 'local' | 'spotify' | 'youtube' | 'demo'
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    year TEXT,
    uri TEXT,                        -- spotify:album:..., youtube:playlist:..., youtube:video:..., youtube:liked
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

-- people, and what is theirs
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE,          -- Google's id for them, once they sign in with Google
    spotify_id TEXT UNIQUE,          -- their Spotify user id, once they sign in with or connect Spotify
    email TEXT,
    name TEXT,
    picture TEXT,
    admin INTEGER DEFAULT 0,         -- runs the server: sees the music folder, manages library and demo
    created_at REAL,
    seen_at REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,          -- SHA-256 of the cookie
    user_id INTEGER NOT NULL,
    created_at REAL,
    seen_at REAL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS spotify_auth (
    user_id INTEGER PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at REAL
);
CREATE TABLE IF NOT EXISTS youtube_auth (   -- read-only YouTube access each person gave (see youtube.py)
    user_id INTEGER PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at REAL,
    channel TEXT,                    -- their YouTube channel's name; '' if the account has none
    connected_at REAL
);
CREATE TABLE IF NOT EXISTS shelf (   -- the Spotify and YouTube albums and playlists on each person's shelf
    user_id INTEGER NOT NULL,
    album_id TEXT NOT NULL,
    added_at REAL,
    pinned INTEGER DEFAULT 0,        -- added by link: kept through syncs
    seen INTEGER DEFAULT 1,
    PRIMARY KEY (user_id, album_id)
);
CREATE INDEX IF NOT EXISTS idx_shelf_album ON shelf(album_id);
CREATE TABLE IF NOT EXISTS hidden (  -- albums each person has hidden
    user_id INTEGER NOT NULL,
    album_id TEXT NOT NULL,
    PRIMARY KEY (user_id, album_id)
);
CREATE TABLE IF NOT EXISTS oauth_flows (   -- a sign-in in progress with Google or Spotify
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    verifier TEXT,                   -- PKCE secret (Google)
    user_id INTEGER,                 -- connecting Spotify to this account, rather than signing in
    app_challenge TEXT,              -- started by the Android app: hand the sign-in back to it
    app INTEGER DEFAULT 0,           -- connecting Spotify from the Android app: go back to it after
    expires_at REAL
);
CREATE TABLE IF NOT EXISTS app_codes (     -- one-time codes passing a sign-in to the Android app
    code TEXT PRIMARY KEY,           -- SHA-256 of the code
    user_id INTEGER NOT NULL,
    challenge TEXT NOT NULL,
    expires_at REAL
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


_conn = _connect()
_conn.executescript(SCHEMA)


def _migrate() -> None:
    cols = {r[1] for r in _conn.execute("PRAGMA table_info(albums)")}
    for name, ddl in (("kind", "TEXT DEFAULT 'album'"),   # 'album' | 'playlist'
                      ("track_count", "INTEGER"),          # playlists: Spotify's count (their tracks load on demand)
                      ("snapshot", "TEXT")):               # playlists: Spotify's version of its contents
        if name not in cols:
            _conn.execute(f"ALTER TABLE albums ADD COLUMN {name} {ddl}")
    if "app" not in {r[1] for r in _conn.execute("PRAGMA table_info(oauth_flows)")}:
        _conn.execute("ALTER TABLE oauth_flows ADD COLUMN app INTEGER DEFAULT 0")
    cols = {r[1] for r in _conn.execute("PRAGMA table_info(tracks)")}
    for name in ("kids", "noembed"):   # YouTube: made for kids; won't play outside YouTube
        if name not in cols:
            _conn.execute(f"ALTER TABLE tracks ADD COLUMN {name} INTEGER DEFAULT 0")


_migrate()
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
