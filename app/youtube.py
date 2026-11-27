"""YouTube and YouTube Music, for each person who connects them: their own playlists (including the
ones they made in YouTube Music) and their liked music on their shelf, albums and songs anyone can
add by link or search, and the track lists the browser plays.

Connecting YouTube is a second Google sign-in that asks for one more permission, youtube.readonly
(read only: Album Viewer never changes anything in the account). It goes through the same Google
OAuth client, and comes back to the same address, as signing in with Google. The server never
touches the audio or video: the browser plays each video in YouTube's own embedded player (the
IFrame Player API), and the Android app hands an album to the YouTube Music app.

YouTube's API rules (developers.google.com/youtube/terms/developer-policies) decide what is kept:
  - What comes from YouTube is refreshed or deleted within 30 days: the shelf every few hours,
    an open track list after a week (unopened ones are deleted), covers after 25 days.
  - Disconnecting revokes the token at Google and deletes everything that came from YouTube for
    that person. A token that stops working (revoked on the Google account's security page) counts
    as a disconnect, noticed at the next sync.
  - Each video's "made for kids" status is kept, so the player can turn tracking off for it.
The API's daily allowance (10,000 units) is shared by everyone on this server: a search costs 100,
most reads 1. So searches are rationed, the shelf is synced every few hours rather than hourly,
and a playlist's videos are read only when it's opened.
"""
from __future__ import annotations

import html
import logging
import re
import threading
import time
from datetime import datetime
from urllib.parse import urlencode

import httpx

from . import artwork, config, db
from .google import AUTH_URL, TOKEN_URL

log = logging.getLogger("albumviewer.youtube")

SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
API = "https://www.googleapis.com/youtube/v3"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
MUSIC = "10"                      # YouTube's "Music" video category
SYNC_EVERY = 6 * 3600             # how often each person's playlists are listed again
TRACKS_FOR = 7 * 86400            # an opened playlist's videos are listed again after this long
LIKES_FOR = 6 * 3600              # liked music changes more often
TRACKS_KEEP = 29 * 86400          # track lists nobody opened again are deleted after this
ART_FOR = 25 * 86400              # covers are downloaded again before YouTube's 30 days are up
MAX_PAGES = 20                    # pages of 50 read from one playlist (1,000 videos)
LIKES_PAGES = 20                  # pages of 50 liked videos looked through for music (the latest 1,000)
SEARCHES_PER_PERSON = 25          # a day; each costs 100 of the 10,000 daily units
SEARCHES_TOTAL = 50               # a day, for everyone: the rest of the allowance is kept for syncing
TRACK_COLS = "id, title, artist, track_no, disc_no, duration, uri, kids, noembed"

_http = httpx.Client(timeout=20)
_token_lock = threading.Lock()
_status: dict[int, dict] = {}
_searches: dict[int, list[float]] = {}
_search_lock = threading.Lock()


class YouTubeError(Exception):
    def __init__(self, status: int, message: str, reason: str = ""):
        super().__init__(message)
        self.status = status
        self.reason = reason


def configured() -> bool:
    return config.YOUTUBE and bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET)


def connected(uid: int) -> bool:
    return bool(db.one("SELECT 1 AS ok FROM youtube_auth WHERE user_id=? AND refresh_token IS NOT NULL", (uid,)))


def _st(uid: int) -> dict:
    return _status.setdefault(uid, {"syncing": False, "albums": 0, "last_sync": None, "error": None})


def status(uid: int) -> dict:
    row = db.one("SELECT channel FROM youtube_auth WHERE user_id=? AND refresh_token IS NOT NULL", (uid,))
    return {"configured": configured(), "connected": bool(row), "channel": (row or {}).get("channel"), **_st(uid)}


# ---------------------------------------------------------------- connecting

