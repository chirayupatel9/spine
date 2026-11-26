"""Spotify, for each person: OAuth (authorization code + refresh), syncing their saved albums and
playlists onto their shelf, and controlling their playback.

Albums and playlists are stored once (the `albums` table, ids sp_… and pl_…); the `shelf` table
says whose shelf each is on. Spotify shares a playlist's tracks only with its owner and
collaborators, so other playlists can be played but not listed.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
from datetime import datetime
from urllib.parse import urlencode

import httpx

from . import artwork, db, users
from .config import SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI

log = logging.getLogger("albumviewer.spotify")

API = "https://api.spotify.com/v1"
SCOPES = " ".join([
    "user-library-read",
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "streaming",          # Web Playback SDK (browser as a speaker)
    "user-read-private",
])

_http = httpx.Client(timeout=20)
_token_lock = threading.Lock()
_status: dict[int, dict] = {}


class SpotifyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)


def connected(uid: int) -> bool:
    return bool(db.one("SELECT 1 AS ok FROM spotify_auth WHERE user_id=? AND refresh_token IS NOT NULL", (uid,)))


def status(uid: int) -> dict:
    return _status.setdefault(uid, {"syncing": False, "albums": 0, "last_sync": None, "error": None})


def authorize_url(state: str) -> str:
    return "https://accounts.spotify.com/authorize?" + urlencode({
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
        "show_dialog": "true",   # so someone else on the same browser can pick their own account
    })


def _basic() -> str:
    return base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()


def exchange_code(code: str) -> dict:
    """Tokens for the account that just approved Album Viewer."""
    r = _http.post("https://accounts.spotify.com/api/token",
                   data={"grant_type": "authorization_code", "code": code, "redirect_uri": SPOTIFY_REDIRECT_URI},
                   headers={"Authorization": f"Basic {_basic()}"})
    if r.status_code != 200:
        raise SpotifyError(r.status_code, f"Token exchange failed: {r.text}")
    return r.json()


def me(access_token: str) -> dict:
    """The profile behind a token. Spotify answers 403 for accounts the app's owner hasn't added in
    the Spotify developer dashboard (apps in development mode only work for those)."""
    r = _http.get(API + "/me", headers={"Authorization": f"Bearer {access_token}"})
    if r.status_code == 403:
        raise SpotifyError(403, "This Spotify account isn't on Album Viewer's list yet. The owner adds people "
                                "under User Management in the Spotify developer dashboard.")
    if r.status_code != 200:
        raise SpotifyError(r.status_code, f"Spotify didn't share the profile ({r.status_code})")
    return r.json()


def store_tokens(uid: int, data: dict) -> None:
    with db.tx() as c:
        c.execute("""INSERT INTO spotify_auth(user_id, access_token, refresh_token, expires_at) VALUES(?,?,?,?)
                     ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token, expires_at=excluded.expires_at,
                       refresh_token=COALESCE(excluded.refresh_token, spotify_auth.refresh_token)""",
                  (uid, data["access_token"], data.get("refresh_token"), time.time() + int(data.get("expires_in", 3600)) - 60))


def disconnect(uid: int) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM spotify_auth WHERE user_id=?", (uid,))
        c.execute("DELETE FROM shelf WHERE user_id=?", (uid,))
        c.execute("UPDATE users SET spotify_id=NULL WHERE id=? AND (google_sub IS NOT NULL OR admin=1)", (uid,))
    prune()


def access_token(uid: int) -> str:
    with _token_lock:
        row = db.one("SELECT * FROM spotify_auth WHERE user_id=?", (uid,))
        if not row or not row["refresh_token"]:
            raise SpotifyError(401, "Spotify not connected")
        if row["access_token"] and time.time() < (row["expires_at"] or 0):
            return row["access_token"]
        r = _http.post("https://accounts.spotify.com/api/token",
                       data={"grant_type": "refresh_token", "refresh_token": row["refresh_token"]},
                       headers={"Authorization": f"Basic {_basic()}"})
        if r.status_code != 200:
            if r.status_code in (400, 401):   # revoked: forget it, so the app offers to connect again
                with db.tx() as c:
                    c.execute("DELETE FROM spotify_auth WHERE user_id=?", (uid,))
            raise SpotifyError(r.status_code, f"Token refresh failed: {r.text}")
        store_tokens(uid, r.json())
        return db.one("SELECT access_token FROM spotify_auth WHERE user_id=?", (uid,))["access_token"]


def api(uid: int, method: str, path: str, **kw) -> dict | None:
    url = path if path.startswith("http") else API + path
    for attempt in range(3):
        r = _http.request(method, url, headers={"Authorization": f"Bearer {access_token(uid)}"}, **kw)
        if r.status_code == 429:
            time.sleep(min(int(r.headers.get("Retry-After", "2")), 30))
            continue
        if r.status_code == 401 and attempt == 0:
            with db.tx() as c:
                c.execute("UPDATE spotify_auth SET expires_at=0 WHERE user_id=?", (uid,))
            continue
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except Exception:
                msg = r.text
            raise SpotifyError(r.status_code, msg)
        if r.status_code == 204 or not r.content:
            return None
        return r.json()
    raise SpotifyError(429, "Rate limited by Spotify")


# ---------------------------------------------------------------- the shelf: albums and playlists

def _upsert_album(alb: dict) -> str:
    aid = "sp_" + alb["id"]
    images = alb.get("images") or []
    year = (alb.get("release_date") or "")[:4] or None
    artist = ", ".join(a["name"] for a in alb.get("artists", [])) or "Unknown Artist"
    with db.tx() as c:
        c.execute(
            """INSERT INTO albums(id, source, kind, title, artist, year, uri, remote_art, added_at, seen)
               VALUES(?, 'spotify', 'album', ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, year=excluded.year,
                 uri=excluded.uri, remote_art=excluded.remote_art""",
            (aid, alb["name"], artist, year, alb["uri"], images[0]["url"] if images else None, time.time()),
        )
        items = (alb.get("tracks") or {}).get("items") or []
        if items:
            c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))
            c.executemany(
                "INSERT OR REPLACE INTO tracks(id, album_id, title, artist, track_no, disc_no, duration, uri) VALUES(?,?,?,?,?,?,?,?)",
                [("sp_" + t["id"], aid, t["name"], ", ".join(a["name"] for a in t.get("artists", [])),
                  t.get("track_number"), t.get("disc_number", 1), (t.get("duration_ms") or 0) / 1000, t["uri"])
                 for t in items if t.get("id")],
            )
    return aid


def _upsert_playlist(pl: dict) -> str:
    aid = "pl_" + pl["id"]
    images = pl.get("images") or []
    art = images[0]["url"] if images else None
    owner = (pl.get("owner") or {}).get("display_name") or (pl.get("owner") or {}).get("id") or "Spotify"
    total = (pl.get("items") or pl.get("tracks") or {}).get("total")   # 'tracks' before Spotify's 2026 rename
    old = db.one("SELECT snapshot, remote_art FROM albums WHERE id=?", (aid,))
    with db.tx() as c:
        c.execute(
            """INSERT INTO albums(id, source, kind, title, artist, uri, remote_art, track_count, snapshot, added_at, seen)
               VALUES(?, 'spotify', 'playlist', ?, ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, uri=excluded.uri,
                 remote_art=excluded.remote_art, track_count=excluded.track_count, snapshot=excluded.snapshot""",
            (aid, pl.get("name") or "Playlist", owner, pl.get("uri"), art, total, pl.get("snapshot_id"), time.time()),
        )
        if old and old["remote_art"] != art:    # its mosaic changes as its tracks do
            c.execute("UPDATE albums SET art_status='pending' WHERE id=?", (aid,))
        if old and old["snapshot"] != pl.get("snapshot_id"):
            c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))   # listed again when next opened
    return aid


def _shelve(uid: int, aid: str, added_at: float | None, pinned: bool = False) -> None:
    with db.tx() as c:
        c.execute("""INSERT INTO shelf(user_id, album_id, added_at, pinned, seen) VALUES(?,?,?,?,1)
                     ON CONFLICT(user_id, album_id) DO UPDATE SET seen=1, pinned=MAX(shelf.pinned, excluded.pinned),
                       added_at=COALESCE(excluded.added_at, shelf.added_at)""",
                  (uid, aid, added_at or time.time(), 1 if pinned else 0))


def prune() -> None:
    """Forget Spotify albums and playlists that are no longer on anyone's shelf."""
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id IN (SELECT id FROM albums WHERE source='spotify' "
                  "AND id NOT IN (SELECT album_id FROM shelf))")
        c.execute("DELETE FROM albums WHERE source='spotify' AND id NOT IN (SELECT album_id FROM shelf)")


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iter_saved_albums(uid: int):
    """Yield (album, added_at). Uses /me/albums; falls back to grouping saved tracks."""
    try:
        url = "/me/albums?limit=50"
        while url:
            page = api(uid, "GET", url)
            for it in page.get("items", []):
                yield it["album"], _ts(it.get("added_at"))
            url = page.get("next")
        return
    except SpotifyError as e:
        if e.status not in (403, 404):
            raise
        log.warning("/me/albums unavailable (%s), falling back to saved tracks", e)
    seen = set()
    url = "/me/tracks?limit=50"
    while url:
        page = api(uid, "GET", url)
        for it in page.get("items", []):
            alb = (it.get("track") or {}).get("album")
            if alb and alb.get("id") and alb["id"] not in seen and alb.get("album_type") != "single":
                seen.add(alb["id"])
                yield alb, _ts(it.get("added_at"))
        url = page.get("next")


def _iter_playlists(uid: int):
    url = "/me/playlists?limit=50"
    while url:
        page = api(uid, "GET", url)
        for pl in page.get("items") or []:
            if pl and pl.get("id"):
                yield pl
        url = page.get("next")


def _learn_id(uid: int) -> None:
    u = users.get(uid)
    if u and not u["spotify_id"]:
        users.set_spotify_id(uid, str(api(uid, "GET", "/me")["id"]))


def sync(uid: int) -> None:
    st = status(uid)
    if st["syncing"] or not connected(uid):
        return
    st.update(syncing=True, error=None, albums=0)
    try:
        _learn_id(uid)
        with db.tx() as c:
            c.execute("UPDATE shelf SET seen=0 WHERE user_id=? AND pinned=0", (uid,))
        count = 0
        for alb, added in _iter_saved_albums(uid):
            if not (alb.get("tracks") or {}).get("items"):
                try:
                    alb = api(uid, "GET", f"/albums/{alb['id']}")
                except SpotifyError:
                    pass
            _shelve(uid, _upsert_album(alb), added)
            count += 1
            st["albums"] = count
        try:
            for pl in _iter_playlists(uid):
                _shelve(uid, _upsert_playlist(pl), None)
                count += 1
                st["albums"] = count
        except SpotifyError as e:   # e.g. connected before playlists were asked for: albums still sync
            log.warning("playlists unavailable for user %s (%s)", uid, e)
            with db.tx() as c:
                c.execute("UPDATE shelf SET seen=1 WHERE user_id=? AND album_id LIKE 'pl_%'", (uid,))
        with db.tx() as c:
            c.execute("DELETE FROM shelf WHERE user_id=? AND seen=0", (uid,))
        prune()
        cache_art()
        st["last_sync"] = time.time()
    except Exception as e:
        st["error"] = str(e)
        log.exception("spotify sync failed for user %s", uid)
    finally:
        st["syncing"] = False


def start_sync(uid: int) -> bool:
    if status(uid)["syncing"]:
        return False
    threading.Thread(target=sync, args=(uid,), daemon=True).start()
    return True


def sync_everyone() -> None:
    for row in db.query("SELECT user_id FROM spotify_auth WHERE refresh_token IS NOT NULL"):
        sync(row["user_id"])


def cache_art() -> None:
    """Download Spotify covers locally so spines get colours and load fast."""
    for row in db.query("SELECT id, remote_art FROM albums WHERE source='spotify' AND art_status!='ok' AND remote_art IS NOT NULL"):
        data = artwork.download(row["remote_art"])
        saved = artwork.save_art(row["id"], data) if data else None
        with db.tx() as c:
            if saved:
                c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source='spotify', color=?, text_color=? WHERE id=?",
                          (*saved, row["id"]))
            else:
                color, text = artwork.placeholder_color(row["id"])
                c.execute("UPDATE albums SET color=?, text_color=? WHERE id=?", (color, text, row["id"]))
    for row in db.query("SELECT id FROM albums WHERE source='spotify' AND color IS NULL"):   # playlists without a cover
        color, text = artwork.placeholder_color(row["id"])
        with db.tx() as c:
            c.execute("UPDATE albums SET color=?, text_color=? WHERE id=?", (color, text, row["id"]))


_LINK_RE = re.compile(r"(album|playlist)[/:]([A-Za-z0-9]{22})")


def add_by_link(uid: int, link: str) -> str:
    """An album or playlist added to someone's shelf by its Spotify link; kept through syncs."""
    m = _LINK_RE.search(link)
    if not m:
        raise SpotifyError(400, "Paste a Spotify album or playlist link, e.g. https://open.spotify.com/album/…")
    kind, sid = m.groups()
    aid = _upsert_album(api(uid, "GET", f"/albums/{sid}")) if kind == "album" else _upsert_playlist(api(uid, "GET", f"/playlists/{sid}"))
    _shelve(uid, aid, time.time(), pinned=True)
    cache_art()
    return aid


def playlist_tracks(uid: int, aid: str) -> tuple[list[dict], bool]:
    """A playlist's tracks, in order, and whether Spotify shares them with this person (only with
    the playlist's owner and collaborators). Kept until the playlist changes."""
    cols = "id, title, artist, track_no, disc_no, duration, uri"
    a = db.one("SELECT snapshot FROM albums WHERE id=?", (aid,))
    cached = db.query(f"SELECT {cols} FROM tracks WHERE album_id=? ORDER BY track_no", (aid,))
    if cached and a and db.kv_get(f"snapshot:{aid}") == (a["snapshot"] or ""):
        return cached, True
    pid, rows, url = aid[3:], [], f"/playlists/{aid[3:]}/items?limit=50"
    try:
        while url:
            page = api(uid, "GET", url) or {}
            for it in page.get("items") or []:
                t = (it or {}).get("item") or (it or {}).get("track") or {}
                pos = len(rows) + 1   # every entry keeps its place, so play offsets line up
                rows.append((f"pt_{pid}_{pos}", aid, t.get("name") or "Unavailable",
                             ", ".join(x.get("name", "") for x in t.get("artists") or []) or None,
                             pos, 1, (t.get("duration_ms") or 0) / 1000, t.get("uri")))
            url = page.get("next")
    except SpotifyError as e:
        if e.status in (403, 404):
            return [], False
        raise
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))
        c.executemany("INSERT OR REPLACE INTO tracks(id, album_id, title, artist, track_no, disc_no, duration, uri) "
                      "VALUES(?,?,?,?,?,?,?,?)", rows)
    db.kv_set(f"snapshot:{aid}", (a or {}).get("snapshot") or "")
    return db.query(f"SELECT {cols} FROM tracks WHERE album_id=? ORDER BY track_no", (aid,)), True


