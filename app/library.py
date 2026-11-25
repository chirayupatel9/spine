"""Local music library: scan folder, read tags, group into albums, resolve artwork."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from collections import defaultdict
from pathlib import Path

from mutagen import File as MutagenFile

from . import artwork, db
from .config import AUDIO_EXTS, MUSIC_DIR

log = logging.getLogger("spine.library")

status = {"scanning": False, "phase": "idle", "files": 0, "albums": 0, "art_done": 0, "art_total": 0,
          "last_scan": None, "error": None}
_scan_lock = threading.Lock()


def _id(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(p.lower().strip() for p in parts).encode()).hexdigest()[:16]


def _first(tags, *keys):
    if not tags:
        return None
    for k in keys:
        v = tags.get(k)
        if v:
            v = v[0] if isinstance(v, list) else v
            v = str(v).strip()
            if v:
                return v
    return None


def _num(v) -> int | None:
    if not v:
        return None
    m = re.match(r"\s*(\d+)", str(v))
    return int(m.group(1)) if m else None


_FILENAME_PATTERNS = [
    re.compile(r"^(?P<no>\d{1,3})[\s._-]+(?P<artist>.+?)\s+-\s+(?P<title>.+)$"),  # 01 - Artist - Title
    re.compile(r"^(?P<no>\d{1,3})[\s._-]+(?P<title>.+)$"),                          # 01 - Title / 01. Title
    re.compile(r"^(?P<artist>.+?)\s+-\s+(?P<title>.+)$"),                           # Artist - Title
]


def parse_filename(stem: str) -> dict:
    stem = stem.replace("_", " ").strip()
    for pat in _FILENAME_PATTERNS:
        m = pat.match(stem)
        if m:
            return {k: v.strip() for k, v in m.groupdict().items() if v}
    return {"title": stem}


def read_track(path: Path) -> dict:
    info = {"path": str(path), "mtime": path.stat().st_mtime}
    tags, duration = None, None
    try:
        audio = MutagenFile(path, easy=True)
        if audio is not None:
            tags = audio.tags
            duration = getattr(audio.info, "length", None)
    except Exception as e:
        log.debug("tag read failed %s: %s", path, e)

    guess = parse_filename(path.stem)
    rel = path.relative_to(MUSIC_DIR) if path.is_relative_to(MUSIC_DIR) else path
    parents = rel.parts[:-1]  # folders between MUSIC_DIR and the file

    title = _first(tags, "title") or guess.get("title") or path.stem
    track_artist = _first(tags, "artist") or guess.get("artist")
    album_artist = _first(tags, "albumartist", "album artist", "performer") or track_artist
    album = _first(tags, "album")

    # "Artist - Title.mp3" with no tags is a loose song, not part of an album named after its folder
    loose = not album and not _first(tags, "artist") and "artist" in guess and "no" not in guess

    # Folder conventions: Artist/Album/track or Album/track
    if not album and parents and not loose:
        album = re.sub(r"^\s*\(?\d{4}\)?\s*[-–]?\s*", "", parents[-1]) or parents[-1]
    if not album_artist and len(parents) >= 2 and not loose:
        album_artist = parents[-2]
    if not album_artist and parents and " - " in parents[-1]:
        album_artist, album = [s.strip() for s in parents[-1].split(" - ", 1)]

    info.update(
        title=title,
        artist=track_artist or album_artist or "Unknown Artist",
        album_artist=album_artist or "Unknown Artist",
        album=album,  # None => loose single, artwork looked up by song name
        year=(_first(tags, "date", "originaldate", "year") or "")[:4] or None,
        track_no=_num(_first(tags, "tracknumber")) or _num(guess.get("no")),
        disc_no=_num(_first(tags, "discnumber")) or 1,
        duration=duration,
    )
    return info


def _walk() -> list[Path]:
    files = []
    for root, dirs, names in os.walk(MUSIC_DIR, followlinks=True):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            if not n.startswith(".") and Path(n).suffix.lower() in AUDIO_EXTS:
                files.append(Path(root) / n)
    return files


def scan(force_art: bool = False) -> None:
    if not _scan_lock.acquire(blocking=False):
        return
    try:
        status.update(scanning=True, phase="reading files", error=None, art_done=0, art_total=0)
        if not MUSIC_DIR.exists():
            status["error"] = f"Music folder not found: {MUSIC_DIR}"
            log.warning(status["error"])
            return

        files = _walk()
        status["files"] = len(files)

        albums: dict[str, dict] = {}
        tracks: list[dict] = []
        for p in files:
            try:
                t = read_track(p)
            except Exception as e:
                log.warning("skip %s: %s", p, e)
                continue
            if t["album"]:
                aid = "lo_" + _id(t["album_artist"], t["album"])
                title = t["album"]
            else:
                # loose file with no album info -> its own "single", art found by song name
                aid = "lo_" + _id(t["artist"], "single", t["title"])
                title = t["title"]
            a = albums.setdefault(aid, {"id": aid, "title": title, "artist": t["album_artist"], "year": t["year"],
                                        "folder": str(p.parent), "is_single": not t["album"],
                                        "first_file": str(p), "first_title": t["title"]})
            if not a["year"] and t["year"]:
                a["year"] = t["year"]
            t["album_id"] = aid
            t["id"] = "tr_" + _id(str(p))
            tracks.append(t)

        now = time.time()
        with db.tx() as c:
            c.execute("UPDATE albums SET seen=0 WHERE source='local'")
            for a in albums.values():
                c.execute(
                    """INSERT INTO albums(id, source, title, artist, year, folder, added_at, seen)
                       VALUES(?, 'local', ?, ?, ?, ?, ?, 1)
                       ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                         year=excluded.year, folder=excluded.folder, seen=1""",
                    (a["id"], a["title"], a["artist"], a["year"], a["folder"], now),
                )
            c.execute("DELETE FROM tracks WHERE path IS NOT NULL")
            c.executemany(
                """INSERT INTO tracks(id, album_id, title, artist, track_no, disc_no, duration, path, mtime)
                   VALUES(:id, :album_id, :title, :artist, :track_no, :disc_no, :duration, :path, :mtime)""",
                tracks,
            )
            c.execute("DELETE FROM albums WHERE source='local' AND seen=0")
        status["albums"] = len(albums)

        # ------------------------------------------------ artwork
        status["phase"] = "finding artwork"
        rows = {r["id"]: r for r in db.query("SELECT id, art_status, art_source FROM albums WHERE source='local'")}
        todo = [a for a in albums.values()
                if force_art or rows.get(a["id"], {}).get("art_status") != "ok"]
        status["art_total"] = len(todo)
        for a in todo:
            try:
                resolve_local_art(a)
            except Exception as e:
                log.warning("art failed for %s: %s", a["title"], e)
            status["art_done"] += 1
        status["last_scan"] = time.time()
        log.info("scan done: %d files, %d albums", len(files), len(albums))
    except Exception as e:
        status["error"] = str(e)
        log.exception("scan failed")
    finally:
        status.update(scanning=False, phase="idle")
        _scan_lock.release()


def resolve_local_art(a: dict) -> None:
    aid = a["id"]
    data, source = None, None
    track_paths = [r["path"] for r in db.query("SELECT path FROM tracks WHERE album_id=? ORDER BY disc_no, track_no", (aid,))]

    for p in track_paths[:3]:
        data = artwork.extract_embedded(p)
        if data:
            source = "embedded"
            break
    if not data and not a.get("is_single"):
        img = artwork.find_folder_image(a["folder"])
        if img:
            data, source = img.read_bytes(), "folder"
    if not data:
        artist = a["artist"] if a["artist"] != "Unknown Artist" else ""
        album = None if a.get("is_single") else a["title"]
        found = artwork.find_online(artist, album, a.get("first_title"))
        if found:
            data, source = found

    saved = artwork.save_art(aid, data) if data else None
    with db.tx() as c:
        if saved:
            name, color, text = saved
            c.execute("UPDATE albums SET art_file=?, art_status='ok', art_source=?, color=?, text_color=? WHERE id=?",
                      (name, source, color, text, aid))
        else:
            color, text = artwork.placeholder_color(aid)
            c.execute("UPDATE albums SET art_status='missing', art_file=NULL, color=?, text_color=? WHERE id=?",
                      (color, text, aid))


def start_scan(force_art: bool = False) -> bool:
    if status["scanning"]:
        return False
    threading.Thread(target=scan, kwargs={"force_art": force_art}, daemon=True).start()
    return True