def authorize_url(state: str, challenge: str, login_hint: str | None = None) -> str:
    q = {
        "client_id": config.GOOGLE_CLIENT_ID,
        "redirect_uri": config.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",          # a refresh token, so the shelf keeps up while they're away
        "prompt": "consent",               # Google hands one out only from its consent screen
        "include_granted_scopes": "true",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if login_hint:
        q["login_hint"] = login_hint       # the Google account they signed in with, picked to start with
    return AUTH_URL + "?" + urlencode(q)


def exchange_code(code: str, verifier: str) -> dict:
    """Tokens for the YouTube account that just said yes. Raises YouTubeError if they unticked
    the YouTube permission on Google's screen."""
    r = _http.post(TOKEN_URL, data={
        "code": code, "client_id": config.GOOGLE_CLIENT_ID, "client_secret": config.GOOGLE_CLIENT_SECRET,
        "redirect_uri": config.GOOGLE_REDIRECT_URI, "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if r.status_code != 200:
        raise YouTubeError(r.status_code, f"Google didn't accept the YouTube connection ({r.status_code})")
    tokens = r.json()
    if SCOPE not in (tokens.get("scope") or "").split():
        raise YouTubeError(403, "Album Viewer needs to see your YouTube playlists to bring them onto your shelf. "
                                "Connect again and leave that box ticked on Google's screen.")
    if not tokens.get("refresh_token"):
        raise YouTubeError(400, "Google didn't hand over a lasting sign-in. Try connecting YouTube again.")
    return tokens


def store_tokens(uid: int, tokens: dict, *, new: bool = False) -> None:
    expires = time.time() + int(tokens.get("expires_in", 3600)) - 60
    with db.tx() as c:
        if new:   # perhaps another Google account's YouTube than before: its name is looked up again
            c.execute("""INSERT INTO youtube_auth(user_id, access_token, refresh_token, expires_at, channel, connected_at)
                         VALUES(?,?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,
                           refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, channel=NULL,
                           connected_at=excluded.connected_at""",
                      (uid, tokens["access_token"], tokens.get("refresh_token"), expires, time.time()))
        else:
            c.execute("UPDATE youtube_auth SET access_token=?, expires_at=?, refresh_token=COALESCE(?, refresh_token) WHERE user_id=?",
                      (tokens["access_token"], expires, tokens.get("refresh_token"), uid))


def access_token(uid: int) -> str:
    with _token_lock:
        row = db.one("SELECT * FROM youtube_auth WHERE user_id=?", (uid,))
        if not row or not row["refresh_token"]:
            raise YouTubeError(401, "YouTube isn't connected")
        if row["access_token"] and time.time() < (row["expires_at"] or 0):
            return row["access_token"]
        r = _http.post(TOKEN_URL, data={"grant_type": "refresh_token", "refresh_token": row["refresh_token"],
                                        "client_id": config.GOOGLE_CLIENT_ID, "client_secret": config.GOOGLE_CLIENT_SECRET})
        if r.status_code == 200:
            store_tokens(uid, r.json())
            return r.json()["access_token"]
    try:
        reason = r.json().get("error")
    except ValueError:
        reason = None
    if reason == "invalid_grant":   # revoked from their Google account: what came from YouTube goes too
        forget(uid)
        raise YouTubeError(401, "YouTube was disconnected from your Google account. Connect it again to bring your playlists back.")
    raise YouTubeError(502, f"Google didn't renew the YouTube sign-in ({r.status_code})")


def api(uid: int, path: str, **params) -> dict:
    query = {k: v for k, v in params.items() if v is not None}
    for attempt in range(2):
        r = _http.get(API + path, params=query, headers={"Authorization": f"Bearer {access_token(uid)}"})
        if r.status_code == 401 and attempt == 0:   # expired early: renew once
            with db.tx() as c:
                c.execute("UPDATE youtube_auth SET expires_at=0 WHERE user_id=?", (uid,))
            continue
        if r.status_code >= 400:
            raise _error(r)
        return r.json()
    raise YouTubeError(401, "YouTube didn't accept the sign-in. Connect YouTube again.")


def _error(r: httpx.Response) -> YouTubeError:
    try:
        err = r.json().get("error") or {}
    except ValueError:
        err = {}
    reason = ((err.get("errors") or [{}])[0] or {}).get("reason", "") if isinstance(err, dict) else ""
    if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"):
        return YouTubeError(429, "YouTube's daily allowance for Album Viewer is used up. Try again tomorrow.", reason)
    if reason == "channelNotFound":
        return YouTubeError(404, "This Google account doesn't have a YouTube channel.", reason)
    if r.status_code == 404 or reason.endswith("NotFound"):
        return YouTubeError(404, "YouTube couldn't find that, or it's private.", reason)
    message = err.get("message") if isinstance(err, dict) else None
    return YouTubeError(r.status_code, message or f"YouTube answered {r.status_code}", reason)


def disconnect(uid: int) -> None:
    """Take back Album Viewer's YouTube access at Google, then delete what came from YouTube."""
    row = db.one("SELECT access_token, refresh_token FROM youtube_auth WHERE user_id=?", (uid,))
    if row and (row["refresh_token"] or row["access_token"]):
        try:
            _http.post(REVOKE_URL, data={"token": row["refresh_token"] or row["access_token"]})
        except httpx.HTTPError:
            log.warning("couldn't reach Google to revoke user %s's YouTube access", uid)
    forget(uid)


def forget(uid: int) -> None:
    """Delete this person's YouTube token and everything on their shelf that came from YouTube."""
    with db.tx() as c:
        c.execute("DELETE FROM youtube_auth WHERE user_id=?", (uid,))
        c.execute("DELETE FROM shelf WHERE user_id=? AND album_id IN (SELECT id FROM albums WHERE source='youtube')", (uid,))
    db.kv_set(f"yt:sync:{uid}", None)
    prune()
    _st(uid).update(last_sync=None, error=None, albums=0)


# ---------------------------------------------------------------- reading YouTube's answers

def _topic(channel: str) -> str:
    """'Fleetwood Mac - Topic' (the channel YouTube makes for an artist's songs) -> 'Fleetwood Mac'."""
    return re.sub(r"\s+-\s+Topic$", "", channel or "").strip()


_NOISE = re.compile(r"\s*[(\[][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|remaster(ed)?|mv)\b[^)\]]*[)\]]", re.I)


def _artist_title(title: str, channel: str) -> tuple[str, str]:
    """Who and what a video is. A song from YouTube Music comes from the artist's "- Topic"
    channel with just the song's name; a music video is usually called "Artist - Song (Official
    Video)"; anything else is the channel's."""
    title = html.unescape(title or "").strip()
    channel = html.unescape(channel or "").strip()
    if channel.endswith(" - Topic"):
        return _topic(channel), title
    m = re.match(r"^(.+?)\s+[-–—]\s+(.+)$", title)
    if m:
        return m.group(1).strip(), _NOISE.sub("", m.group(2)).strip() or m.group(2).strip()
    return re.sub(r"\s*VEVO$", "", channel).strip() or "YouTube", _NOISE.sub("", title).strip() or title


def _duration(iso: str | None) -> float | None:
    """'PT1H2M3S' -> 3723.0; None when unknown (a live stream says 'P0D')."""
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?", iso or "")
    if not m:
        return None
    d, h, mi, s = (float(x) if x else 0.0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s or None


def _released(description: str | None) -> str | None:
    """YouTube Music's songs say "Released on: 1977-02-04" in their description."""
    m = re.search(r"Released on:\s*(\d{4})", description or "")
    return m.group(1) if m else None


def _thumb(thumbs: dict | None) -> str | None:
    for size in ("maxres", "standard", "high", "medium", "default"):
        url = ((thumbs or {}).get(size) or {}).get("url")
        if url:
            return url
    return None


def _ts(s: str | None) -> float | None:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00")).timestamp() if s else None
    except ValueError:
        return None


def _album_name(title: str, playlist_id: str) -> tuple[str, bool]:
    """YouTube Music keeps each album as a playlist ('OLAK5uy_…'), called 'Album - Rumours'."""
    title = html.unescape(title or "").strip()
    if playlist_id.startswith("OLAK5uy_"):
        return re.sub(r"^Album\s*[-–—:]\s*", "", title) or title, True
    return title or "Playlist", False


def _track(aid: str, n: int, v: dict, tid: str | None = None) -> tuple:
    sn, cd, st = v.get("snippet") or {}, v.get("contentDetails") or {}, v.get("status") or {}
    artist, title = _artist_title(sn.get("title") or "", sn.get("channelTitle") or "")
    return (tid or f"{aid}_{n}", aid, title or "Untitled", artist, n, 1, _duration(cd.get("duration")), v["id"],
            1 if st.get("madeForKids") else 0, 0 if st.get("embeddable", True) else 1)


def _videos(uid: int, ids: list[str]) -> dict[str, dict]:
    """The videos behind these ids (their length, whether they're made for kids and whether
    they play outside YouTube), 50 to a request. Deleted and private ones aren't there."""
    ids, out = list(dict.fromkeys(i for i in ids if i)), {}
    for i in range(0, len(ids), 50):
        page = api(uid, "/videos", part="snippet,contentDetails,status", id=",".join(ids[i:i + 50]), maxResults=50)
        for v in page.get("items") or []:
            out[v["id"]] = v
    return out


# ---------------------------------------------------------------- the shelf

def _shelve(uid: int, aid: str, added_at: float | None, pinned: bool = False) -> None:
    with db.tx() as c:
        c.execute("""INSERT INTO shelf(user_id, album_id, added_at, pinned, seen) VALUES(?,?,?,?,1)
                     ON CONFLICT(user_id, album_id) DO UPDATE SET seen=1, pinned=MAX(shelf.pinned, excluded.pinned),
                       added_at=COALESCE(shelf.added_at, excluded.added_at)""",
                  (uid, aid, added_at or time.time(), 1 if pinned else 0))


def _upsert_playlist(pl: dict) -> str:
    pid = pl["id"]
    aid = "yt_" + pid
    sn = pl.get("snippet") or {}
    title, album = _album_name(sn.get("title") or "", pid)
    channel = html.unescape(sn.get("channelTitle") or "")
    artist = (_topic(channel) or "YouTube Music") if album else (channel or "YouTube")
    art = _thumb(sn.get("thumbnails"))
    total = (pl.get("contentDetails") or {}).get("itemCount")
    snap = f"{pl.get('etag') or ''}:{total}"   # changes as its videos do
    old = db.one("SELECT remote_art FROM albums WHERE id=?", (aid,))
    with db.tx() as c:
        c.execute("""INSERT INTO albums(id, source, kind, title, artist, uri, remote_art, track_count, snapshot, added_at, seen)
                     VALUES(?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, 1)
                     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, artist=excluded.artist,
                       uri=excluded.uri, remote_art=excluded.remote_art, track_count=excluded.track_count, snapshot=excluded.snapshot""",
                  (aid, "album" if album else "playlist", title, artist, "youtube:playlist:" + pid, art, total, snap, time.time()))
        if old and old["remote_art"] != art:
            c.execute("UPDATE albums SET art_status='pending' WHERE id=?", (aid,))
    return aid


def _upsert_video(v: dict) -> str:
    """A song added on its own: on the shelf as a one-track album."""
    vid = v["id"]
    aid = "yv_" + vid
    sn = v.get("snippet") or {}
    artist, title = _artist_title(sn.get("title") or "", sn.get("channelTitle") or "")
    year = _released(sn.get("description")) or (sn.get("publishedAt") or "")[:4] or None
    art = _thumb(sn.get("thumbnails"))
    old = db.one("SELECT remote_art FROM albums WHERE id=?", (aid,))
    with db.tx() as c:
        c.execute("""INSERT INTO albums(id, source, kind, title, artist, year, uri, remote_art, track_count, added_at, seen)
                     VALUES(?, 'youtube', 'album', ?, ?, ?, ?, ?, 1, ?, 1)
                     ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, year=excluded.year,
                       uri=excluded.uri, remote_art=excluded.remote_art""",
                  (aid, title, artist, year, "youtube:video:" + vid, art, time.time()))
        if old and old["remote_art"] != art:
            c.execute("UPDATE albums SET art_status='pending' WHERE id=?", (aid,))
        c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))
        c.execute(f"INSERT OR REPLACE INTO tracks({TRACK_COLS}, album_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
                  _reorder(_track(aid, 1, v, tid=aid)))
    return aid


def _reorder(row: tuple) -> tuple:
    """_track's (id, album_id, ...) in TRACK_COLS order, album_id last."""
    tid, aid, *rest = row
    return (tid, *rest, aid)


def likes_id(uid: int) -> str:
    return f"yl_{uid}"


def _upsert_likes(uid: int) -> str:
    """Their liked music: the music among the videos they've liked, as a playlist of its own."""
    aid = likes_id(uid)
    with db.tx() as c:
        c.execute("""INSERT INTO albums(id, source, kind, title, artist, uri, added_at, seen)
                     VALUES(?, 'youtube', 'playlist', 'Liked music', 'YouTube Music', 'youtube:liked', ?, 1)
                     ON CONFLICT(id) DO NOTHING""", (aid, time.time()))
    return aid


def prune() -> None:
    """Forget YouTube albums and playlists that are on nobody's shelf, covers included."""
    gone = db.query("SELECT id, art_file FROM albums WHERE source='youtube' AND id NOT IN (SELECT album_id FROM shelf)")
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id IN (SELECT id FROM albums WHERE source='youtube' "
                  "AND id NOT IN (SELECT album_id FROM shelf))")
        c.execute("DELETE FROM albums WHERE source='youtube' AND id NOT IN (SELECT album_id FROM shelf)")
    for row in gone:
        db.kv_set(f"yt:tracks:{row['id']}", None)
        if row["art_file"]:
            (config.ART_DIR / row["art_file"]).unlink(missing_ok=True)


def _learn_channel(uid: int) -> None:
    row = db.one("SELECT channel FROM youtube_auth WHERE user_id=?", (uid,))
    if row and row["channel"] is None:
        items = api(uid, "/channels", part="snippet", mine="true").get("items") or []
        name = html.unescape(((items[0] if items else {}).get("snippet") or {}).get("title") or "")
        with db.tx() as c:
            c.execute("UPDATE youtube_auth SET channel=? WHERE user_id=?", (name, uid))


def _own_playlists(uid: int):
    token = None
    for _ in range(MAX_PAGES):
        try:
            page = api(uid, "/playlists", part="snippet,contentDetails", mine="true", maxResults=50, pageToken=token)
        except YouTubeError as e:
            if e.reason == "channelNotFound":   # a Google account with no YouTube channel has no playlists
                return
            raise
        yield from page.get("items") or []
        token = page.get("nextPageToken")
        if not token:
            return


def _refresh_added(uid: int) -> None:
    """What they added by link: looked up again (YouTube's 30 days), and taken off the shelf once
    it's deleted or private."""
    rows = db.query("""SELECT a.id FROM shelf s JOIN albums a ON a.id=s.album_id
                       WHERE s.user_id=? AND s.pinned=1 AND a.source='youtube'""", (uid,))
    pids = [r["id"][3:] for r in rows if r["id"].startswith("yt_")]
    vids = [r["id"][3:] for r in rows if r["id"].startswith("yv_")]
    found = set()
    for i in range(0, len(pids), 50):
        for pl in api(uid, "/playlists", part="snippet,contentDetails", id=",".join(pids[i:i + 50]), maxResults=50).get("items") or []:
            found.add(_upsert_playlist(pl))
    for v in _videos(uid, vids).values():
        found.add(_upsert_video(v))
    gone = [r["id"] for r in rows if r["id"] not in found]
    if gone:
        with db.tx() as c:
            c.executemany("DELETE FROM shelf WHERE user_id=? AND album_id=?", [(uid, aid) for aid in gone])


def sync(uid: int) -> None:
    st = _st(uid)
    if st["syncing"] or not connected(uid):
        return
    st.update(syncing=True, error=None, albums=0)
    try:
        _learn_channel(uid)
        with db.tx() as c:
            c.execute("UPDATE shelf SET seen=0 WHERE user_id=? AND pinned=0 "
                      "AND album_id IN (SELECT id FROM albums WHERE source='youtube')", (uid,))
        count = 0
        for pl in _own_playlists(uid):
            _shelve(uid, _upsert_playlist(pl), _ts((pl.get("snippet") or {}).get("publishedAt")))
            count += 1
            st["albums"] = count
        _shelve(uid, _upsert_likes(uid), None)
        st["albums"] = count + 1
        _refresh_added(uid)
        with db.tx() as c:
            c.execute("DELETE FROM shelf WHERE user_id=? AND seen=0 "
                      "AND album_id IN (SELECT id FROM albums WHERE source='youtube')", (uid,))
        prune()
        cache_art()
        st["last_sync"] = time.time()
        db.kv_set(f"yt:sync:{uid}", str(st["last_sync"]))
    except YouTubeError as e:
        st["error"] = str(e)
        log.warning("youtube sync failed for user %s: %s", uid, e)
    except Exception as e:
        st["error"] = str(e)
        log.exception("youtube sync failed for user %s", uid)
    finally:
        st["syncing"] = False


def start_sync(uid: int) -> bool:
    if _st(uid)["syncing"]:
        return False
    threading.Thread(target=sync, args=(uid,), daemon=True).start()
    return True


def sync_everyone() -> None:
    expire()
    for row in db.query("SELECT user_id FROM youtube_auth WHERE refresh_token IS NOT NULL"):
        if time.time() - float(db.kv_get(f"yt:sync:{row['user_id']}") or 0) >= SYNC_EVERY:
            sync(row["user_id"])


def expire() -> None:
    """Delete track lists no one has opened for almost 30 days (they're listed again when opened)."""
    old = time.time() - TRACKS_KEEP
    for row in db.query("SELECT id FROM albums WHERE source='youtube' AND id NOT LIKE 'yv\\_%' ESCAPE '\\'"):
        fetched = db.kv_get(f"yt:tracks:{row['id']}")
        if fetched and float(fetched) < old:
            with db.tx() as c:
                c.execute("DELETE FROM tracks WHERE album_id=?", (row["id"],))
            db.kv_set(f"yt:tracks:{row['id']}", None)


def cache_art() -> None:
    """Covers, downloaded so spines get their colours, and downloaded again before YouTube's 30
    days are up. YouTube's thumbnails are video frames: the bars are trimmed and the middle square
    kept."""
    stale = time.time() - ART_FOR
    for row in db.query("SELECT id, art_file FROM albums WHERE source='youtube' AND art_status='ok' AND art_file IS NOT NULL"):
        p = config.ART_DIR / row["art_file"]
        if not p.exists() or p.stat().st_mtime < stale:
            with db.tx() as c:
                c.execute("UPDATE albums SET art_status='pending' WHERE id=?", (row["id"],))
    for row in db.query("SELECT id, remote_art FROM albums WHERE source='youtube' AND art_status!='ok' AND remote_art IS NOT NULL"):
        data = artwork.download(row["remote_art"])
        square = artwork.square_crop(data) if data else None
        saved = artwork.save_art(row["id"], square) if square else None
        with db.tx() as c:
            if saved:
                c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source='youtube', color=?, text_color=? WHERE id=?",
                          (*saved, row["id"]))
            else:
                color, text = artwork.placeholder_color(row["id"])
                c.execute("UPDATE albums SET color=?, text_color=? WHERE id=?", (color, text, row["id"]))
    for row in db.query("SELECT id FROM albums WHERE source='youtube' AND color IS NULL"):
        color, text = artwork.placeholder_color(row["id"])
        with db.tx() as c:
            c.execute("UPDATE albums SET color=?, text_color=? WHERE id=?", (color, text, row["id"]))


# ---------------------------------------------------------------- track lists

def _out(rows: list[dict]) -> list[dict]:
    return [{**{k: v for k, v in r.items() if k not in ("kids", "noembed")},
             "kids": bool(r.get("kids")), "embeddable": not r.get("noembed")} for r in rows]


def tracks(uid: int, a: dict) -> list[dict]:
    """An album's or playlist's videos, in order, as the shelf plays them. Listed from YouTube when
    it's first opened, and again once it has changed or the list is a week old (liked music: six
    hours). Videos that are deleted or private are left out."""
    aid = a["id"]
    cached = db.query(f"SELECT {TRACK_COLS} FROM tracks WHERE album_id=? ORDER BY track_no", (aid,))
    if aid.startswith("yv_"):
        return _out(cached)   # a song added on its own: refreshed with the shelf
    likes = aid.startswith("yl_")
    fetched = float(db.kv_get(f"yt:tracks:{aid}") or 0)
    fresh = time.time() - fetched < (LIKES_FOR if likes else TRACKS_FOR)
    if cached and fresh and db.kv_get(f"yt:snap:{aid}") == (a.get("snapshot") or ""):
        return _out(cached)
    try:
        videos = _liked_music(uid) if likes else _playlist_videos(uid, aid[3:])
    except YouTubeError:
        if cached:   # e.g. today's allowance is used up: play what was listed before
            return _out(cached)
        raise
    rows = [_reorder(_track(aid, n, v)) for n, v in enumerate(videos, 1)]
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))
        c.executemany(f"INSERT OR REPLACE INTO tracks({TRACK_COLS}, album_id) VALUES(?,?,?,?,?,?,?,?,?,?)", rows)
        c.execute("UPDATE albums SET track_count=? WHERE id=?", (len(rows), aid))
        first = (videos[0].get("snippet") or {}) if videos else {}
        if a.get("kind") == "album" and not a.get("year") and _released(first.get("description")):
            c.execute("UPDATE albums SET year=? WHERE id=?", (_released(first.get("description")), aid))
        if likes and _thumb(first.get("thumbnails")) and _thumb(first.get("thumbnails")) != a.get("remote_art"):
            c.execute("UPDATE albums SET remote_art=?, art_status='pending' WHERE id=?", (_thumb(first.get("thumbnails")), aid))
    db.kv_set(f"yt:tracks:{aid}", str(time.time()))
    db.kv_set(f"yt:snap:{aid}", a.get("snapshot") or "")
    if likes:
        cache_art()
    return _out(db.query(f"SELECT {TRACK_COLS} FROM tracks WHERE album_id=? ORDER BY track_no", (aid,)))