# ---------------------------------------------------------------- playback

def devices(uid: int) -> list[dict]:
    return (api(uid, "GET", "/me/player/devices") or {}).get("devices", [])


def state(uid: int) -> dict | None:
    s = api(uid, "GET", "/me/player?additional_types=track")
    if not s:
        return None
    item = s.get("item") or {}
    alb = item.get("album") or {}
    ctx = s.get("context") or {}
    m = re.match(r"spotify:(album|playlist):(\w+)$", ctx.get("uri") or "")
    # The album or playlist it's playing from, as it's called on the shelf.
    album_id = ("pl_" if m.group(1) == "playlist" else "sp_") + m.group(2) if m else ("sp_" + alb["id"] if alb.get("id") else None)
    return {
        "is_playing": s.get("is_playing"),
        "progress_ms": s.get("progress_ms"),
        "duration_ms": item.get("duration_ms"),
        "track": item.get("name"),
        "artist": ", ".join(a["name"] for a in item.get("artists", [])),
        "album_id": album_id,
        "album": alb.get("name"),
        "image": (alb.get("images") or [{}])[0].get("url"),
        "device": (s.get("device") or {}).get("name"),
        "device_id": (s.get("device") or {}).get("id"),
        "shuffle": s.get("shuffle_state"),
        "repeat": s.get("repeat_state"),
    }


