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

from fastapi import Body, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import artwork, config, db, demo, google, library, spotify, users
from .config import (ANDROID_CERT_SHA256, ANDROID_PACKAGE, APP_PASSWORD, ART_DIR, GOOGLE_REDIRECT_URI, MAX_UPLOAD_MB,
                     MUSIC_DIR, PASSWORD_FILE, PASSWORD_FROM_ENV, PASSWORD_GENERATED, PUBLIC_URL, RESCAN_MINUTES,
                     SPOTIFY_REDIRECT_URI)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("albumviewer")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = MAX_UPLOAD_MB * 1024 * 1024
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/ogg", ".opus")
mimetypes.add_type("application/manifest+json", ".webmanifest")


OWNER_ID = users.ensure_owner()
# The Android app's own address scheme: a sign-in it started in the browser comes back through it.
APP_SCHEME = ANDROID_PACKAGE or "dev.chirayupatel.music"


async def _background():
    await asyncio.sleep(2)
    while True:
        library.start_scan()
        threading.Thread(target=spotify.sync_everyone, daemon=True).start()
        if RESCAN_MINUTES <= 0:
            return
        await asyncio.sleep(RESCAN_MINUTES * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_background())
    log.info("Album Viewer running at %s  (music: %s)", PUBLIC_URL, MUSIC_DIR)
    if config.PASSWORD_SIGN_IN:
        if PASSWORD_GENERATED:
            log.warning("Login password: %s  (saved in %s; set APP_PASSWORD to choose your own)", APP_PASSWORD, PASSWORD_FILE)
        elif not PASSWORD_FROM_ENV:
            log.info("Login password is in %s (set APP_PASSWORD to choose your own)", PASSWORD_FILE)
        if len(APP_PASSWORD) < 10:
            log.warning("APP_PASSWORD is shorter than 10 characters. Use a longer one if the app can be reached from the internet.")
    else:
        log.info("Sign-in with Google (redirect URI for your Google OAuth client: %s)", GOOGLE_REDIRECT_URI)
        if not config.ADMIN_EMAIL:
            log.warning("ADMIN_EMAIL isn't set: no Google account will see the music folder or the admin settings")
    if spotify.configured():
        log.info("Spotify redirect URI (add this in your Spotify app settings): %s", SPOTIFY_REDIRECT_URI)
    yield
    task.cancel()


app = FastAPI(title="Album Viewer", lifespan=lifespan, docs_url=None, redoc_url=None)


# ---------------------------------------------------------------- sign-in (always required)

