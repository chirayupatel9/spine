"""Spotify: OAuth (authorization code + refresh), saved-album sync, playback control."""
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

from . import artwork, db
from .config import SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI

log = logging.getLogger("albumviewer.spotify")

API = "https://api.spotify.com/v1"
SCOPES = " ".join([
    "user-library-read",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "streaming",          # Web Playback SDK (browser as a speaker)
    "user-read-email",
    "user-read-private",
])

_http = httpx.Client(timeout=20)
_token_lock = threading.Lock()
sync_status = {"syncing": False, "albums": 0, "last_sync": None, "error": None}


class SpotifyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)


def connected() -> bool:
    return bool(db.kv_get("spotify_refresh_token"))


def authorize_url(state: str) -> str:
    return "https://accounts.spotify.com/authorize?" + urlencode({
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
    })


def _basic() -> str:
    return base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()


def _store_tokens(data: dict) -> None:
    db.kv_set("spotify_access_token", data["access_token"])
    db.kv_set("spotify_expires_at", str(time.time() + int(data.get("expires_in", 3600)) - 60))
    if data.get("refresh_token"):
        db.kv_set("spotify_refresh_token", data["refresh_token"])


def exchange_code(code: str) -> None:
    r = _http.post("https://accounts.spotify.com/api/token",
                   data={"grant_type": "authorization_code", "code": code, "redirect_uri": SPOTIFY_REDIRECT_URI},
                   headers={"Authorization": f"Basic {_basic()}"})
    if r.status_code != 200:
        raise SpotifyError(r.status_code, f"Token exchange failed: {r.text}")
    _store_tokens(r.json())


def disconnect() -> None:
    for k in ("spotify_access_token", "spotify_expires_at", "spotify_refresh_token"):
        db.kv_set(k, None)


def access_token() -> str:
    with _token_lock:
        tok = db.kv_get("spotify_access_token")
        exp = float(db.kv_get("spotify_expires_at") or 0)
        if tok and time.time() < exp:
            return tok
        refresh = db.kv_get("spotify_refresh_token")
        if not refresh:
            raise SpotifyError(401, "Spotify not connected")
        r = _http.post("https://accounts.spotify.com/api/token",
                       data={"grant_type": "refresh_token", "refresh_token": refresh},
                       headers={"Authorization": f"Basic {_basic()}"})
        if r.status_code != 200:
            if r.status_code in (400, 401):
                disconnect()
            raise SpotifyError(r.status_code, f"Token refresh failed: {r.text}")
        _store_tokens(r.json())
        return db.kv_get("spotify_access_token")


def api(method: str, path: str, **kw) -> dict | None:
    url = path if path.startswith("http") else API + path
    for attempt in range(3):
        r = _http.request(method, url, headers={"Authorization": f"Bearer {access_token()}"}, **kw)
        if r.status_code == 429:
            time.sleep(min(int(r.headers.get("Retry-After", "2")), 30))
            continue
        if r.status_code == 401 and attempt == 0:
            db.kv_set("spotify_expires_at", "0")
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


# ---------------------------------------------------------------- library sync

