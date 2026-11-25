from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import mimetypes
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import artwork, db, library, spotify
from .config import APP_PASSWORD, ART_DIR, MUSIC_DIR, PUBLIC_URL, RESCAN_MINUTES, SECRET_KEY, SPOTIFY_REDIRECT_URI

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spine")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
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
    log.info("Spine running at %s  (music: %s)", PUBLIC_URL, MUSIC_DIR)
    if spotify.configured():
        log.info("Spotify redirect URI (add this in your Spotify app settings): %s", SPOTIFY_REDIRECT_URI)
    yield
    task.cancel()


app = FastAPI(title="Spine", lifespan=lifespan, docs_url=None, redoc_url=None)


# ---------------------------------------------------------------- password gate

def _auth_token() -> str:
    return hmac.new(SECRET_KEY.encode(), f"spine:{APP_PASSWORD}".encode(), hashlib.sha256).hexdigest()


OPEN_PATHS = ("/login", "/manifest.webmanifest", "/icon", "/healthz")


@app.middleware("http")
async def password_gate(request: Request, call_next):
    if APP_PASSWORD and not request.url.path.startswith(OPEN_PATHS):
        if not hmac.compare_digest(request.cookies.get("spine_auth", ""), _auth_token()):
            if request.url.path.startswith("/api/"):
                return JSONResponse({"detail": "login required"}, status_code=401)
            return RedirectResponse("/login")
    return await call_next(request)


LOGIN_HTML = """<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<title>Spine</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#16161a;color:#eee;font:16px system-ui}
form{display:flex;flex-direction:column;gap:12px;width:260px}input,button{padding:12px;border-radius:10px;border:1px solid #333;background:#222;color:#eee;font-size:16px}
button{background:#e8e2d4;color:#111;border:0;font-weight:600}p{color:#e66;margin:0}</style></head><body>
<form method=post><h2 style="margin:0 0 8px;font-weight:600;letter-spacing:.04em">SPINE</h2>
<input type=password name=password placeholder=Password autofocus>{err}<button>Enter</button></form></body></html>"""


@app.get("/login", include_in_schema=False)
def login_page():
    return HTMLResponse(LOGIN_HTML.replace("{err}", ""))


@app.post("/login", include_in_schema=False)
async def login(request: Request):
    form = await request.form()
    if APP_PASSWORD and hmac.compare_digest(str(form.get("password", "")), APP_PASSWORD):
        r = RedirectResponse("/", status_code=303)
        r.set_cookie("spine_auth", _auth_token(), max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax",
                     secure=PUBLIC_URL.startswith("https"))
        return r
    return HTMLResponse(LOGIN_HTML.replace("{err}", "<p>Wrong password</p>"), status_code=401)


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


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


@app.get("/api/albums")
def list_albums(source: str | None = None, include_hidden: bool = False):
    sql = """SELECT a.*, (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id) AS n_tracks FROM albums a WHERE 1=1"""
    args: list = []
    if source in ("local", "spotify"):
        sql += " AND source=?"
        args.append(source)
    if not include_hidden:
        sql += " AND hidden=0"
    sql += " ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE"
    return [_album_out(a) for a in db.query(sql, args)]


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
    data = await file.read()
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
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


# ---------------------------------------------------------------- local library

@app.get("/api/status")
def status():
    return {
        "library": library.status,
        "music_dir": str(MUSIC_DIR),
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
        return RedirectResponse(f"/?spotify_error={error}")
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
    _sp(spotify.control, body.get("action"), body.get("device_id"))
    return {"ok": True}


@app.post("/api/spotify/transfer")
def spotify_transfer(body: dict = Body(...)):
    _sp(spotify.transfer, body["device_id"], body.get("play", True))
    return {"ok": True}


# ---------------------------------------------------------------- frontend

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