COOKIE = "av_session"
FLOW_COOKIE = "av_flow"
# Exact paths only: prefix matching would let "/login/../app.js" through, since the static file
# server resolves the "..".
OPEN_PATHS = frozenset({
    "/login", "/healthz", "/manifest.webmanifest", "/.well-known/assetlinks.json",
    "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
    "/auth/google/login", "/auth/google/callback", "/auth/spotify/login", "/auth/spotify/callback", "/auth/app/exchange",
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


def _user(request: Request) -> dict:
    """The signed-in person (the gate has already turned everyone else away)."""
    return request.state.user


def _need_admin(request: Request) -> dict:
    u = _user(request)
    if not u["admin"]:
        raise HTTPException(403, "Only the person who runs this server can do that")
    return u


def _set_session(response, token: str) -> None:
    response.set_cookie(COOKIE, token, max_age=60 * 60 * 24 * users.SESSION_DAYS, httponly=True, samesite="lax",
                        secure=PUBLIC_URL.startswith("https"))


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
    elif (user := users.from_session(request.cookies.get(COOKIE))) is None and path not in OPEN_PATHS:
        if path.startswith("/api/"):
            response = JSONResponse({"detail": "login required"}, status_code=401)
        else:
            response = RedirectResponse("/login")
        response.headers["Cache-Control"] = "no-store"
    else:
        request.state.user = user
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
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse 80% 70% at 50% 30%,#2c2a27,#171513 55%,#0c0a08);color:rgba(255,255,255,.92);font:16px Inter,system-ui,sans-serif}
main{display:flex;flex-direction:column;gap:12px;width:min(300px,86vw)}
h1{margin:0 0 2px;font-size:15px;font-weight:700;letter-spacing:.16em}
.sub{margin:0 0 14px;color:rgba(255,255,255,.5);font-size:14px;line-height:1.45}
form{display:flex;flex-direction:column;gap:12px}
input{padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1c1a17;color:inherit;font:inherit}
input:focus{outline:1px solid rgba(240,79,35,.55)}
a,button{display:flex;align-items:center;justify-content:center;gap:10px;padding:13px;border-radius:999px;border:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button{background:#f04f23;color:#fff}
.google{background:#fff;color:#1f1f1f}
.spotify{background:#1ed760;color:#000}
svg{width:18px;height:18px;flex:none}
.err{color:#ff8a6b;margin:0;font-size:14px;line-height:1.45}
.or{color:rgba(255,255,255,.35);font-size:12px;text-align:center;letter-spacing:.12em}</style></head><body>
<main><h1>ALBUM VIEWER</h1><p class=sub>Your albums as a row of spines on the wall.</p>{err}{buttons}</main>
</body></html>"""
G_ICON = ('<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z"/>'
          '<path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1A12 12 0 0 0 12 24z"/>'
          '<path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.2a12 12 0 0 0 0 10.8z"/>'
          '<path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.2 6.6l4.1 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>')
S_ICON = ('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12"/><path d="M6.5 9.3c3.6-1 7.6-.7 11 1M7 12.6c2.9-.8 6.1-.5 8.8.9M7.6 15.7c2.3-.6 4.7-.4 6.8.7" '
          'stroke="#1ed760" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>')


def _login_page(err: str = "") -> str:
    parts = []
    if google.configured():
        parts.append(f'<a class=google href="/auth/google/login">{G_ICON}Continue with Google</a>')
    if spotify.configured():
        parts.append(f'<a class=spotify href="/auth/spotify/login?mode=login">{S_ICON}Continue with Spotify</a>')
    if config.PASSWORD_SIGN_IN:
        if parts:
            parts.append('<div class=or>OR</div>')
        parts.append('<form method=post action=/login><input type=password name=password placeholder=Password '
                     'autocomplete=current-password required><button>Sign in</button></form>')
    return (LOGIN_HTML.replace("{err}", f"<p class=err>{html.escape(err)}</p>" if err else "")
            .replace("{buttons}", "".join(parts)))


@app.get("/login", include_in_schema=False)
def login_page(error: str | None = None):
    return HTMLResponse(_login_page((error or "")[:300]))


@app.post("/login", include_in_schema=False)
async def login(request: Request):
    addr = request.client.host if request.client else "unknown"
    now = time.time()
    wait = _login_wait(addr, now)
    if wait:   # checked before the password, so a locked-out guesser learns nothing
        mins = max(1, round(wait / 60))
        return HTMLResponse(_login_page(f"Too many attempts. Try again in {mins} minute{'' if mins == 1 else 's'}."),
                            status_code=429, headers={"Retry-After": str(wait)})
    if not config.PASSWORD_SIGN_IN:
        return HTMLResponse(_login_page("Sign in with Google or Spotify"), status_code=400)
    form = await request.form()
    if hmac.compare_digest(str(form.get("password", "")).encode(), APP_PASSWORD.encode()):
        with _fails_lock:
            _fails.pop(addr, None)
        r = RedirectResponse("/", status_code=303)
        _set_session(r, users.new_session(OWNER_ID))   # the password is the owner's
        return r
    _login_failed(addr, now)
    await asyncio.sleep(0.4)
    return HTMLResponse(_login_page("Wrong password"), status_code=401)


@app.post("/logout", include_in_schema=False)
def logout(request: Request):
    users.end_session(request.cookies.get(COOKIE))
    r = RedirectResponse("/login", status_code=303)
    r.delete_cookie(COOKIE)
    return r


# ---------------------------------------------------------------- Google and Spotify sign-in

def _start_flow(provider: str, *, verifier: str | None = None, user_id: int | None = None, app_challenge: str | None = None) -> str:
    state = secrets.token_urlsafe(24)
    now = time.time()
    with db.tx() as c:
        c.execute("DELETE FROM oauth_flows WHERE expires_at < ?", (now,))
        c.execute("INSERT INTO oauth_flows(state, provider, verifier, user_id, app_challenge, expires_at) VALUES(?,?,?,?,?,?)",
                  (state, provider, verifier, user_id, app_challenge, now + 600))
    return state


def _flow_redirect(url: str, state: str) -> RedirectResponse:
    # The cookie ties the flow to the browser that started it, so no one can finish a sign-in they
    # started in someone else's browser (and sign that person in to the wrong account).
    r = RedirectResponse(url)
    r.set_cookie(FLOW_COOKIE, state, max_age=600, httponly=True, samesite="lax", secure=PUBLIC_URL.startswith("https"))
    return r


def _take_flow(request: Request, provider: str, state: str | None) -> dict | None:
    if not state or not hmac.compare_digest(state.encode(), request.cookies.get(FLOW_COOKIE, "").encode()):
        return None
    row = db.one("SELECT * FROM oauth_flows WHERE state=? AND provider=?", (state, provider))
    with db.tx() as c:
        c.execute("DELETE FROM oauth_flows WHERE state=?", (state,))
    return row if row and row["expires_at"] > time.time() else None


def _app_challenge(app_: str | None, challenge: str | None) -> str | None:
    if not app_:
        return None
    if not challenge or not 43 <= len(challenge) <= 128 or not all(ch.isalnum() or ch in "-_" for ch in challenge):
        raise HTTPException(400, "The app's sign-in request was malformed")
    return challenge


def _flow_error(flow: dict | None, message: str) -> RedirectResponse:
    if flow and flow.get("app_challenge"):
        r = RedirectResponse(f"{APP_SCHEME}://auth?error={quote(message)}", status_code=303)
    elif flow and flow.get("user_id"):
        r = RedirectResponse(f"/?spotify_error={quote(message)}", status_code=303)
    else:
        r = RedirectResponse(f"/login?error={quote(message)}", status_code=303)
    r.delete_cookie(FLOW_COOKIE)
    return r


def _finish_sign_in(uid: int, flow: dict, dest: str = "/") -> RedirectResponse:
    if flow.get("app_challenge"):   # hand it to the Android app, which trades the code for its own session
        r = RedirectResponse(f"{APP_SCHEME}://auth?code={users.new_app_code(uid, flow['app_challenge'])}", status_code=303)
    else:
        r = RedirectResponse(dest, status_code=303)
        _set_session(r, users.new_session(uid))
    r.delete_cookie(FLOW_COOKIE)
    return r


@app.get("/auth/google/login", include_in_schema=False)
def google_login(app_: str | None = Query(None, alias="app"), challenge: str | None = None):
    if not google.configured():
        return RedirectResponse("/login?error=" + quote("Google sign-in isn't set up on this server"), status_code=303)
    verifier = secrets.token_urlsafe(48)
    state = _start_flow("google", verifier=verifier, app_challenge=_app_challenge(app_, challenge))
    return _flow_redirect(google.authorize_url(state, users.challenge_of(verifier)), state)


@app.get("/auth/google/callback", include_in_schema=False)
def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    flow = _take_flow(request, "google", state)
    if not flow:
        return _flow_error(None, "That sign-in took too long or came from another browser. Try again.")
    if error or not code:
        return _flow_error(flow, "Google sign-in was cancelled" if error in (None, "access_denied") else f"Google: {error}")
    try:
        claims = google.exchange(code, flow["verifier"])
    except google.GoogleError as e:
        return _flow_error(flow, str(e))
    return _finish_sign_in(users.from_google(claims)["id"], flow)


@app.post("/auth/app/exchange", include_in_schema=False)
def app_exchange(body: dict = Body(...)):
    """The Android app trades the one-time code from a browser sign-in for a session of its own."""
    uid = users.redeem_app_code(str(body.get("code") or ""), str(body.get("verifier") or ""))
    if not uid:
        raise HTTPException(400, "That sign-in didn't go through. Try again.")
    r = JSONResponse({"ok": True})
    _set_session(r, users.new_session(uid))
    return r


@app.get("/api/me")
def whoami(request: Request):
    u = _user(request)
    hidden = [r["album_id"] for r in db.query("SELECT album_id FROM hidden WHERE user_id=? AND album_id LIKE 'dev_%'", (u["id"],))]
    return {**users.public(u), "spotify": {"configured": spotify.configured(), "connected": spotify.connected(u["id"])},
            "device_hidden": hidden}


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
        "id": a["id"], "source": a["source"], "kind": a.get("kind") or "album", "title": a["title"], "artist": a["artist"],
        "year": a["year"], "uri": a["uri"], "color": a["color"] or "#333333", "text_color": a["text_color"] or "#f4f1ea",
        "art": _art_url(a),
        "art_status": a["art_status"], "art_source": a["art_source"], "hidden": bool(a.get("is_hidden")),
        "added_at": a.get("shelved_at") or a["added_at"], "tracks": a.get("n_tracks"),
    }


# What each person sees: the demo shelf, their own Spotify albums and playlists, and (for the admin)
# the server's music folder. Music on someone's own device never reaches the server.
_SHELF = ("""SELECT a.*, COALESCE(a.track_count, (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id)) AS n_tracks,
             s.added_at AS shelved_at, EXISTS(SELECT 1 FROM hidden h WHERE h.user_id=:uid AND h.album_id=a.id) AS is_hidden
             FROM albums a LEFT JOIN shelf s ON s.album_id=a.id AND s.user_id=:uid
             WHERE (a.source='demo' OR (a.source='local' AND :admin=1) OR (a.source='spotify' AND s.user_id IS NOT NULL))""")


def _params(u: dict, **more) -> dict:
    return {"uid": u["id"], "admin": 1 if u["admin"] else 0, **more}


def _visible(u: dict, album_id: str) -> dict | None:
    return db.one(_SHELF + " AND a.id=:id", _params(u, id=album_id))


def _album_detail(u: dict, album_id: str) -> dict:
    a = _visible(u, album_id)
    if not a:
        raise HTTPException(404, "Album not found")
    out = _album_out(a)
    if out["kind"] == "playlist":
        try:
            out["track_list"], out["tracks_shared"] = spotify.playlist_tracks(u["id"], album_id)
        except spotify.SpotifyError:
            out["track_list"], out["tracks_shared"] = [], False
    else:
        out["track_list"] = db.query("SELECT id, title, artist, track_no, disc_no, duration, uri FROM tracks WHERE album_id=? "
                                     "ORDER BY disc_no, track_no, title", (album_id,))
    return out


@app.get("/api/albums")
def list_albums(request: Request, source: str | None = None, include_hidden: bool = False):
    u = _user(request)
    sql, p = _SHELF, _params(u)
    if source in ("local", "spotify", "demo"):
        sql += " AND a.source=:source"
        p["source"] = source
    elif source == "playlist":
        sql += " AND a.kind='playlist'"
    if not include_hidden:
        sql += " AND NOT EXISTS(SELECT 1 FROM hidden h WHERE h.user_id=:uid AND h.album_id=a.id)"
    sql += " ORDER BY a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE"
    pos = {aid: i for i, aid in enumerate(users.order(u["id"]))}
    return [{**_album_out(a), "pos": pos.get(a["id"])} for a in db.query(sql, p)]


@app.get("/api/order")
def get_order(request: Request):
    return {"ids": users.order(_user(request)["id"])}


@app.put("/api/order")
def save_order(request: Request, body: dict = Body(...)):
    """This person's manual shelf order (the 'Manual order' arrangement), shared by all their screens."""
    ids = [str(i) for i in body.get("ids", [])][:20000]
    users.set_order(_user(request)["id"], ids)
    return {"ok": True, "count": len(ids)}


@app.get("/api/albums/{album_id}")
def get_album(request: Request, album_id: str):
    return _album_detail(_user(request), album_id)


@app.patch("/api/albums/{album_id}")
def update_album(request: Request, album_id: str, body: dict = Body(...)):
    u = _user(request)
    on_device = album_id.startswith("dev_")   # music on one of their own devices: only that device knows it
    if not on_device and not _visible(u, album_id):
        raise HTTPException(404, "Album not found")
    if "hidden" in body:
        with db.tx() as c:
            if body["hidden"]:
                c.execute("INSERT OR IGNORE INTO hidden(user_id, album_id) VALUES(?,?)", (u["id"], album_id))
            else:
                c.execute("DELETE FROM hidden WHERE user_id=? AND album_id=?", (u["id"], album_id))
    return {"id": album_id, "hidden": bool(body.get("hidden"))} if on_device else _album_detail(u, album_id)


@app.post("/api/albums/{album_id}/art")
async def upload_art(request: Request, album_id: str, file: UploadFile = File(...)):
    u = _need_admin(request)
    data = await file.read(MAX_BODY + 1)
    if len(data) > MAX_BODY:
        raise HTTPException(413, f"Image is too large ({MAX_UPLOAD_MB} MB max)")
    saved = artwork.save_art(album_id, data)
    if not saved:
        raise HTTPException(400, "Not an image")
    with db.tx() as c:
        c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source='manual', color=?, text_color=? WHERE id=?",
                  (*saved, album_id))
    return _album_detail(u, album_id)


@app.post("/api/albums/{album_id}/art/search")
def refetch_art(request: Request, album_id: str, body: dict = Body(default={})):
    """Look the cover up online again, optionally with a corrected artist/album/song name."""
    u = _need_admin(request)
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
    return _album_detail(u, album_id)


@app.get("/art/{name}", include_in_schema=False)
def art(name: str):
    path = (ART_DIR / Path(name).name)
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


# ---------------------------------------------------------------- local library

@app.get("/api/status")
def status(request: Request):
    u = _user(request)
    admin = bool(u["admin"])
    return {
        "admin": admin,
        "library": library.status if admin else None,   # the music folder is the admin's
        "music_dir": str(MUSIC_DIR) if admin else None,
        "demo": {**demo.status, "albums": demo.count()},
        "spotify": {"configured": spotify.configured(), "connected": spotify.connected(u["id"]),
                    "redirect_uri": SPOTIFY_REDIRECT_URI, **spotify.status(u["id"])},
    }


@app.post("/api/library/rescan")
def rescan(request: Request, force_art: bool = False):
    _need_admin(request)
    return {"started": library.start_scan(force_art=force_art)}


@app.get("/api/local/stream/{track_id}")
def stream(request: Request, track_id: str):
    _need_admin(request)
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
def demo_load(request: Request):
    _need_admin(request)
    return {"started": demo.start_load()}


@app.delete("/api/demo")
def demo_remove(request: Request):
    _need_admin(request)
    demo.remove()
    return {"ok": True}


# ---------------------------------------------------------------- spotify

def _sp(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except spotify.SpotifyError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 502, str(e))


@app.get("/auth/spotify/login", include_in_schema=False)
def spotify_login(request: Request, mode: str | None = None, app_: str | None = Query(None, alias="app"), challenge: str | None = None):
    """Sign in with Spotify, or (when already signed in) connect Spotify to this account."""
    if not spotify.configured():
        return RedirectResponse("/login?error=" + quote("Spotify isn't set up on this server"), status_code=303)
    user = getattr(request.state, "user", None)
    connect_to = user["id"] if user and mode != "login" and not app_ else None
    state = _start_flow("spotify", user_id=connect_to, app_challenge=_app_challenge(app_, challenge))
    return _flow_redirect(spotify.authorize_url(state), state)


@app.get("/auth/spotify/callback", include_in_schema=False)
def spotify_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    flow = _take_flow(request, "spotify", state)
    if not flow:
        return _flow_error(None, "That sign-in took too long or came from another browser. Try again.")
    if error or not code:
        return _flow_error(flow, "Spotify sign-in was cancelled" if error in (None, "access_denied") else f"Spotify: {error}")
    try:
        tokens = spotify.exchange_code(code)
        profile = spotify.me(tokens["access_token"])
    except spotify.SpotifyError as e:
        return _flow_error(flow, str(e))
    if flow["user_id"]:   # connecting Spotify to someone already signed in
        try:
            users.link_spotify(flow["user_id"], profile)
        except ValueError as e:
            return _flow_error(flow, str(e))
        spotify.store_tokens(flow["user_id"], tokens)
        spotify.start_sync(flow["user_id"])
        r = RedirectResponse("/?spotify=connected", status_code=303)
        r.delete_cookie(FLOW_COOKIE)
        return r
    for row in db.query("SELECT a.user_id FROM spotify_auth a JOIN users u ON u.id=a.user_id WHERE u.spotify_id IS NULL"):
        try:   # an account connected before Spotify ids were kept (the owner's): learn it first
            users.set_spotify_id(row["user_id"], str(spotify.api(row["user_id"], "GET", "/me")["id"]))
        except spotify.SpotifyError:
            pass
    u = users.from_spotify(profile)
    spotify.store_tokens(u["id"], tokens)
    spotify.start_sync(u["id"])
    return _finish_sign_in(u["id"], flow, "/?spotify=connected")


@app.post("/api/spotify/disconnect")
def spotify_disconnect(request: Request):
    spotify.disconnect(_user(request)["id"])
    return {"ok": True}


@app.post("/api/spotify/sync")
def spotify_sync(request: Request):
    return {"started": spotify.start_sync(_user(request)["id"])}


@app.post("/api/spotify/add")
def spotify_add(request: Request, body: dict = Body(...)):
    u = _user(request)
    return _album_detail(u, _sp(spotify.add_by_link, u["id"], body.get("link", "")))


@app.get("/api/spotify/token")
def spotify_token(request: Request):
    """Short-lived access token for the Web Playback SDK in the browser."""
    return {"access_token": _sp(spotify.access_token, _user(request)["id"])}


@app.get("/api/spotify/devices")
def spotify_devices(request: Request):
    return _sp(spotify.devices, _user(request)["id"])


@app.get("/api/spotify/state")
def spotify_state(request: Request):
    return _sp(spotify.state, _user(request)["id"]) or {}


@app.post("/api/spotify/play")
def spotify_play(request: Request, body: dict = Body(...)):
    _sp(spotify.play, _user(request)["id"], body.get("uri"), body.get("offset"), body.get("device_id"))
    return {"ok": True}


@app.post("/api/spotify/control")
def spotify_control(request: Request, body: dict = Body(...)):
    _sp(spotify.control, _user(request)["id"], body.get("action"), body.get("device_id"), body.get("value"))
    return {"ok": True}


@app.post("/api/spotify/transfer")
def spotify_transfer(request: Request, body: dict = Body(...)):
    if not body.get("device_id"):
        raise HTTPException(400, "device_id is required")
    _sp(spotify.transfer, _user(request)["id"], body["device_id"], body.get("play", True))
    return {"ok": True}


# ---------------------------------------------------------------- frontend

@app.get("/", include_in_schema=False)
def index():
    v = asset_version()
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/style.css"', f'href="/style.css?v={v}"').replace('src="/app.js"', f'src="/app.js?v={v}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
