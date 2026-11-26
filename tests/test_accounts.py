"""Accounts: signing in with Google or Spotify, each person's own shelf, Spotify playlists, the
admin's music folder, and handing a sign-in to the Android app. Google and Spotify are faked."""
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from conftest import ROOT


def _state(r) -> str:
    assert r.status_code in (302, 307), r.text
    return parse_qs(urlparse(r.headers["location"]).query)["state"][0]


@pytest.fixture
def fake_google(monkeypatch):
    from app import google
    people = {}
    monkeypatch.setattr(google, "configured", lambda: True)
    monkeypatch.setattr(google, "exchange", lambda code, verifier: people[code])
    return people


def google_client(main, fake_google, sub, email, name="Someone", **query) -> TestClient:
    """A browser that signed in with Google as `email`."""
    c = TestClient(main.app)
    fake_google[sub] = {"sub": sub, "email": email, "email_verified": True, "name": name}
    state = _state(c.get("/auth/google/login", params=query, follow_redirects=False))
    r = c.get(f"/auth/google/callback?code={sub}&state={state}", follow_redirects=False)
    assert r.status_code == 303
    return c


# ---------------------------------------------------------------- Spotify, faked

ALBUM = {"id": "A" * 22, "name": "Saved Album", "uri": "spotify:album:" + "A" * 22, "release_date": "2001-01-01",
         "artists": [{"name": "Band"}], "images": [],
         "tracks": {"items": [{"id": "t1", "name": "One", "uri": "spotify:track:t1", "track_number": 1, "artists": [{"name": "Band"}]}]}}
MINE = {"id": "P" * 22, "name": "My Mix", "uri": "spotify:playlist:" + "P" * 22, "snapshot_id": "s1",
        "owner": {"id": "spuser1", "display_name": "Sam"}, "images": [], "items": {"total": 2}}
FOLLOWED = {"id": "F" * 22, "name": "Someone Else's", "uri": "spotify:playlist:" + "F" * 22, "snapshot_id": "s9",
            "owner": {"id": "other", "display_name": "Other"}, "images": [], "tracks": {"total": 40}}   # the old field name


@pytest.fixture
def fake_spotify(monkeypatch):
    from app import spotify
    profiles = {"good": {"id": "spuser1", "display_name": "Sam"}}

    def api(uid, method, path, **kw):
        if path.startswith("/me/albums"):
            return {"items": [{"album": ALBUM, "added_at": "2024-05-01T00:00:00Z"}], "next": None}
        if path.startswith("/me/playlists"):
            return {"items": [MINE, FOLLOWED], "next": None}
        if path.startswith(f"/playlists/{MINE['id']}/items"):
            return {"items": [{"item": {"name": "First", "uri": "spotify:track:x1", "duration_ms": 1000, "artists": [{"name": "A"}]}},
                              {"item": None}], "next": None}   # a removed track still holds its place
        if path.startswith(f"/playlists/{FOLLOWED['id']}/items"):
            raise spotify.SpotifyError(403, "Forbidden")
        if path == "/me":
            return profiles["good"]
        raise AssertionError(path)

    def me(token):
        if token == "unlisted":
            raise spotify.SpotifyError(403, "This Spotify account isn't on Album Viewer's list yet.")
        return profiles[token]

    monkeypatch.setattr(spotify, "configured", lambda: True)
    monkeypatch.setattr(spotify, "api", api)
    monkeypatch.setattr(spotify, "me", me)
    monkeypatch.setattr(spotify, "exchange_code", lambda code: {"access_token": code, "refresh_token": "r-" + code, "expires_in": 3600})
    monkeypatch.setattr(spotify, "cache_art", lambda: None)
    monkeypatch.setattr(spotify, "start_sync", lambda uid: spotify.sync(uid) or True)   # at once, not in a thread
    return profiles


def spotify_client(main, token="good") -> tuple[TestClient, object]:
    c = TestClient(main.app)
    state = _state(c.get("/auth/spotify/login?mode=login", follow_redirects=False))
    return c, c.get(f"/auth/spotify/callback?code={token}&state={state}", follow_redirects=False)


# ---------------------------------------------------------------- tests

def test_google_sign_in_makes_an_account(main, fake_google):
    c = google_client(main, fake_google, "g-ana", "ana@example.com", "Ana")
    me = c.get("/api/me").json()
    assert (me["name"], me["email"], me["admin"], me["google"]) == ("Ana", "ana@example.com", False, True)
    again = google_client(main, fake_google, "g-ana", "ana@example.com", "Ana")
    assert again.get("/api/me").json()["id"] == me["id"]


def test_the_admin_is_the_google_account_named_in_admin_email(main, fake_google, monkeypatch, library_scanned):
    from app import config
    monkeypatch.setattr(config, "ADMIN_EMAIL", "owner@example.com")
    c = google_client(main, fake_google, "g-owner", "Owner@Example.com")
    assert c.get("/api/me").json()["admin"] is True
    assert any(a["source"] == "local" for a in c.get("/api/albums").json())


