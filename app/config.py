import os
import secrets
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


MUSIC_DIR = Path(_env("MUSIC_DIR", "/music"))
DATA_DIR = Path(_env("DATA_DIR", "/data"))
ART_DIR = DATA_DIR / "art"
DB_PATH = DATA_DIR / "spine.db"

# Public base URL the browser uses, e.g. https://spine.example.com or http://127.0.0.1:8000
PUBLIC_URL = _env("PUBLIC_URL", "http://127.0.0.1:8000").rstrip("/")

# Optional password protecting the whole app (strongly recommended when hosted publicly)
APP_PASSWORD = _env("APP_PASSWORD")

SPOTIFY_CLIENT_ID = _env("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = _env("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = f"{PUBLIC_URL}/auth/spotify/callback"

# Look up missing artwork online (iTunes Search, then MusicBrainz / Cover Art Archive)
ART_LOOKUP_ONLINE = _env("ART_LOOKUP_ONLINE", "1") not in ("0", "false", "no")

# Rescan the music folder every N minutes (0 = only on startup / manual rescan)
RESCAN_MINUTES = int(_env("RESCAN_MINUTES", "60") or 0)

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav", ".aif", ".aiff", ".wma", ".alac"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

DATA_DIR.mkdir(parents=True, exist_ok=True)
ART_DIR.mkdir(parents=True, exist_ok=True)

_secret_file = DATA_DIR / ".secret"
SECRET_KEY = _env("SECRET_KEY")
if not SECRET_KEY:
    if _secret_file.exists():
        SECRET_KEY = _secret_file.read_text().strip()
    else:
        SECRET_KEY = secrets.token_hex(32)
        _secret_file.write_text(SECRET_KEY)
