"""Demo shelf: real albums from the iTunes catalogue with 30-second previews.

Lets Album Viewer run as a working model with no Spotify account and no music folder. The
covers are cached like any other artwork, so spines get their colour the same way.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import artwork, db
from .config import ART_DIR

log = logging.getLogger("albumviewer.demo")

# iTunes collection IDs (UK storefront), resolved once with the Search API.
DEMO_IDS = [
    1716598034,  # Buena Vista Social Club
    594061854,   # Fleetwood Mac - Rumours
    1065973975,  # Pink Floyd - Wish You Were Here
    268443092,   # Miles Davis - Kind of Blue
    1109714933,  # Radiohead - In Rainbows
    617154241,   # Daft Punk - Random Access Memories
    1440871877,  # Kendrick Lamar - To Pimp a Butterfly
    1538081586,  # Marvin Gaye - What's Going On
    1492263092,  # Joni Mitchell - Blue
    6829015491,  # Stevie Wonder - Songs in the Key of Life
    1474815798,  # The Beatles - Abbey Road
    1428684976,  # Massive Attack - Mezzanine
    1440653096,  # Portishead - Dummy
    1276760743,  # Lauryn Hill - The Miseducation of Lauryn Hill
    663097964,   # Arctic Monkeys - AM
    1440713018,  # John Coltrane - A Love Supreme
    1039796877,  # David Bowie - Ziggy Stardust
    1746833068,  # Prince - Purple Rain
    269572838,   # Michael Jackson - Thriller
    300948043,   # Talking Heads - Remain in Light
    800092985,   # The Smiths - The Queen Is Dead
    1450695723,  # Billie Eilish - When We All Fall Asleep, Where Do We Go?
    1524793738,  # Taylor Swift - folklore
    1767463815,  # Khruangbin - Con Todo El Mundo
    1568988846,  # Nina Simone - Little Girl Blue
    1625213430,  # Bob Marley & The Wailers - Exodus
    1440851613,  # The Velvet Underground & Nico
    697240234,   # Air - Moon Safari
    850571319,   # Gorillaz - Demon Days
    211429791,   # Sade - Diamond Life
    559710299,   # Fela Kuti - Zombie
    158571524,   # Herbie Hancock - Head Hunters
    581797918,   # The Strokes - Angles
    1440764608,  # Erykah Badu - New Amerykah Pt. 2
]
BATCH = 8

status: dict = {"loading": False, "albums": 0, "total": len(DEMO_IDS), "error": None}
_lock = threading.Lock()


def _clean_title(name: str) -> str:
    for junk in (" (2019 Mix)", " (2012 Remaster)", " (2013 Remaster)", " (2021 - Stereo Remaster)",
                 " (45th Anniversary Edition)", " (Deluxe)", " (Remastered)"):
        name = name.replace(junk, "")
    return name


def _lookup(ids: list[int]) -> list[dict]:
    r = artwork._http.get("https://itunes.apple.com/lookup",
                          params={"id": ",".join(map(str, ids)), "entity": "song", "limit": 200, "country": "GB"})
    if r.status_code != 200:
        raise RuntimeError(f"iTunes lookup failed ({r.status_code})")
    return r.json().get("results", [])


def _save_cover(row: dict) -> None:
    data = artwork.download(row["art_url"])
    saved = artwork.save_art(row["id"], data) if data else None
    with db.tx() as c:
        if saved:
            c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source='itunes', color=?, text_color=? WHERE id=?",
                      (*saved, row["id"]))
        else:
            color, text = artwork.placeholder_color(row["id"])
            c.execute("UPDATE albums SET art_status='missing', color=?, text_color=? WHERE id=?", (color, text, row["id"]))


def load() -> None:
    status.update(loading=True, albums=0, error=None)
    try:
        now = time.time()
        pending_art: list[dict] = []
        for start in range(0, len(DEMO_IDS), BATCH):
            if start:
                time.sleep(3.3)  # iTunes allows roughly 20 requests a minute
            results = _lookup(DEMO_IDS[start:start + BATCH])
            albums = {x["collectionId"]: x for x in results if x.get("wrapperType") == "collection"}
            tracks: dict[int, list[dict]] = {}
            for x in results:
                if x.get("wrapperType") == "track" and x.get("kind") == "song" and x.get("previewUrl"):
                    tracks.setdefault(x["collectionId"], []).append(x)
            with db.tx() as c:
                for cid, alb in albums.items():
                    aid = f"demo-{cid}"
                    order = DEMO_IDS.index(cid) if cid in DEMO_IDS else 0
                    art_url = artwork._itunes_hi_res(alb.get("artworkUrl100", "")).replace("1200x1200", "800x800")
                    c.execute(
                        """INSERT INTO albums(id, source, title, artist, year, uri, remote_art, added_at, seen)
                           VALUES(?, 'demo', ?, ?, ?, ?, ?, ?, 1)
                           ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                             year=excluded.year, uri=excluded.uri, remote_art=excluded.remote_art""",
                        (aid, _clean_title(alb.get("collectionName", "")), alb.get("artistName", ""),
                         (alb.get("releaseDate") or "")[:4] or None, alb.get("collectionViewUrl"), art_url,
                         now - order * 3600))
                    c.execute("DELETE FROM tracks WHERE album_id=?", (aid,))
                    c.executemany(
                        "INSERT OR REPLACE INTO tracks(id, album_id, title, artist, track_no, disc_no, duration, uri) "
                        "VALUES(?,?,?,?,?,?,?,?)",
                        [(f"demo-{t['trackId']}", aid, t.get("trackName", ""), t.get("artistName"),
                          t.get("trackNumber"), t.get("discNumber") or 1, 30.0, t["previewUrl"])
                         for t in tracks.get(cid, [])])
                    pending_art.append({"id": aid, "art_url": art_url})
            status["albums"] = db.one("SELECT COUNT(*) AS n FROM albums WHERE source='demo'")["n"]

        missing = {r["id"] for r in db.query("SELECT id FROM albums WHERE source='demo' AND art_file IS NULL")}
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(_save_cover, [r for r in pending_art if r["id"] in missing]))
        status["albums"] = db.one("SELECT COUNT(*) AS n FROM albums WHERE source='demo'")["n"]
        log.info("Demo shelf loaded: %s albums", status["albums"])
    except Exception as e:  # network down, rate limited...
        log.warning("Demo shelf failed: %s", e)
        status["error"] = str(e)
    finally:
        status["loading"] = False


def start_load() -> bool:
    with _lock:
        if status["loading"]:
            return False
        status["loading"] = True
    threading.Thread(target=load, daemon=True, name="demo-load").start()
    return True


def remove() -> None:
    rows = db.query("SELECT art_file FROM albums WHERE source='demo'")
    with db.tx() as c:
        c.execute("DELETE FROM tracks WHERE album_id IN (SELECT id FROM albums WHERE source='demo')")
        c.execute("DELETE FROM albums WHERE source='demo'")
    for r in rows:
        if r["art_file"]:
            (ART_DIR / r["art_file"]).unlink(missing_ok=True)
    status["albums"] = 0


def count() -> int:
    return db.one("SELECT COUNT(*) AS n FROM albums WHERE source='demo'")["n"]