def _playlist_videos(uid: int, pid: str) -> list[dict]:
    ids, token = [], None
    for _ in range(MAX_PAGES):
        page = api(uid, "/playlistItems", part="contentDetails", playlistId=pid, maxResults=50, pageToken=token)
        ids += [(it.get("contentDetails") or {}).get("videoId") for it in page.get("items") or []]
        token = page.get("nextPageToken")
        if not token:
            break
    found = _videos(uid, ids)
    return [found[i] for i in ids if i in found]


def _liked_music(uid: int) -> list[dict]:
    """The music among the videos they've liked, most recently liked first."""
    out, token = [], None
    for _ in range(LIKES_PAGES):
        page = api(uid, "/videos", part="snippet,contentDetails,status", myRating="like", maxResults=50, pageToken=token)
        out += [v for v in page.get("items") or [] if (v.get("snippet") or {}).get("categoryId") == MUSIC]
        token = page.get("nextPageToken")
        if not token:
            break
    return out


# ---------------------------------------------------------------- adding by link, and search

_LIST = re.compile(r"[?&]list=([A-Za-z0-9_-]{2,64})")
_VIDEO = re.compile(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")


def add(uid: int, text: str, kind: str | None = None) -> str:
    """An album, playlist or song put on someone's shelf by its YouTube or YouTube Music link (from
    search: by its id and kind). Kept through syncs while YouTube still has it."""
    text = (text or "").strip()
    pid = vid = None
    if kind in ("album", "playlist"):
        pid = text
    elif kind == "song":
        vid = text
    else:
        if "/browse/MPREb_" in text:
            raise YouTubeError(400, "That's a YouTube Music album page. Open the album, choose Share, and paste that link instead.")
        lm, vm = _LIST.search(text), _VIDEO.search(text)
        pid, vid = (lm.group(1) if lm else None), (vm.group(1) if vm else None)
        if not pid and not vid:
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
                vid = text
            elif re.fullmatch(r"(PL|OLAK5uy_)[A-Za-z0-9_-]{8,}", text):
                pid = text
        if pid and pid.startswith("RD"):   # a mix: made up afresh each time it plays
            if not vid:
                raise YouTubeError(400, "YouTube's mixes change every time they play, so they can't go on a shelf. Add an album or playlist.")
            pid = None
    if pid in ("LM", "LL"):
        aid = _upsert_likes(uid)
        _shelve(uid, aid, None)
        return aid
    if pid == "WL":
        raise YouTubeError(400, "YouTube doesn't share Watch later with other apps.")
    if pid:
        items = api(uid, "/playlists", part="snippet,contentDetails", id=pid, maxResults=1).get("items") or []
        if not items:
            raise YouTubeError(404, "YouTube couldn't find that playlist, or it's private.")
        aid = _upsert_playlist(items[0])
    elif vid:
        v = _videos(uid, [vid]).get(vid)
        if not v:
            raise YouTubeError(404, "YouTube couldn't find that video, or it's private.")
        aid = _upsert_video(v)
    else:
        raise YouTubeError(400, "Paste a YouTube or YouTube Music link to an album, a playlist or a song.")
    _shelve(uid, aid, time.time(), pinned=True)
    cache_art()
    return aid


def _ration(uid: int) -> None:
    now = time.time()
    with _search_lock:
        for k in list(_searches):
            _searches[k] = [t for t in _searches[k] if now - t < 86400]
        mine = _searches.setdefault(uid, [])
        if len(mine) >= SEARCHES_PER_PERSON or sum(map(len, _searches.values())) >= SEARCHES_TOTAL:
            raise YouTubeError(429, "That's all the YouTube searches for today: YouTube rations them. "
                                    "Paste a link to the album or song instead, or search again tomorrow.")
        mine.append(now)


def search(uid: int, q: str) -> list[dict]:
    """Albums, playlists and songs on YouTube matching `q`."""
    q = " ".join((q or "").split())[:120]
    if len(q) < 2:
        raise YouTubeError(400, "Type an album, an artist or a song to look for")
    _ration(uid)
    page = api(uid, "/search", part="snippet", q=q, type="playlist,video", maxResults=12)
    out = []
    for it in page.get("items") or []:
        ident, sn = it.get("id") or {}, it.get("snippet") or {}
        channel = html.unescape(sn.get("channelTitle") or "")
        if ident.get("kind") == "youtube#playlist" and ident.get("playlistId"):
            title, album = _album_name(sn.get("title") or "", ident["playlistId"])
            out.append({"kind": "album" if album else "playlist", "id": ident["playlistId"], "title": title,
                        "artist": _topic(channel) or channel, "art": _thumb(sn.get("thumbnails"))})
        elif ident.get("kind") == "youtube#video" and ident.get("videoId"):
            artist, title = _artist_title(sn.get("title") or "", channel)
            out.append({"kind": "song", "id": ident["videoId"], "title": title, "artist": artist, "art": _thumb(sn.get("thumbnails"))})
    return out


def open_url(a: dict) -> str | None:
    """Where the album plays in YouTube Music (the app, on a phone that has it)."""
    uri = a.get("uri") or ""
    if uri.startswith("youtube:playlist:"):
        return "https://music.youtube.com/playlist?list=" + uri.split(":", 2)[2]
    if uri.startswith("youtube:video:"):
        return "https://music.youtube.com/watch?v=" + uri.split(":", 2)[2]
    if uri == "youtube:liked":
        return "https://music.youtube.com/playlist?list=LM"
    return None
