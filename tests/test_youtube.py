"""YouTube and YouTube Music: connecting a person's YouTube (a second Google sign-in), their
playlists and liked music on their shelf, track lists, adding by link, search, and disconnecting.
Google and YouTube are faked."""
import io
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from conftest import png_bytes


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


def google_client(main, fake_google, sub, email) -> TestClient:
    c = TestClient(main.app)
    fake_google[sub] = {"sub": sub, "email": email, "email_verified": True, "name": email.split("@")[0]}
    state = _state(c.get("/auth/google/login", follow_redirects=False))
    assert c.get(f"/auth/google/callback?code={sub}&state={state}", follow_redirects=False).status_code == 303
    return c


# ---------------------------------------------------------------- YouTube, faked

def video(vid, title, channel, seconds=200, category="10", kids=False, embeddable=True, description=""):
    return {"id": vid, "snippet": {"title": title, "channelTitle": channel, "categoryId": category, "description": description,
                                   "thumbnails": {"high": {"url": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"}}},
            "contentDetails": {"duration": f"PT{seconds // 60}M{seconds % 60}S"},
            "status": {"madeForKids": kids, "embeddable": embeddable}}


VIDEOS = {v["id"]: v for v in [
    video("dreams00001", "Dreams", "Fleetwood Mac - Topic", 257, description="Released on: 1977-02-04"),
    video("chain000001", "The Chain", "Fleetwood Mac - Topic", 271),
    video("musicvid001", "Some Band - A Song (Official Video)", "SomeBandVEVO", 245, embeddable=False),
    video("kidsong0001", "Baby Shark Dance", "Pinkfong", 136, kids=True),
    video("talkshow001", "My vlog", "Someone", 600, category="22"),
]}
MINE = {"id": "PLmine000001", "etag": "e1", "snippet": {"title": "Road trip", "channelTitle": "Sam",
                                                        "thumbnails": {"high": {"url": "https://i.ytimg.com/pl/mine.jpg"}}},
        "contentDetails": {"itemCount": 3}}
RUMOURS = {"id": "OLAK5uy_rumours000", "etag": "e2", "snippet": {"title": "Album - Rumours", "channelTitle": "Fleetwood Mac - Topic"},
           "contentDetails": {"itemCount": 2}}
SHARED = {**MINE, "id": "PLshared0001", "snippet": {"title": "Our mix", "channelTitle": "Ana"}}
ITEMS = {"PLmine000001": ["dreams00001", "deleted0001", "musicvid001"], "OLAK5uy_rumours000": ["dreams00001", "chain000001"],
         "PLshared0001": ["chain000001"]}


@pytest.fixture
def fake_youtube(monkeypatch):
    from app import youtube
    calls = []
    state = {"playlists": [MINE]}

    def api(uid, path, **p):
        calls.append((path, p))
        if path == "/channels":
            return {"items": [{"snippet": {"title": "Sam's channel"}}]}
        if path == "/playlists" and p.get("mine"):
            return {"items": state["playlists"]}
        if path == "/playlists":
            known = {MINE["id"]: MINE, RUMOURS["id"]: RUMOURS, SHARED["id"]: SHARED}
            return {"items": [known[i] for i in p["id"].split(",") if i in known]}
        if path == "/playlistItems":
            return {"items": [{"contentDetails": {"videoId": v}} for v in ITEMS[p["playlistId"]]]}
        if path == "/videos" and p.get("myRating") == "like":
            return {"items": [VIDEOS["kidsong0001"], VIDEOS["talkshow001"], VIDEOS["chain000001"]]}
        if path == "/videos":
            return {"items": [VIDEOS[i] for i in p["id"].split(",") if i in VIDEOS]}
        if path == "/search":
            return {"items": [
                {"id": {"kind": "youtube#playlist", "playlistId": RUMOURS["id"]},
                 "snippet": {"title": "Album - Rumours", "channelTitle": "Fleetwood Mac - Topic", "thumbnails": {}}},
                {"id": {"kind": "youtube#video", "videoId": "dreams00001"},
                 "snippet": {"title": "Fleetwood Mac - Dreams (Official Music Video)", "channelTitle": "Fleetwood Mac", "thumbnails": {}}}]}
        raise AssertionError(path)

    def exchange(code, verifier):
        assert verifier, "the PKCE secret goes with the code"
        if code == "unticked":
            raise youtube.YouTubeError(403, "Album Viewer needs to see your YouTube playlists")
        return {"access_token": "at-" + code, "refresh_token": "rt-" + code, "expires_in": 3600, "scope": youtube.SCOPE}

    revoked = []

    class Http:   # Google's revoke endpoint
        def post(self, url, data=None, **kw):
            revoked.append((url, data))
            return type("R", (), {"status_code": 200})()

    monkeypatch.setattr(youtube, "configured", lambda: True)
    monkeypatch.setattr(youtube, "api", api)
    monkeypatch.setattr(youtube, "exchange_code", exchange)
    monkeypatch.setattr(youtube, "cache_art", lambda: None)
    monkeypatch.setattr(youtube, "start_sync", lambda uid: youtube.sync(uid) or True)   # at once, not in a thread
    monkeypatch.setattr(youtube, "_http", Http())
    youtube._searches.clear()
    return {"calls": calls, "state": state, "revoked": revoked}


def connect(main, c: TestClient, code="good"):
    r = c.get("/auth/youtube/login", follow_redirects=False)
    state = _state(r)
    return r, c.get(f"/auth/google/callback?code={code}&state={state}", follow_redirects=False)


# ---------------------------------------------------------------- tests

def test_privacy_and_terms_cover_youtube(client):
    privacy = client.get("/privacy").text
    for needed in ("YouTube API Services", "https://www.google.com/policies/privacy",
                   "https://security.google.com/settings/security/permissions", "30 days"):
        assert needed in privacy
    terms = client.get("/terms")
    assert terms.status_code == 200 and "https://www.youtube.com/t/terms" in terms.text
    assert "agree to be bound by" in terms.text
    assert 'href=/terms' in client.get("/login").text


def test_connecting_youtube_asks_google_for_read_only_access(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt1", "yt1@example.com")
    r, done = connect(main, c)
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["scope"] == ["https://www.googleapis.com/auth/youtube.readonly"]
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"] and q["login_hint"] == ["yt1@example.com"]
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"][0].endswith("/auth/google/callback")
    assert done.status_code == 303 and done.headers["location"] == "/?youtube=connected"
    me = c.get("/api/me").json()
    assert me["youtube"] == {"configured": True, "connected": True}
    st = c.get("/api/status").json()["youtube"]
    assert st["connected"] and st["channel"] == "Sam's channel" and st["error"] is None


def test_a_connection_without_the_youtube_permission_is_refused(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt2", "yt2@example.com")
    _, done = connect(main, c, code="unticked")
    assert done.headers["location"].startswith("/?youtube_error=")
    assert c.get("/api/me").json()["youtube"]["connected"] is False


def test_their_playlists_albums_and_likes_come_onto_their_shelf_only(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt3", "yt3@example.com")
    connect(main, c)
    me = c.get("/api/me").json()
    shelf = {a["id"]: a for a in c.get("/api/albums?source=youtube").json()}
    mine, likes = shelf["yt_PLmine000001"], shelf[f"yl_{me['id']}"]
    assert (mine["kind"], mine["title"], mine["tracks"]) == ("playlist", "Road trip", 3)
    assert mine["open_url"] == "https://music.youtube.com/playlist?list=PLmine000001"
    assert (likes["title"], likes["open_url"]) == ("Liked music", "https://music.youtube.com/playlist?list=LM")

    other = google_client(main, fake_google, "g-yt4", "yt4@example.com")
    assert not any(a["source"] == "youtube" for a in other.get("/api/albums").json())
    assert other.get("/api/albums/yt_PLmine000001").status_code == 404

    fake_youtube["state"]["playlists"] = []      # they deleted it on YouTube
    c.post("/api/youtube/sync")
    assert "yt_PLmine000001" not in {a["id"] for a in c.get("/api/albums").json()}


def test_a_playlist_lists_its_videos_when_opened(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt5", "yt5@example.com")
    connect(main, c)
    d = c.get("/api/albums/yt_PLmine000001").json()
    tracks = d["track_list"]
    assert [(t["track_no"], t["artist"], t["title"]) for t in tracks] == [(1, "Fleetwood Mac", "Dreams"), (2, "Some Band", "A Song")]
    assert tracks[0]["uri"] == "dreams00001" and tracks[0]["duration"] == 257 and tracks[0]["embeddable"] is True
    assert tracks[1]["embeddable"] is False          # the owner turned off playing outside YouTube
    assert d["tracks"] == 2                          # the deleted video is left out
    n = len(fake_youtube["calls"])
    c.get("/api/albums/yt_PLmine000001")             # listed once, then kept
    assert len(fake_youtube["calls"]) == n


def test_liked_music_is_the_music_among_their_likes(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt6", "yt6@example.com")
    connect(main, c)
    uid = c.get("/api/me").json()["id"]
    tracks = c.get(f"/api/albums/yl_{uid}").json()["track_list"]
    assert [t["title"] for t in tracks] == ["Baby Shark Dance", "The Chain"]   # not the vlog
    assert tracks[0]["kids"] is True and tracks[1]["kids"] is False


def test_adding_albums_and_songs_by_link(main, fake_google, fake_youtube):
    c = google_client(main, fake_google, "g-yt7", "yt7@example.com")
    assert c.post("/api/youtube/add", json={"link": "https://youtu.be/dreams00001"}).status_code == 400   # not connected yet
    connect(main, c)
    album = c.post("/api/youtube/add", json={"link": "https://music.youtube.com/playlist?list=OLAK5uy_rumours000&si=x"}).json()
    assert (album["id"], album["kind"], album["title"], album["artist"]) == ("yt_OLAK5uy_rumours000", "album", "Rumours", "Fleetwood Mac")
    assert [t["title"] for t in album["track_list"]] == ["Dreams", "The Chain"]
    assert c.get("/api/albums/yt_OLAK5uy_rumours000").json()["year"] == "1977"

    song = c.post("/api/youtube/add", json={"link": "https://www.youtube.com/watch?v=musicvid001&list=RDmusicvid001"}).json()
    assert (song["id"], song["title"], song["artist"], song["tracks"]) == ("yv_musicvid001", "A Song", "Some Band", 1)

    r = c.post("/api/youtube/add", json={"link": "https://music.youtube.com/browse/MPREb_abc"})
    assert r.status_code == 400 and "Share" in r.json()["detail"]
    assert c.post("/api/youtube/add", json={"link": "https://www.youtube.com/playlist?list=RDCLAK5uy_mix"}).status_code == 400
    assert c.post("/api/youtube/add", json={"link": "not a link"}).status_code == 400
    assert c.post("/api/youtube/add", json={"link": "https://youtu.be/missing0001"}).status_code == 404

    c.post("/api/youtube/sync")                      # what was added by link stays through syncs
    ids = {a["id"] for a in c.get("/api/albums").json()}
    assert {"yt_OLAK5uy_rumours000", "yv_musicvid001"} <= ids


def test_search_finds_albums_and_songs_and_is_rationed(main, fake_google, fake_youtube, monkeypatch):
    from app import youtube
    c = google_client(main, fake_google, "g-yt8", "yt8@example.com")
    connect(main, c)
    found = c.get("/api/youtube/search?q=rumours").json()
    assert found[0] == {"kind": "album", "id": "OLAK5uy_rumours000", "title": "Rumours", "artist": "Fleetwood Mac", "art": None}
    assert (found[1]["kind"], found[1]["artist"], found[1]["title"]) == ("song", "Fleetwood Mac", "Dreams")
    added = c.post("/api/youtube/add", json={"id": "dreams00001", "kind": "song"}).json()
    assert added["id"] == "yv_dreams00001" and added["year"] == "1977"
    monkeypatch.setattr(youtube, "SEARCHES_PER_PERSON", 1)
    r = c.get("/api/youtube/search?q=more")
    assert r.status_code == 429 and "link" in r.json()["detail"]


def test_disconnecting_revokes_access_and_deletes_what_came_from_youtube(main, fake_google, fake_youtube):
    from app import db
    fake_youtube["state"]["playlists"] = [SHARED]
    a = google_client(main, fake_google, "g-yt9", "yt9@example.com")
    b = google_client(main, fake_google, "g-yt10", "yt10@example.com")
    connect(main, a, code="a")
    connect(main, b, code="b")                       # both have "Our mix" (public) on their shelves
    a.get("/api/albums/yt_PLshared0001")
    assert a.post("/api/youtube/disconnect").json() == {"ok": True}
    assert fake_youtube["revoked"] == [("https://oauth2.googleapis.com/revoke", {"token": "rt-a"})]
    assert not any(x["source"] == "youtube" for x in a.get("/api/albums").json())
    assert a.get("/api/me").json()["youtube"]["connected"] is False
    assert "yt_PLshared0001" in {x["id"] for x in b.get("/api/albums").json()}   # still theirs
    b.post("/api/youtube/disconnect")
    assert db.one("SELECT 1 AS x FROM albums WHERE id='yt_PLshared0001'") is None
    assert db.one("SELECT 1 AS x FROM tracks WHERE album_id='yt_PLshared0001'") is None


def test_access_revoked_at_google_counts_as_disconnecting(main, fake_google, fake_youtube, monkeypatch):
    from app import db, youtube
    c = google_client(main, fake_google, "g-yt11", "yt11@example.com")
    connect(main, c)
    uid = c.get("/api/me").json()["id"]
    with db.tx() as x:
        x.execute("UPDATE youtube_auth SET expires_at=0 WHERE user_id=?", (uid,))

    class Revoked:
        status_code = 400
        def json(self): return {"error": "invalid_grant"}

    monkeypatch.setattr(youtube, "_http", type("H", (), {"post": lambda self, url, data=None, **kw: Revoked()})())
    with pytest.raises(youtube.YouTubeError):
        youtube.access_token(uid)
    assert not youtube.connected(uid)
    assert not any(a["source"] == "youtube" for a in c.get("/api/albums").json())


def test_a_spotify_sync_leaves_youtube_on_the_shelf(main, fake_google, fake_youtube, monkeypatch):
    from app import db, spotify
    c = google_client(main, fake_google, "g-yt12", "yt12@example.com")
    connect(main, c)
    uid = c.get("/api/me").json()["id"]
    with db.tx() as x:
        x.execute("INSERT OR REPLACE INTO spotify_auth(user_id, access_token, refresh_token, expires_at) VALUES(?, 'a', 'r', 9e9)", (uid,))
    monkeypatch.setattr(spotify, "api", lambda uid, method, path, **kw: {"id": "sp-yt12"} if path == "/me" else {"items": [], "next": None})
    monkeypatch.setattr(spotify, "cache_art", lambda: None)
    spotify.sync(uid)
    assert "yt_PLmine000001" in {a["id"] for a in c.get("/api/albums").json()}
    spotify.disconnect(uid)
    assert "yt_PLmine000001" in {a["id"] for a in c.get("/api/albums").json()}


def test_the_android_app_connects_youtube_through_a_one_time_link(main, fake_google, fake_youtube):
    phone = google_client(main, fake_google, "g-yt13", "yt13@example.com")
    url = phone.post("/api/youtube/connect-link").json()["url"]
    path = url[len("http://127.0.0.1:8000"):]
    assert path.startswith("/auth/youtube/start?flow=")
    browser = TestClient(main.app)                     # a browser tab: not signed in
    state = _state(browser.get(path, follow_redirects=False))
    r = browser.get(f"/auth/google/callback?code=phone&state={state}", follow_redirects=False)
    assert r.headers["location"] == f"{main.APP_SCHEME}://auth?connected=youtube"
    assert phone.get("/api/me").json()["youtube"]["connected"] is True


def test_reading_youtube():
    from app import youtube
    assert youtube._artist_title("Dreams", "Fleetwood Mac - Topic") == ("Fleetwood Mac", "Dreams")
    assert youtube._artist_title("Daft Punk - Get Lucky (Official Audio) ft. Pharrell", "DaftPunkVEVO") == ("Daft Punk", "Get Lucky ft. Pharrell")
    assert youtube._artist_title("Live at the hall", "SomeVEVO") == ("Some", "Live at the hall")
    assert youtube._artist_title("Rock &amp; Roll", "Band - Topic") == ("Band", "Rock & Roll")
    assert youtube._duration("PT1H2M3S") == 3723 and youtube._duration("PT45S") == 45 and youtube._duration("P0D") is None
    assert youtube._album_name("Album - Rumours (Super Deluxe)", "OLAK5uy_x") == ("Rumours (Super Deluxe)", True)
    assert youtube._album_name("Album - Rumours", "PLx") == ("Album - Rumours", False)


def test_youtube_frames_become_square_covers():
    from PIL import Image
    from app import artwork
    frame = Image.new("RGB", (480, 360), (0, 0, 0))   # a 4:3 thumbnail: a 16:9 frame between bars,
    frame.paste(Image.new("RGB", (270, 270), (200, 40, 30)), (105, 45))   # with a square cover in the middle
    buf = io.BytesIO()
    frame.save(buf, "PNG")
    out = Image.open(io.BytesIO(artwork.square_crop(buf.getvalue())))
    assert abs(out.width - out.height) <= 1 and 265 <= out.width <= 275
    r, g, b = out.getpixel((5, 5))
    assert r > 150 and g < 90                           # no black bars left
    plain = Image.open(io.BytesIO(artwork.square_crop(png_bytes(size=64))))
    assert plain.size == (64, 64)
