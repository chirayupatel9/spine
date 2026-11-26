from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import logging
import mimetypes
import secrets
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import artwork, db, demo, library, spotify
from .config import (ANDROID_CERT_SHA256, ANDROID_PACKAGE, APP_PASSWORD, ART_DIR, MAX_UPLOAD_MB, MUSIC_DIR,
                     PASSWORD_FILE, PASSWORD_FROM_ENV, PASSWORD_GENERATED, PUBLIC_URL, RESCAN_MINUTES, SECRET_KEY,
                     SPOTIFY_REDIRECT_URI)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("albumviewer")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = MAX_UPLOAD_MB * 1024 * 1024
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/ogg", ".opus")
mimetypes.add_type("application/manifest+json", ".webmanifest")


async def _background():
    await asyncio.sleep(2)
    while True:
        library.start_scan()
        if spotify.connected():
            spotify.start_sync()
        if RESCAN_MINUTES <= 0:
            return
        await asyncio.sleep(RESCAN_MINUTES * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_background())
    log.info("Album Viewer running at %s  (music: %s)", PUBLIC_URL, MUSIC_DIR)
    if PASSWORD_GENERATED:
        log.warning("Login password: %s  (saved in %s; set APP_PASSWORD to choose your own)", APP_PASSWORD, PASSWORD_FILE)
    elif not PASSWORD_FROM_ENV:
        log.info("Login password is in %s (set APP_PASSWORD to choose your own)", PASSWORD_FILE)
    if len(APP_PASSWORD) < 10:
        log.warning("APP_PASSWORD is shorter than 10 characters. Use a longer one if the app can be reached from the internet.")
    if spotify.configured():
        log.info("Spotify redirect URI (add this in your Spotify app settings): %s", SPOTIFY_REDIRECT_URI)
    yield
    task.cancel()


app = FastAPI(title="Album Viewer", lifespan=lifespan, docs_url=None, redoc_url=None)


# ---------------------------------------------------------------- login (always required)

COOKIE = "av_auth"
# Exact paths only: prefix matching would let "/login/../app.js" through, since the static file
# server resolves the "..".
OPEN_PATHS = frozenset({
    "/login", "/healthz", "/manifest.webmanifest", "/.well-known/assetlinks.json",
    "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
})
# Caching. Cloudflare (or any shared cache) must never keep anything behind sign-in, nor a sign-in
# redirect: a cached redirect for /app.js would break the app for everyone. Signed-in responses are
# therefore "private", refusals "no-store". The page loads style.css and app.js under addresses that
# change with every deploy (?v=...), so no cache can hand a device last week's code: those may be
# kept for a year; the bare addresses are checked on every load.
VERSIONED_ASSETS = ("style.css", "app.js")
SHELL_PATHS = frozenset({"/style.css", "/app.js", "/sw.js", "/manifest.webmanifest"})
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
}


def _auth_token() -> str:
    # Changes when the password or SECRET_KEY changes, which signs every screen out.
    return hmac.new(SECRET_KEY.encode(), f"albumviewer:{APP_PASSWORD}".encode(), hashlib.sha256).hexdigest()


def _signed_in(request: Request) -> bool:
    return hmac.compare_digest(request.cookies.get(COOKIE, "").encode(), _auth_token().encode())


def asset_version() -> str:
    """Changes whenever style.css or app.js changes (including a deploy), so their URLs do too."""
    h = hashlib.sha1()
    for name in VERSIONED_ASSETS:
        st = (WEB_DIR / name).stat()
        h.update(f"{name}:{st.st_size}:{st.st_mtime_ns};".encode())
    return h.hexdigest()[:12]


@app.middleware("http")
async def gate(request: Request, call_next):
    path = request.url.path
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY:
        response = JSONResponse({"detail": f"Request too large ({MAX_UPLOAD_MB} MB max)"}, status_code=413)
        response.headers["Cache-Control"] = "no-store"
    elif path not in OPEN_PATHS and not _signed_in(request):
        if path.startswith("/api/"):
            response = JSONResponse({"detail": "login required"}, status_code=401)
        else:
            response = RedirectResponse("/login")
        response.headers["Cache-Control"] = "no-store"
    else:
        response = await call_next(request)
        if path in SHELL_PATHS:
            versioned = path.lstrip("/") in VERSIONED_ASSETS and request.query_params.get("v")
            response.headers["Cache-Control"] = "max-age=31536000, immutable" if versioned else "no-cache"
        if path not in OPEN_PATHS:   # signed-in content: the browser may keep it, a shared cache may not
            cc = response.headers.get("Cache-Control", "no-cache")
            if "private" not in cc and "no-store" not in cc:
                response.headers["Cache-Control"] = "private, " + cc
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    return response


