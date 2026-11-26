"""The music folder: scanning, streaming with seeking, and staying inside the folder."""
from app import db
from conftest import DATA, png_bytes


def _local(signed_in):
    return {a["title"]: a for a in signed_in.get("/api/albums?source=local").json()}


def test_scan_groups_files_into_albums(signed_in, library_scanned):
    albums = _local(signed_in)
    assert set(albums) == {"First Album", "Single Song"}
    first = albums["First Album"]
    assert first["artist"] == "The Testers" and first["tracks"] == 2
    assert first["art"].startswith("/art/")              # cover.png in the folder
    assert first["art_source"] == "folder"
    detail = signed_in.get(f"/api/albums/{first['id']}").json()
    assert [(t["track_no"], t["title"]) for t in detail["track_list"]] == [(1, "Opening"), (2, "Closing")]
    assert abs(detail["track_list"][0]["duration"] - 1.0) < 0.05
    single = albums["Single Song"]
    assert single["artist"] == "Loose Artist" and single["art_status"] == "missing"   # online lookup is off


def test_cover_art_is_served(signed_in, library_scanned):
    art = _local(signed_in)["First Album"]["art"]
    r = signed_in.get(art)
    assert r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff"   # stored as JPEG
    assert r.headers["cache-control"] == "private, max-age=604800"     # never kept by Cloudflare


def test_stream_supports_seeking(signed_in, library_scanned):
    first = _local(signed_in)["First Album"]
    track = signed_in.get(f"/api/albums/{first['id']}").json()["track_list"][0]
    full = signed_in.get(f"/api/local/stream/{track['id']}")
    assert full.status_code == 200 and full.content[:4] == b"RIFF"
    part = signed_in.get(f"/api/local/stream/{track['id']}", headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == full.content[100:200]
    assert part.headers["content-range"].startswith("bytes 100-199/")


def test_stream_refuses_files_outside_the_music_folder(signed_in, library_scanned):
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO tracks(id, album_id, title, path) VALUES('evil', 'x', 'x', ?)",
                  (str(DATA / "albumviewer.db"),))
    assert signed_in.get("/api/local/stream/evil").status_code == 404
    assert signed_in.get("/api/local/stream/no-such-track").status_code == 404


def test_art_paths_cannot_escape(signed_in):
    assert signed_in.get("/art/..%2F..%2Fapp%2Fconfig.py").status_code == 404
    assert signed_in.get("/art/..%5C.secret").status_code == 404


def test_upload_cover(signed_in, library_scanned):
    single = _local(signed_in)["Single Song"]
    r = signed_in.post(f"/api/albums/{single['id']}/art", files={"file": ("c.png", png_bytes((20, 90, 200)), "image/png")})
    assert r.status_code == 200
    out = r.json()
    assert out["art_source"] == "manual" and out["art"].startswith("/art/")
    assert out["color"] != "#333333"


def test_upload_rejects_non_images(signed_in, library_scanned):
    single = _local(signed_in)["Single Song"]
    r = signed_in.post(f"/api/albums/{single['id']}/art", files={"file": ("c.png", b"not an image", "image/png")})
    assert r.status_code == 400


def test_upload_size_is_capped(signed_in, library_scanned):
    single = _local(signed_in)["Single Song"]
    big = b"\0" * (1024 * 1024 + 10)          # MAX_UPLOAD_MB is 1 in the tests
    r = signed_in.post(f"/api/albums/{single['id']}/art", files={"file": ("c.png", big, "image/png")})
    assert r.status_code == 413