def test_people_only_see_their_own_shelf(main, signed_in, fake_google, library_scanned):
    local = [a for a in signed_in.get("/api/albums").json() if a["source"] == "local"]
    assert local                                                    # the owner sees the music folder
    guest = google_client(main, fake_google, "g-bo", "bo@example.com")
    assert all(a["source"] != "local" for a in guest.get("/api/albums").json())
    assert guest.get(f"/api/albums/{local[0]['id']}").status_code == 404
    track = signed_in.get(f"/api/albums/{local[0]['id']}").json()["track_list"][0]["id"]
    assert guest.get(f"/api/local/stream/{track}").status_code == 403
    assert signed_in.get(f"/api/local/stream/{track}").status_code == 200
    for method, path in (("post", "/api/library/rescan"), ("post", "/api/demo/load"), ("delete", "/api/demo")):
        assert getattr(guest, method)(path).status_code == 403, path
    st = guest.get("/api/status").json()
    assert st["admin"] is False and st["library"] is None and st["music_dir"] is None


def test_order_and_hidden_albums_are_each_persons_own(main, fake_google):
    a = google_client(main, fake_google, "g-cy", "cy@example.com")
    b = google_client(main, fake_google, "g-di", "di@example.com")
    a.put("/api/order", json={"ids": ["dev_1", "dev_2"]})
    assert a.get("/api/order").json()["ids"] == ["dev_1", "dev_2"]
    assert b.get("/api/order").json()["ids"] == []
    assert a.patch("/api/albums/dev_1", json={"hidden": True}).json() == {"id": "dev_1", "hidden": True}
    assert a.get("/api/me").json()["device_hidden"] == ["dev_1"]
    assert b.get("/api/me").json()["device_hidden"] == []


def test_spotify_sign_in_brings_albums_and_playlists(main, fake_google, fake_spotify):
    c, r = spotify_client(main)
    assert r.status_code == 303 and r.headers["location"] == "/?spotify=connected"
    me = c.get("/api/me").json()
    assert me["spotify_id"] == "spuser1" and me["spotify"]["connected"] and me["name"] == "Sam"
    shelf = {a["id"]: a for a in c.get("/api/albums").json()}
    assert shelf["sp_" + ALBUM["id"]]["kind"] == "album"
    mine, followed = shelf["pl_" + MINE["id"]], shelf["pl_" + FOLLOWED["id"]]
    assert (mine["kind"], mine["artist"], mine["tracks"]) == ("playlist", "Sam", 2)
    assert followed["tracks"] == 40
    assert {a["id"] for a in c.get("/api/albums?source=playlist").json()} == {mine["id"], followed["id"]}

    detail = c.get(f"/api/albums/{mine['id']}").json()
    assert detail["tracks_shared"] is True
    assert [(t["track_no"], t["title"]) for t in detail["track_list"]] == [(1, "First"), (2, "Unavailable")]
    other = c.get(f"/api/albums/{followed['id']}").json()
    assert other["tracks_shared"] is False and other["track_list"] == []   # still playable, just not listed

    stranger = google_client(main, fake_google, "g-ed", "ed@example.com")
    assert not any(a["source"] == "spotify" for a in stranger.get("/api/albums").json())
    assert stranger.get(f"/api/albums/{mine['id']}").status_code == 404

    again, _ = spotify_client(main)
    assert again.get("/api/me").json()["id"] == me["id"]               # the same account each time


def test_spotify_accounts_not_on_the_apps_list_are_turned_away(main, fake_spotify):
    _, r = spotify_client(main, token="unlisted")
    assert r.status_code == 303 and r.headers["location"].startswith("/login?error=")
    assert "list" in parse_qs(urlparse(r.headers["location"]).query)["error"][0]


def test_connecting_spotify_to_a_google_account(main, fake_google, fake_spotify):
    from app import users
    c = google_client(main, fake_google, "g-fa", "fa@example.com")
    if users.by_spotify("spuser1"):          # an earlier test signed in with that Spotify account
        fake_spotify["good2"] = {"id": "spuser2", "display_name": "Fa"}
        token = "good2"
    else:
        token = "good"
    state = _state(c.get("/auth/spotify/login", follow_redirects=False))
    r = c.get(f"/auth/spotify/callback?code={token}&state={state}", follow_redirects=False)
    assert r.headers["location"] == "/?spotify=connected"
    me = c.get("/api/me").json()
    assert me["spotify"]["connected"] and me["google"]