# Failed sign-ins: 5 per address, and 50 in total, in any 15 minutes. The total cap holds even if
# the attacker spreads guesses over many addresses; screens already signed in are unaffected.
LOGIN_WINDOW = 15 * 60
LOGIN_MAX_PER_ADDRESS = 5
LOGIN_MAX_TOTAL = 50
_fails: dict[str, list[float]] = {}
_fails_lock = threading.Lock()


def _login_wait(addr: str, now: float) -> int:
    """Seconds before `addr` may try again; 0 if it may try now."""
    with _fails_lock:
        for k in list(_fails):
            _fails[k] = [t for t in _fails[k] if now - t < LOGIN_WINDOW]
            if not _fails[k]:
                del _fails[k]
        waits = []
        mine = _fails.get(addr, [])
        if len(mine) >= LOGIN_MAX_PER_ADDRESS:
            waits.append(mine[-LOGIN_MAX_PER_ADDRESS] + LOGIN_WINDOW - now)
        every = sorted(t for ts in _fails.values() for t in ts)
        if len(every) >= LOGIN_MAX_TOTAL:
            waits.append(every[-LOGIN_MAX_TOTAL] + LOGIN_WINDOW - now)
        return int(max(waits)) + 1 if waits else 0


def _login_failed(addr: str, now: float) -> None:
    with _fails_lock:
        _fails.setdefault(addr, []).append(now)


def reset_login_limits() -> None:
    with _fails_lock:
        _fails.clear()


LOGIN_HTML = """<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Album Viewer</title><link rel=icon href=/icon.svg type=image/svg+xml><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0a08;color:rgba(255,255,255,.92);font:16px Inter,system-ui,sans-serif}
form{display:flex;flex-direction:column;gap:12px;width:min(280px,86vw)}
h1{margin:0 0 10px;font-size:15px;font-weight:700;letter-spacing:.16em}
input{padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1c1a17;color:inherit;font:inherit}
input:focus{outline:1px solid rgba(240,79,35,.55)}
button{padding:12px;border-radius:999px;border:0;background:#f04f23;color:#fff;font:inherit;font-weight:600;cursor:pointer}
p{color:#ff8a6b;margin:0;font-size:14px}</style></head><body>
<form method=post action=/login><h1>ALBUM VIEWER</h1>
<input type=password name=password placeholder=Password autocomplete=current-password autofocus required>{err}<button>Sign in</button></form>
</body></html>"""


def _login_page(err: str = "") -> str:
    return LOGIN_HTML.replace("{err}", f"<p>{html.escape(err)}</p>" if err else "")


@app.get("/login", include_in_schema=False)
def login_page():
    return HTMLResponse(_login_page())


@app.post("/login", include_in_schema=False)
async def login(request: Request):
    addr = request.client.host if request.client else "unknown"
    now = time.time()
    wait = _login_wait(addr, now)
    if wait:   # checked before the password, so a locked-out guesser learns nothing
        mins = max(1, round(wait / 60))
        return HTMLResponse(_login_page(f"Too many attempts. Try again in {mins} minute{'' if mins == 1 else 's'}."),
                            status_code=429, headers={"Retry-After": str(wait)})
    form = await request.form()
    if hmac.compare_digest(str(form.get("password", "")).encode(), APP_PASSWORD.encode()):
        with _fails_lock:
            _fails.pop(addr, None)
        r = RedirectResponse("/", status_code=303)
        r.set_cookie(COOKIE, _auth_token(), max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax",
                     secure=PUBLIC_URL.startswith("https"))
        return r
    _login_failed(addr, now)
    await asyncio.sleep(0.4)
    return HTMLResponse(_login_page("Wrong password"), status_code=401)


@app.post("/logout", include_in_schema=False)
def logout():
    r = RedirectResponse("/login", status_code=303)
    r.delete_cookie(COOKIE)
    return r


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


def _fingerprint(value: str) -> str | None:
    """'aa bb..', 'AABB..' or 'AA:BB:..' -> 'AA:BB:..'; None if it isn't a SHA-256 fingerprint."""
    hexdigits = "".join(c for c in value if c in "0123456789abcdefABCDEF").upper()
    if len(hexdigits) != 64 or len(value.replace(":", "").replace(" ", "")) != 64:
        return None
    return ":".join(hexdigits[i:i + 2] for i in range(0, 64, 2))


