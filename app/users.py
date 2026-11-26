"""The people who use Album Viewer: their accounts, their sign-in sessions, and the one-time codes
that hand a sign-in from the browser to the Android app.

Anyone can sign in with Google or Spotify and gets an account (and a shelf) of their own. The
person who runs the server is the admin: the account that existed before there were accounts
(created on first start) or whoever signs in with Google as ADMIN_EMAIL. Only the admin sees the
server's music folder and manages the library and the demo shelf.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

from . import config, db

SESSION_DAYS = 365
APP_CODE_SECONDS = 120


def _h(value: str) -> str:
    """Tokens and codes are stored hashed: a copy of the database signs no one in."""
    return hashlib.sha256(value.encode()).hexdigest()


def get(uid: int) -> dict | None:
    return db.one("SELECT * FROM users WHERE id=?", (uid,))


def owner() -> dict | None:
    return db.one("SELECT * FROM users WHERE admin=1 ORDER BY id LIMIT 1")


def public(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"] or "", "email": u["email"] or "", "picture": u["picture"] or "",
            "admin": bool(u["admin"]), "google": bool(u["google_sub"]), "spotify_id": u["spotify_id"]}


def ensure_owner() -> int:
    """The admin account. On first start it takes over what the single-user version kept: the
    Spotify sign-in, the Spotify albums on the shelf, the hidden albums and the manual order."""
    row = owner()
    if row:
        return row["id"]
    now = time.time()
    with db.tx() as c:
        uid = c.execute("INSERT INTO users(name, admin, created_at, seen_at) VALUES('', 1, ?, ?)", (now, now)).lastrowid
        kv = {r["key"]: r["value"] for r in db.query("SELECT key, value FROM kv WHERE key IN "
                                                       "('spotify_access_token','spotify_refresh_token','spotify_expires_at','order')")}
        if kv.get("spotify_refresh_token"):
            c.execute("INSERT OR REPLACE INTO spotify_auth(user_id, access_token, refresh_token, expires_at) VALUES(?,?,?,?)",
                      (uid, kv.get("spotify_access_token"), kv["spotify_refresh_token"], float(kv.get("spotify_expires_at") or 0)))
        c.execute("INSERT OR IGNORE INTO shelf(user_id, album_id, added_at, pinned, seen) "
                  "SELECT ?, id, added_at, pinned, 1 FROM albums WHERE source='spotify'", (uid,))
        c.execute("INSERT OR IGNORE INTO hidden(user_id, album_id) SELECT ?, id FROM albums WHERE hidden=1", (uid,))
        if kv.get("order"):
            c.execute("INSERT OR REPLACE INTO kv(key, value) VALUES(?, ?)", (f"order:{uid}", kv["order"]))
        c.execute("DELETE FROM kv WHERE key IN ('spotify_access_token','spotify_refresh_token','spotify_expires_at','order')")
    return uid


def _is_admin_email(email: str) -> bool:
    return bool(config.ADMIN_EMAIL) and email.lower() == config.ADMIN_EMAIL


def from_google(claims: dict) -> dict:
    """The account for a Google sign-in, made on the first one."""
    sub, email = str(claims["sub"]), str(claims.get("email") or "").lower()
    name, picture = claims.get("name") or email.split("@")[0], claims.get("picture") or ""
    now = time.time()
    row = db.one("SELECT * FROM users WHERE google_sub=?", (sub,))
    if not row and _is_admin_email(email):
        o = owner()
        if o and not o["google_sub"]:
            row = o   # the owner's first Google sign-in: it becomes theirs
    with db.tx() as c:
        if row:
            c.execute("UPDATE users SET google_sub=?, email=?, name=?, picture=?, seen_at=?, admin=MAX(admin, ?) WHERE id=?",
                      (sub, email, name, picture, now, 1 if _is_admin_email(email) else 0, row["id"]))
            uid = row["id"]
        else:
            uid = c.execute("INSERT INTO users(google_sub, email, name, picture, admin, created_at, seen_at) VALUES(?,?,?,?,?,?,?)",
                            (sub, email, name, picture, 1 if _is_admin_email(email) else 0, now, now)).lastrowid
    return get(uid)


def by_spotify(spotify_id: str) -> dict | None:
    return db.one("SELECT * FROM users WHERE spotify_id=?", (spotify_id,))


def from_spotify(profile: dict) -> dict:
    """The account for a Spotify sign-in, made on the first one."""
    sid = str(profile["id"])
    name = profile.get("display_name") or sid
    picture = ((profile.get("images") or [{}])[0] or {}).get("url") or ""
    now = time.time()
    row = by_spotify(sid)
    with db.tx() as c:
        if row:
            c.execute("UPDATE users SET name=COALESCE(NULLIF(name, ''), ?), picture=COALESCE(NULLIF(picture, ''), ?), seen_at=? WHERE id=?",
                      (name, picture, now, row["id"]))
            uid = row["id"]
        else:
            uid = c.execute("INSERT INTO users(spotify_id, name, picture, admin, created_at, seen_at) VALUES(?,?,?,0,?,?)",
                            (sid, name, picture, now, now)).lastrowid
    return get(uid)


def link_spotify(uid: int, profile: dict) -> None:
    """Connect a Spotify account to someone signed in another way. Raises ValueError if that
    Spotify account already belongs to someone else here."""
    sid = str(profile["id"])
    other = by_spotify(sid)
    if other and other["id"] != uid:
        raise ValueError("That Spotify account is already connected to another Album Viewer account.")
    with db.tx() as c:
        c.execute("UPDATE users SET spotify_id=?, name=COALESCE(NULLIF(name, ''), ?), picture=COALESCE(NULLIF(picture, ''), ?) WHERE id=?",
                  (sid, profile.get("display_name") or sid, ((profile.get("images") or [{}])[0] or {}).get("url") or "", uid))


def set_spotify_id(uid: int, sid: str) -> None:
    if not by_spotify(sid):
        with db.tx() as c:
            c.execute("UPDATE users SET spotify_id=? WHERE id=? AND spotify_id IS NULL", (sid, uid))


# ---------------------------------------------------------------- sessions

def new_session(uid: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.tx() as c:
        c.execute("INSERT INTO sessions(token, user_id, created_at, seen_at) VALUES(?,?,?,?)", (_h(token), uid, now, now))
    return token


def from_session(token: str | None) -> dict | None:
    if not token or len(token) > 200:
        return None
    row = db.one("SELECT u.*, s.created_at AS s_created, s.seen_at AS s_seen FROM sessions s "
                 "JOIN users u ON u.id=s.user_id WHERE s.token=?", (_h(token),))
    if not row:
        return None
    now = time.time()
    if now - row["s_created"] > SESSION_DAYS * 86400:
        end_session(token)
        return None
    if now - (row["s_seen"] or 0) > 3600:   # now and then, not on every request
        with db.tx() as c:
            c.execute("UPDATE sessions SET seen_at=? WHERE token=?", (now, _h(token)))
            c.execute("UPDATE users SET seen_at=? WHERE id=?", (now, row["id"]))
    return row


def end_session(token: str | None) -> None:
    if token:
        with db.tx() as c:
            c.execute("DELETE FROM sessions WHERE token=?", (_h(token),))


# ---------------------------------------------------------------- handing a sign-in to the app

def challenge_of(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def new_app_code(uid: int, challenge: str) -> str:
    """A one-time code the browser passes to the Android app. Only the app that started the
    sign-in can use it: it must show the secret whose hash (`challenge`) it sent at the start."""
    code = secrets.token_urlsafe(24)
    with db.tx() as c:
        c.execute("DELETE FROM app_codes WHERE expires_at < ?", (time.time(),))
        c.execute("INSERT INTO app_codes(code, user_id, challenge, expires_at) VALUES(?,?,?,?)",
                  (_h(code), uid, challenge, time.time() + APP_CODE_SECONDS))
    return code


def redeem_app_code(code: str, verifier: str) -> int | None:
    row = db.one("SELECT * FROM app_codes WHERE code=?", (_h(code or ""),))
    with db.tx() as c:   # used once, whatever happens
        c.execute("DELETE FROM app_codes WHERE code=?", (_h(code or ""),))
    if not row or row["expires_at"] < time.time() or not verifier:
        return None
    if not hmac.compare_digest(challenge_of(verifier), row["challenge"]):
        return None
    return row["user_id"]


# ---------------------------------------------------------------- per-person shelf settings

def order(uid: int) -> list[str]:
    try:
        return json.loads(db.kv_get(f"order:{uid}") or "[]")
    except ValueError:
        return []


def set_order(uid: int, ids: list[str]) -> None:
    db.kv_set(f"order:{uid}", json.dumps(ids))