def test_the_android_app_connects_spotify_through_a_one_time_link(main, fake_google, fake_spotify):
    from app import users
    phone = google_client(main, fake_google, "g-ji", "ji@example.com")
    url = phone.post("/api/spotify/connect-link").json()["url"]
    assert url.startswith("http://127.0.0.1:8000/auth/spotify/start?flow=")
    browser = TestClient(main.app)                     # a browser tab: not signed in
    state = _state(browser.get(url[len("http://127.0.0.1:8000"):], follow_redirects=False))
    fake_spotify["good3"] = {"id": "spuser3", "display_name": "Ji"}
    r = browser.get(f"/auth/spotify/callback?code=good3&state={state}", follow_redirects=False)
    assert r.headers["location"] == f"{main.APP_SCHEME}://auth?connected=spotify"
    me = phone.get("/api/me").json()
    assert me["spotify"]["connected"] and me["spotify_id"] == "spuser3" and me["google"]
    assert users.by_spotify("spuser3")["id"] == me["id"]      # one account, not a second one
    r = browser.get(url[len("http://127.0.0.1:8000"):], follow_redirects=False)   # used up
    assert r.headers["location"].startswith(f"{main.APP_SCHEME}://auth?error=")


def test_a_sign_in_started_in_another_browser_is_refused(main, fake_google):
    fake_google["g-gi"] = {"sub": "g-gi", "email": "gi@example.com", "email_verified": True}
    starter, other = TestClient(main.app), TestClient(main.app)
    state = _state(starter.get("/auth/google/login", follow_redirects=False))
    r = other.get(f"/auth/google/callback?code=g-gi&state={state}", follow_redirects=False)
    assert r.headers["location"].startswith("/login?error=")
    assert other.get("/api/me").status_code == 401


def test_the_android_app_gets_the_sign_in_through_a_one_time_code(main, fake_google):
    from app import users
    verifier = "v" * 50
    challenge = users.challenge_of(verifier)
    fake_google["g-hu"] = {"sub": "g-hu", "email": "hu@example.com", "email_verified": True}

    def code_from_browser() -> str:
        browser = TestClient(main.app)
        state = _state(browser.get(f"/auth/google/login?app=1&challenge={challenge}", follow_redirects=False))
        r = browser.get(f"/auth/google/callback?code=g-hu&state={state}", follow_redirects=False)
        loc = r.headers["location"]
        assert loc.startswith(f"{main.APP_SCHEME}://auth?code=")
        assert "av_session" not in browser.cookies                    # the browser itself isn't signed in
        return parse_qs(urlparse(loc).query)["code"][0]

    app_client = TestClient(main.app)
    code = code_from_browser()
    assert app_client.post("/auth/app/exchange", json={"code": code, "verifier": "w" * 50}).status_code == 400
    assert app_client.post("/auth/app/exchange", json={"code": code, "verifier": verifier}).status_code == 400   # used up
    code = code_from_browser()
    assert app_client.post("/auth/app/exchange", json={"code": code, "verifier": verifier}).status_code == 200
    assert app_client.get("/api/me").json()["email"] == "hu@example.com"
    assert TestClient(main.app).get("/auth/google/login?app=1&challenge=short", follow_redirects=False).status_code == 400


def test_password_is_off_once_google_is_set_up(main, client, fake_google, monkeypatch):
    from app import config
    from conftest import PASSWORD
    monkeypatch.setattr(config, "PASSWORD_SIGN_IN", False)
    page = client.get("/login").text
    assert "Continue with Google" in page and 'type=password' not in page
    assert client.post("/login", data={"password": PASSWORD}, follow_redirects=False).status_code == 400


def test_the_single_user_setup_becomes_the_owners_account():
    """A server from before accounts: its Spotify sign-in, shelf, hidden albums and order move to the owner."""
    d = Path(tempfile.mkdtemp())
    db = sqlite3.connect(d / "albumviewer.db")
    db.executescript("""CREATE TABLE albums (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
        year TEXT, uri TEXT, remote_art TEXT, art_file TEXT, art_status TEXT DEFAULT 'pending', art_source TEXT, color TEXT,
        text_color TEXT, folder TEXT, added_at REAL, hidden INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, seen INTEGER DEFAULT 1);
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO albums(id, source, title, artist, added_at, pinned) VALUES('sp_x', 'spotify', 'X', 'Y', 5, 1);
        INSERT INTO albums(id, source, title, artist, hidden) VALUES('loc_z', 'local', 'Z', 'W', 1);
        INSERT INTO kv VALUES('spotify_refresh_token', 'refresh'), ('spotify_access_token', 'access'),
                             ('spotify_expires_at', '0'), ('order', '["loc_z","sp_x"]');""")
    db.commit()
    db.close()
    env = {**os.environ, "DATA_DIR": str(d), "MUSIC_DIR": str(d / "music"), "APP_PASSWORD": "x" * 12, "RESCAN_MINUTES": "0"}
    code = ("import app.main as m, app.db as db, app.users as u; o = m.OWNER_ID; "
            "print(db.one('SELECT refresh_token FROM spotify_auth WHERE user_id=?', (o,))['refresh_token'], "
            "[r['album_id'] for r in db.query('SELECT album_id FROM shelf WHERE user_id=? AND pinned=1', (o,))], "
            "[r['album_id'] for r in db.query('SELECT album_id FROM hidden WHERE user_id=?', (o,))], u.order(o), "
            "db.kv_get('spotify_refresh_token'))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, check=True).stdout
    assert out.strip() == "refresh ['sp_x'] ['loc_z'] ['loc_z', 'sp_x'] None"
