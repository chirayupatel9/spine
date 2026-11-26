"""Shelf features: manual order, hiding, the demo shelf, and Spotify's sign-in guard."""
from conftest import png_bytes


def test_manual_order_round_trip(signed_in, library_scanned):
    ids = [a["id"] for a in signed_in.get("/api/albums").json()]
    order = list(reversed(ids))
    assert signed_in.put("/api/order", json={"ids": order}).json()["count"] == len(order)
    pos = {a["id"]: a["pos"] for a in signed_in.get("/api/albums").json()}
    assert [pos[i] for i in order] == list(range(len(order)))


def test_hide_and_show(signed_in, library_scanned):
    aid = signed_in.get("/api/albums?source=local").json()[0]["id"]
    assert signed_in.patch(f"/api/albums/{aid}", json={"hidden": True}).json()["hidden"] is True
    assert aid not in {a["id"] for a in signed_in.get("/api/albums").json()}
    assert aid in {a["id"] for a in signed_in.get("/api/albums?include_hidden=true").json()}
    signed_in.patch(f"/api/albums/{aid}", json={"hidden": False})
    assert aid in {a["id"] for a in signed_in.get("/api/albums").json()}


def test_unknown_album_is_404(signed_in):
    assert signed_in.get("/api/albums/nope").status_code == 404


def test_demo_shelf_loads_and_removes(signed_in, monkeypatch):
    from app import artwork, demo

    def fake_lookup(ids):
        out = []
        for cid in ids:
            out.append({"wrapperType": "collection", "collectionId": cid, "collectionName": f"Album {cid} (Remastered)",
                        "artistName": "Demo Artist", "releaseDate": "1999-05-01T00:00:00Z",
                        "artworkUrl100": "https://example.invalid/100x100bb.jpg", "collectionViewUrl": "https://example.invalid"})
            for n in (1, 2):
                out.append({"wrapperType": "track", "kind": "song", "collectionId": cid, "trackId": cid * 10 + n,
                            "trackName": f"Song {n}", "artistName": "Demo Artist", "trackNumber": n, "discNumber": 1,
                            "previewUrl": f"https://example.invalid/{cid}-{n}.m4a"})
        return out

    monkeypatch.setattr(demo, "DEMO_IDS", [111, 222])
    monkeypatch.setattr(demo, "_lookup", fake_lookup)
    monkeypatch.setattr(demo.time, "sleep", lambda s: None)
    monkeypatch.setattr(artwork, "download", lambda url: png_bytes((30, 160, 90)))
    demo.load()
    assert demo.status["error"] is None

    albums = {a["title"]: a for a in signed_in.get("/api/albums?source=demo").json()}
    assert set(albums) == {"Album 111", "Album 222"}          # "(Remastered)" trimmed
    assert albums["Album 111"]["year"] == "1999" and albums["Album 111"]["art"].startswith("/art/")
    tracks = signed_in.get("/api/albums/demo-111").json()["track_list"]
    assert [t["uri"] for t in tracks] == ["https://example.invalid/111-1.m4a", "https://example.invalid/111-2.m4a"]

    assert signed_in.delete("/api/demo").json() == {"ok": True}
    assert signed_in.get("/api/albums?source=demo").json() == []
    assert signed_in.get("/api/status").json()["demo"]["albums"] == 0


def test_spotify_needs_keys_before_sign_in(signed_in):
    r = signed_in.get("/auth/spotify/login", follow_redirects=False)
    assert r.status_code == 400 and "SPOTIFY_CLIENT_ID" in r.json()["detail"]


def test_spotify_callback_checks_state(signed_in):
    r = signed_in.get("/auth/spotify/callback?code=abc&state=forged", follow_redirects=False)
    assert r.status_code == 400


def test_spotify_error_is_passed_back_safely(signed_in):
    r = signed_in.get("/auth/spotify/callback?error=access_denied%26x%3D1", follow_redirects=False)
    assert r.headers["location"] == "/?spotify_error=access_denied%26x%3D1"


def test_status(signed_in):
    st = signed_in.get("/api/status").json()
    assert st["spotify"]["configured"] is False
    assert st["spotify"]["redirect_uri"] == "http://127.0.0.1:8000/auth/spotify/callback"