@app.get("/.well-known/assetlinks.json", include_in_schema=False)
def assetlinks():
    """Digital Asset Links: tells Android the Album Viewer app may open this site full screen."""
    prints = []
    for raw in ANDROID_CERT_SHA256:
        fp = _fingerprint(raw)
        if fp:
            prints.append(fp)
        else:
            log.warning("Ignoring ANDROID_CERT_SHA256 entry that isn't a SHA-256 fingerprint: %r", raw)
    if not ANDROID_PACKAGE or not prints:
        raise HTTPException(404)
    return JSONResponse([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": ANDROID_PACKAGE, "sha256_cert_fingerprints": prints},
    }])


# ---------------------------------------------------------------- albums

def _art_url(a: dict) -> str | None:
    if a["art_file"]:
        p = ART_DIR / a["art_file"]
        v = int(p.stat().st_mtime) if p.exists() else 0
        return f"/art/{a['art_file']}?v={v}"
    return a["remote_art"]


def _album_out(a: dict) -> dict:
    return {
        "id": a["id"], "source": a["source"], "title": a["title"], "artist": a["artist"], "year": a["year"],
        "uri": a["uri"], "color": a["color"] or "#333333", "text_color": a["text_color"] or "#f4f1ea",
        "art": _art_url(a),
        "art_status": a["art_status"], "art_source": a["art_source"], "hidden": bool(a["hidden"]),
        "added_at": a["added_at"], "tracks": a.get("n_tracks"),
    }


def _order() -> list[str]:
    try:
        return json.loads(db.kv_get("order") or "[]")
    except ValueError:
        return []


@app.get("/api/albums")
def list_albums(source: str | None = None, include_hidden: bool = False):
    sql = """SELECT a.*, (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id) AS n_tracks FROM albums a WHERE 1=1"""
    args: list = []
    if source in ("local", "spotify", "demo"):
        sql += " AND source=?"
        args.append(source)
    if not include_hidden:
        sql += " AND hidden=0"
    sql += " ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE"
    pos = {aid: i for i, aid in enumerate(_order())}
    return [{**_album_out(a), "pos": pos.get(a["id"])} for a in db.query(sql, args)]


@app.put("/api/order")
def save_order(body: dict = Body(...)):
    """Manual shelf order (the 'Manual order' arrangement), shared by every screen."""
    ids = [str(i) for i in body.get("ids", [])][:20000]
    db.kv_set("order", json.dumps(ids))
    return {"ok": True, "count": len(ids)}


@app.get("/api/albums/{album_id}")
def get_album(album_id: str):
    a = db.one("SELECT * FROM albums WHERE id=?", (album_id,))
    if not a:
        raise HTTPException(404, "Album not found")
    tracks = db.query("SELECT id, title, artist, track_no, disc_no, duration, uri FROM tracks WHERE album_id=? "
                      "ORDER BY disc_no, track_no, title", (album_id,))
    out = _album_out(a)
    out["track_list"] = tracks
    return out


@app.patch("/api/albums/{album_id}")
def update_album(album_id: str, body: dict = Body(...)):
    if "hidden" in body:
        with db.tx() as c:
            c.execute("UPDATE albums SET hidden=? WHERE id=?", (1 if body["hidden"] else 0, album_id))
    return get_album(album_id)


@app.post("/api/albums/{album_id}/art")
async def upload_art(album_id: str, file: UploadFile = File(...)):
    data = await file.read(MAX_BODY + 1)
    if len(data) > MAX_BODY:
        raise HTTPException(413, f"Image is too large ({MAX_UPLOAD_MB} MB max)")
    saved = artwork.save_art(album_id, data)
    if not saved:
        raise HTTPException(400, "Not an image")
    with db.tx() as c:
        c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source='manual', color=?, text_color=? WHERE id=?",
                  (*saved, album_id))
    return get_album(album_id)


@app.post("/api/albums/{album_id}/art/search")
def refetch_art(album_id: str, body: dict = Body(default={})):
    """Look the cover up online again, optionally with a corrected artist/album/song name."""
    a = db.one("SELECT * FROM albums WHERE id=?", (album_id,))
    if not a:
        raise HTTPException(404, "Album not found")
    first = db.one("SELECT title FROM tracks WHERE album_id=? ORDER BY disc_no, track_no LIMIT 1", (album_id,))
    artist = body.get("artist") or a["artist"]
    album = body.get("album", a["title"])
    song = body.get("song") or (first or {}).get("title")
    found = artwork.find_online(artist, album or None, song)
    if not found:
        raise HTTPException(404, "No artwork found online. Try a different spelling or upload an image.")
    saved = artwork.save_art(album_id, found[0])
    with db.tx() as c:
        c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source=?, color=?, text_color=? WHERE id=?",
                  (saved[0], found[1], saved[1], saved[2], album_id))
    return get_album(album_id)