def _upsert_album(alb: dict, added_at: float | None) -> str:
    aid = "sp_" + alb["id"]
    images = alb.get("images") or []
    year = (alb.get("release_date") or "")[:4] or None
    artist = ", ".join(a["name"] for a in alb.get("artists", [])) or "Unknown Artist"
    with db.tx() as c:
        c.execute(
            """INSERT INTO albums(id, source, title, artist, year, uri, remote_art, added_at, seen)
               VALUES(?, 'spotify', ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, year=excluded.year,
                 uri=excluded.uri, remote_art=excluded.remote_art, seen=1,
                 added_at=COALESCE(excluded.added_at, albums.added_at)""",
            (aid, alb["name"], artist, year, alb["uri"], images[0]["url"] if images else None, added_at or time.time()),
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


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iter_saved_albums():
    """Yield (album, added_at). Uses /me/albums; falls back to grouping saved tracks."""
    try:
        url = "/me/albums?limit=50"
        while url:
            page = api("GET", url)
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
        page = api("GET", url)
        for it in page.get("items", []):
            alb = (it.get("track") or {}).get("album")
            if alb and alb.get("id") and alb["id"] not in seen and alb.get("album_type") != "single":
                seen.add(alb["id"])
                yield alb, _ts(it.get("added_at"))
        url = page.get("next")


def sync() -> None:
    if sync_status["syncing"] or not connected():
        return
    sync_status.update(syncing=True, error=None)
    try:
        with db.tx() as c:
            c.execute("UPDATE albums SET seen=0 WHERE source='spotify' AND pinned=0")
        count = 0
        for alb, added in _iter_saved_albums():
            if not (alb.get("tracks") or {}).get("items"):
                try:
                    alb = api("GET", f"/albums/{alb['id']}")
                except SpotifyError:
                    pass
            _upsert_album(alb, added)
            count += 1
            sync_status["albums"] = count
        with db.tx() as c:
            # albums added manually by link are 'pinned' and survive syncs
            c.execute("DELETE FROM tracks WHERE album_id IN (SELECT id FROM albums WHERE source='spotify' AND seen=0)")
            c.execute("DELETE FROM albums WHERE source='spotify' AND seen=0")
        cache_art()
        sync_status["last_sync"] = time.time()
    except Exception as e:
        sync_status["error"] = str(e)
        log.exception("spotify sync failed")
    finally:
        sync_status["syncing"] = False


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


def start_sync() -> bool:
    if sync_status["syncing"]:
        return False
    threading.Thread(target=sync, daemon=True).start()
    return True


_ALBUM_RE = re.compile(r"(?:album[/:])([A-Za-z0-9]{22})")


def add_album_by_link(link: str) -> str:
    m = _ALBUM_RE.search(link)
    if not m:
        raise SpotifyError(400, "Paste a Spotify album link, e.g. https://open.spotify.com/album/…")
    alb = api("GET", f"/albums/{m.group(1)}")
    aid = _upsert_album(alb, time.time())
    with db.tx() as c:
        c.execute("UPDATE albums SET pinned=1 WHERE id=?", (aid,))
    cache_art()
    return aid


# ---------------------------------------------------------------- playback

def devices() -> list[dict]:
    return (api("GET", "/me/player/devices") or {}).get("devices", [])


def state() -> dict | None:
    s = api("GET", "/me/player?additional_types=track")
    if not s:
        return None
    item = s.get("item") or {}
    alb = item.get("album") or {}
    return {
        "is_playing": s.get("is_playing"),
        "progress_ms": s.get("progress_ms"),
        "duration_ms": item.get("duration_ms"),
        "track": item.get("name"),
        "artist": ", ".join(a["name"] for a in item.get("artists", [])),
        "album_id": "sp_" + alb["id"] if alb.get("id") else None,
        "album": alb.get("name"),
        "image": (alb.get("images") or [{}])[0].get("url"),
        "device": (s.get("device") or {}).get("name"),
        "device_id": (s.get("device") or {}).get("id"),
        "shuffle": s.get("shuffle_state"),
        "repeat": s.get("repeat_state"),
    }


def play(context_uri: str | None = None, offset: int | None = None, device_id: str | None = None) -> None:
    body = {}
    if context_uri:
        body["context_uri"] = context_uri
        if offset is not None:
            body["offset"] = {"position": offset}
    q = f"?device_id={device_id}" if device_id else ""
    try:
        api("PUT", "/me/player/play" + q, content=json.dumps(body) if body else None)
    except SpotifyError as e:
        if e.status == 404 and not device_id:
            # no active device: wake the first available one
            devs = devices()
            if not devs:
                raise SpotifyError(404, "No Spotify device found. Open Spotify on a phone/PC/speaker, or enable 'This screen' as a player.")
            api("PUT", f"/me/player/play?device_id={devs[0]['id']}", content=json.dumps(body) if body else None)
        else:
            raise


def control(action: str, device_id: str | None = None, value=None) -> None:
    """Pause, resume, skip, seek (value = position in ms), shuffle (value = on/off) or
    repeat (value = off, context or track)."""
    q = {"device_id": device_id} if device_id else {}
    if action == "pause":
        api("PUT", "/me/player/pause", params=q)
    elif action == "resume":
        api("PUT", "/me/player/play", params=q)
    elif action == "next":
        api("POST", "/me/player/next", params=q)
    elif action == "previous":
        api("POST", "/me/player/previous", params=q)
    elif action == "seek":
        try:
            ms = max(0, int(float(value)))
        except (TypeError, ValueError):
            raise SpotifyError(400, "seek needs a position in milliseconds") from None
        api("PUT", "/me/player/seek", params={**q, "position_ms": ms})
    elif action == "shuffle":
        api("PUT", "/me/player/shuffle", params={**q, "state": "true" if value else "false"})
    elif action == "repeat":
        if value not in ("off", "context", "track"):
            raise SpotifyError(400, "repeat is off, context or track")
        api("PUT", "/me/player/repeat", params={**q, "state": value})
    else:
        raise SpotifyError(400, f"Unknown action {action}")


def transfer(device_id: str, play_now: bool = True) -> None:
    api("PUT", "/me/player", content=json.dumps({"device_ids": [device_id], "play": play_now}))
