"""Album artwork: embedded tags -> folder image -> iTunes Search -> MusicBrainz/Cover Art Archive.

Also extracts a dominant colour for each cover so the spines look like the album.
"""
from __future__ import annotations

import base64
import colorsys
import io
import logging
import re
import threading
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import httpx
from mutagen import File as MutagenFile
from PIL import Image

from .config import ART_DIR, ART_LOOKUP_ONLINE, IMAGE_EXTS

log = logging.getLogger("albumviewer.art")

USER_AGENT = "AlbumViewer/1.0 (personal self-hosted music shelf)"
_http = httpx.Client(timeout=15, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
_mb_lock = threading.Lock()
_mb_last = 0.0

FOLDER_NAMES = ("cover", "folder", "front", "album", "albumart", "albumartlarge", "artwork", "art")


# ---------------------------------------------------------------- embedded / folder

def extract_embedded(path: str | Path) -> bytes | None:
    """Return the front-cover image embedded in an audio file, if any."""
    try:
        audio = MutagenFile(path)
    except Exception:
        return None
    if audio is None:
        return None

    # FLAC
    pictures = getattr(audio, "pictures", None)
    if pictures:
        front = [p for p in pictures if p.type == 3] or list(pictures)
        return front[0].data

    tags = audio.tags
    if tags is None:
        return None

    # ID3 (mp3, aiff, wav)
    if hasattr(tags, "getall"):
        apics = tags.getall("APIC")
        if apics:
            front = [a for a in apics if a.type == 3] or apics
            return front[0].data

    # MP4 / M4A
    try:
        covr = tags.get("covr")
        if covr:
            return bytes(covr[0])
    except Exception:
        pass

    # Ogg Vorbis / Opus
    try:
        blocks = tags.get("metadata_block_picture")
        if blocks:
            from mutagen.flac import Picture

            pics = [Picture(base64.b64decode(b)) for b in blocks]
            front = [p for p in pics if p.type == 3] or pics
            return front[0].data
    except Exception:
        pass

    # WMA
    try:
        wm = tags.get("WM/Picture")
        if wm:
            raw = wm[0].value
            # skip ASF picture header: type(1) + size(4) + mime(utf16 z) + desc(utf16 z)
            i = 5
            for _ in range(2):
                while raw[i:i + 2] != b"\x00\x00":
                    i += 2
                i += 2
            return raw[i:]
    except Exception:
        pass
    return None


def find_folder_image(folder: str | Path) -> Path | None:
    folder = Path(folder)
    try:
        images = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
    except OSError:
        return None
    if not images:
        return None
    by_stem = {p.stem.lower().replace(" ", "").replace("_", ""): p for p in images}
    for name in FOLDER_NAMES:
        if name in by_stem:
            return by_stem[name]
    for p in images:
        if any(k in p.stem.lower() for k in ("cover", "front", "folder")):
            return p
    return images[0] if len(images) == 1 else None


# ---------------------------------------------------------------- online lookup

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)  # (Remastered 2011), [Deluxe]
    s = re.sub(r"\b(feat|ft)\.?\b.*", " ", s)
    s = re.sub(r"\b(remaster(ed)?|deluxe|edition|expanded|anniversary|version)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def _sim(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.9
    return SequenceMatcher(None, a, b).ratio()


_it_lock = threading.Lock()
_it_last = 0.0
_it_blocked_until = 0.0


def _itunes(params: dict) -> list[dict]:
    """iTunes Search allows roughly 20 requests/minute; throttle and back off on 403/429."""
    global _it_last, _it_blocked_until
    if time.time() < _it_blocked_until:
        return []  # cooling down; MusicBrainz is tried instead
    with _it_lock:
        wait = 3.2 - (time.time() - _it_last)
        if wait > 0:
            time.sleep(wait)
        _it_last = time.time()
    try:
        r = _http.get("https://itunes.apple.com/search", params={**params, "media": "music", "limit": 15})
        if r.status_code in (403, 429):
            _it_blocked_until = time.time() + 90
            log.info("iTunes rate limit hit, pausing iTunes lookups for 90s")
            return []
        if r.status_code != 200:
            return []
        return r.json().get("results", [])
    except Exception as e:
        log.debug("itunes lookup failed: %s", e)
        return []


def _itunes_hi_res(url: str) -> str:
    return re.sub(r"/\d+x\d+(bb)?\.(jpg|png)$", "/1200x1200bb.jpg", url)


def _pick(results, title_key, want_title, want_artist, threshold=0.72):
    best, best_score = None, 0.0
    for r in results:
        t = _sim(want_title, r.get(title_key, "")) if want_title else 0.8
        a = _sim(want_artist, r.get("artistName", "")) if want_artist else 0.8
        score = 0.55 * t + 0.45 * a
        if score > best_score:
            best, best_score = r, score
    return best if best is not None and best_score >= threshold else None


def lookup_itunes(artist: str, album: str | None, song: str | None) -> str | None:
    if album:
        res = _itunes({"term": f"{artist} {album}".strip(), "entity": "album"})
        hit = _pick(res, "collectionName", album, artist)
        if hit and hit.get("artworkUrl100"):
            return _itunes_hi_res(hit["artworkUrl100"])
    if song:
        res = _itunes({"term": f"{artist} {song}".strip(), "entity": "song"})
        hit = _pick(res, "trackName", song, artist)
        if hit and hit.get("artworkUrl100"):
            return _itunes_hi_res(hit["artworkUrl100"])
    return None


def _mb_get(url: str, params: dict) -> dict | None:
    global _mb_last
    with _mb_lock:  # MusicBrainz asks for max 1 request/second
        wait = 1.1 - (time.time() - _mb_last)
        if wait > 0:
            time.sleep(wait)
        _mb_last = time.time()
    try:
        r = _http.get(url, params={**params, "fmt": "json"})
        return r.json() if r.status_code == 200 else None
    except Exception as e:
        log.debug("musicbrainz failed: %s", e)
        return None


def _q(s: str) -> str:
    return s.replace('"', " ")


def lookup_musicbrainz(artist: str, album: str | None, song: str | None) -> str | None:
    release_ids: list[str] = []
    if album:
        q = f'release:"{_q(album)}"' + (f' AND artist:"{_q(artist)}"' if artist else "")
        data = _mb_get("https://musicbrainz.org/ws/2/release/", {"query": q, "limit": 5})
        for rel in (data or {}).get("releases", []):
            if rel.get("score", 0) >= 85:
                release_ids.append(rel["id"])
    if not release_ids and song:
        q = f'recording:"{_q(song)}"' + (f' AND artist:"{_q(artist)}"' if artist else "")
        data = _mb_get("https://musicbrainz.org/ws/2/recording/", {"query": q, "limit": 5})
        for rec in (data or {}).get("recordings", []):
            if rec.get("score", 0) >= 85:
                release_ids += [r["id"] for r in rec.get("releases", [])[:3]]
    for rid in release_ids[:5]:
        url = f"https://coverartarchive.org/release/{rid}/front-500"
        try:
            r = _http.head(url)
            if r.status_code == 200:
                return url
        except Exception:
            continue
    return None


def download(url: str) -> bytes | None:
    try:
        r = _http.get(url)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception as e:
        log.debug("download failed %s: %s", url, e)
    return None


def find_online(artist: str, album: str | None, song: str | None) -> tuple[bytes, str] | None:
    """Try online sources; album name first, then by song name."""
    if not ART_LOOKUP_ONLINE:
        return None
    for source, fn in (("itunes", lookup_itunes), ("musicbrainz", lookup_musicbrainz)):
        url = fn(artist, album, song)
        if url:
            data = download(url)
            if data:
                return data, source
    return None


# ---------------------------------------------------------------- save + colour

def save_art(album_id: str, data: bytes) -> tuple[str, str, str] | None:
    """Normalise to JPEG (max 1000px), save, return (file_name, colour, text_colour)."""
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
    except Exception:
        return None
    img.thumbnail((1000, 1000))
    name = f"{album_id}.jpg"
    img.save(ART_DIR / name, "JPEG", quality=88, optimize=True)
    color = dominant_color(img)
    return name, color, text_color_for(color)


def dominant_color(img: Image.Image) -> str:
    small = img.convert("RGB").resize((64, 64))
    pal = small.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    palette = pal.getpalette()[: 8 * 3]
    counts = sorted(pal.getcolors(), reverse=True)  # [(count, index)]
    best, best_score = None, -1.0
    total = sum(c for c, _ in counts) or 1
    for count, idx in counts:
        r, g, b = palette[idx * 3: idx * 3 + 3]
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        share = count / total
        # prefer common colours, give a boost to saturated, mid-light ones
        score = share * (0.6 + s) * (1.0 - abs(l - 0.45))
        if score > best_score:
            best, best_score = (r, g, b), score
    r, g, b = best or (40, 40, 40)
    return f"#{r:02x}{g:02x}{b:02x}"


def text_color_for(hex_color: str) -> str:
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def lin(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    return "#121212" if lum > 0.36 else "#f4f1ea"


def placeholder_color(seed: str) -> tuple[str, str]:
    h = (sum(ord(c) for c in seed) * 37 % 360) / 360
    r, g, b = colorsys.hls_to_rgb(h, 0.35, 0.35)
    color = f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"
    return color, text_color_for(color)