@app.get("/art/{name}", include_in_schema=False)
def art(name: str):
    path = (ART_DIR / Path(name).name)
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


# ---------------------------------------------------------------- local library

@app.get("/api/status")
def status():
    return {
        "library": library.status,
        "music_dir": str(MUSIC_DIR),
        "demo": {**demo.status, "albums": demo.count()},
        "spotify": {"configured": spotify.configured(), "connected": spotify.connected(),
                    "redirect_uri": SPOTIFY_REDIRECT_URI, **spotify.sync_status},
    }


@app.post("/api/library/rescan")
def rescan(force_art: bool = False):
    return {"started": library.start_scan(force_art=force_art)}


@app.get("/api/local/stream/{track_id}")
def stream(track_id: str):
    t = db.one("SELECT path FROM tracks WHERE id=?", (track_id,))
    if not t or not t["path"]:
        raise HTTPException(404)
    path = Path(t["path"]).resolve()
    if not path.is_relative_to(MUSIC_DIR.resolve()) or not path.exists():
        raise HTTPException(404)
    mt = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=mt)  # supports HTTP Range (seeking)


# ---------------------------------------------------------------- demo shelf

@app.post("/api/demo/load")
def demo_load():
    return {"started": demo.start_load()}


@app.delete("/api/demo")
def demo_remove():
    demo.remove()
    return {"ok": True}


# ---------------------------------------------------------------- spotify

def _sp(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except spotify.SpotifyError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 502, str(e))


@app.get("/auth/spotify/login", include_in_schema=False)
def spotify_login():
    if not spotify.configured():
        raise HTTPException(400, "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first")
    state = secrets.token_urlsafe(16)
    r = RedirectResponse(spotify.authorize_url(state))
    r.set_cookie("sp_state", state, max_age=600, httponly=True, samesite="lax")
    return r


@app.get("/auth/spotify/callback", include_in_schema=False)
def spotify_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return RedirectResponse(f"/?spotify_error={quote(error)}")
    if not code or not state or state != request.cookies.get("sp_state"):
        raise HTTPException(400, "Invalid OAuth state")
    _sp(spotify.exchange_code, code)
    spotify.start_sync()
    r = RedirectResponse("/?spotify=connected")
    r.delete_cookie("sp_state")
    return r


@app.post("/api/spotify/disconnect")
def spotify_disconnect():
    spotify.disconnect()
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id IN (SELECT id FROM albums WHERE source='spotify')")
        c.execute("DELETE FROM albums WHERE source='spotify'")
    return {"ok": True}


@app.post("/api/spotify/sync")
def spotify_sync():
    return {"started": spotify.start_sync()}


@app.post("/api/spotify/add")
def spotify_add(body: dict = Body(...)):
    aid = _sp(spotify.add_album_by_link, body.get("link", ""))
    return get_album(aid)


@app.get("/api/spotify/token")
def spotify_token():
    """Short-lived access token for the Web Playback SDK in the browser."""
    return {"access_token": _sp(spotify.access_token)}


@app.get("/api/spotify/devices")
def spotify_devices():
    return _sp(spotify.devices)


@app.get("/api/spotify/state")
def spotify_state():
    return _sp(spotify.state) or {}


@app.post("/api/spotify/play")
def spotify_play(body: dict = Body(...)):
    _sp(spotify.play, body.get("uri"), body.get("offset"), body.get("device_id"))
    return {"ok": True}


@app.post("/api/spotify/control")
def spotify_control(body: dict = Body(...)):
    _sp(spotify.control, body.get("action"), body.get("device_id"), body.get("value"))
    return {"ok": True}


@app.post("/api/spotify/transfer")
def spotify_transfer(body: dict = Body(...)):
    if not body.get("device_id"):
        raise HTTPException(400, "device_id is required")
    _sp(spotify.transfer, body["device_id"], body.get("play", True))
    return {"ok": True}


# ---------------------------------------------------------------- frontend

@app.get("/", include_in_schema=False)
def index():
    v = asset_version()
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/style.css"', f'href="/style.css?v={v}"').replace('src="/app.js"', f'src="/app.js?v={v}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
