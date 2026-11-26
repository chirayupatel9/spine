"""Test setup: a throwaway data folder and a small generated music library.

Config is read when the app is imported, so the environment is set here, before any test imports it.
Nothing here touches the network: online artwork lookup is off and the demo shelf is faked.
"""
import io
import math
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="albumviewer-test-"))
MUSIC = TMP / "music"
DATA = TMP / "data"
PASSWORD = "correct horse battery"

os.environ.update(MUSIC_DIR=str(MUSIC), DATA_DIR=str(DATA), APP_PASSWORD=PASSWORD, ART_LOOKUP_ONLINE="0",
                  RESCAN_MINUTES="0", PUBLIC_URL="http://127.0.0.1:8000", MAX_UPLOAD_MB="1")
for k in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SECRET_KEY"):
    os.environ.pop(k, None)


def make_wav(path: Path, seconds: float = 1.0, freq: float = 440.0, rate: int = 8000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * i / rate)))
                               for i in range(int(seconds * rate))))


def png_bytes(color=(200, 40, 30), size=64) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (size, size), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(scope="session")
def main():
    from app import main as m
    return m


@pytest.fixture(scope="session")
def library_scanned(main):
    """The Testers / First Album (two tracks and a cover.png), plus one loose single."""
    album = MUSIC / "The Testers" / "First Album"
    make_wav(album / "01 - Opening.wav", freq=440)
    make_wav(album / "02 - Closing.wav", freq=660)
    (album / "cover.png").write_bytes(png_bytes())
    make_wav(MUSIC / "Loose Artist - Single Song.wav", freq=550)
    from app import library
    library.scan()
    assert library.status["error"] is None
    return library


@pytest.fixture
def client(main):
    from fastapi.testclient import TestClient
    main.reset_login_limits()
    return TestClient(main.app)   # not used as a context manager, so the background rescan never starts


@pytest.fixture
def signed_in(client):
    r = client.post("/login", data={"password": PASSWORD}, follow_redirects=False)
    assert r.status_code == 303
    return client