def play(uid: int, context_uri: str | None = None, offset: int | None = None, device_id: str | None = None) -> None:
    body = {}
    if context_uri:
        body["context_uri"] = context_uri
        if offset is not None:
            body["offset"] = {"position": offset}
    q = f"?device_id={device_id}" if device_id else ""
    try:
        api(uid, "PUT", "/me/player/play" + q, content=json.dumps(body) if body else None)
    except SpotifyError as e:
        if e.status == 404 and not device_id:
            # no active device: wake the first available one
            devs = devices(uid)
            if not devs:
                raise SpotifyError(404, "No Spotify device found. Open Spotify on a phone/PC/speaker, or enable 'This screen' as a player.")
            api(uid, "PUT", f"/me/player/play?device_id={devs[0]['id']}", content=json.dumps(body) if body else None)
        else:
            raise


def control(uid: int, action: str, device_id: str | None = None, value=None) -> None:
    """Pause, resume, skip, seek (value = position in ms), shuffle (value = on/off) or
    repeat (value = off, context or track)."""
    q = {"device_id": device_id} if device_id else {}
    if action == "pause":
        api(uid, "PUT", "/me/player/pause", params=q)
    elif action == "resume":
        api(uid, "PUT", "/me/player/play", params=q)
    elif action == "next":
        api(uid, "POST", "/me/player/next", params=q)
    elif action == "previous":
        api(uid, "POST", "/me/player/previous", params=q)
    elif action == "seek":
        try:
            ms = max(0, int(float(value)))
        except (TypeError, ValueError):
            raise SpotifyError(400, "seek needs a position in milliseconds") from None
        api(uid, "PUT", "/me/player/seek", params={**q, "position_ms": ms})
    elif action == "shuffle":
        api(uid, "PUT", "/me/player/shuffle", params={**q, "state": "true" if value else "false"})
    elif action == "repeat":
        if value not in ("off", "context", "track"):
            raise SpotifyError(400, "repeat is off, context or track")
        api(uid, "PUT", "/me/player/repeat", params={**q, "state": value})
    else:
        raise SpotifyError(400, f"Unknown action {action}")


def transfer(uid: int, device_id: str, play_now: bool = True) -> None:
    api(uid, "PUT", "/me/player", content=json.dumps({"device_ids": [device_id], "play": play_now}))
