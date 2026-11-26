import os
import secrets
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _private(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:  # Windows, or a filesystem that ignores modes
        pass


MUSIC_DIR = Path(_env("MUSIC_DIR", "/music"))
DATA_DIR = Path(_env("DATA_DIR", "/data"))
ART_DIR = DATA_DIR / "art"
DB_PATH = DATA_DIR / "albumviewer.db"

# Public base URL the browser uses, e.g. https://albums.example.com or http://127.0.0.1:8000
PUBLIC_URL = _env("PUBLIC_URL", "http://127.0.0.1:8000").rstrip("/")

SPOTIFY_CLIENT_ID = _env("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = _env("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = f"{PUBLIC_URL}/auth/spotify/callback"

# Look up missing artwork online (iTunes Search, then MusicBrainz / Cover Art Archive)
ART_LOOKUP_ONLINE = _env("ART_LOOKUP_ONLINE", "1") not in ("0", "false", "no")

# Rescan the music folder every N minutes (0 = only on startup / manual rescan)
RESCAN_MINUTES = int(_env("RESCAN_MINUTES", "60") or 0)

# Largest request body accepted (cover uploads are the only big ones)
MAX_UPLOAD_MB = int(_env("MAX_UPLOAD_MB", "15") or 15)

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav", ".aif", ".aiff", ".wma", ".alac"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ART_DIR.mkdir(parents=True, exist_ok=True)
except PermissionError:
    pass
if not os.access(DATA_DIR, os.W_OK):
    raise SystemExit(
        f"Album Viewer can't write to its data folder {DATA_DIR}. In Docker, make the host folder you mount "
        f"there owned by the user the container runs as (PUID/PGID in .env, 1000 by default), "
        f"e.g. `sudo chown -R 1000:1000 ./data`.")

# Data from before the app was renamed from "Spine"
_old_db = DATA_DIR / "spine.db"
if _old_db.exists() and not DB_PATH.exists():
    for suffix in ("", "-wal", "-shm"):
        old = DATA_DIR / f"spine.db{suffix}"
        if old.exists():
            old.rename(DATA_DIR / f"albumviewer.db{suffix}")

_secret_file = DATA_DIR / ".secret"
SECRET_KEY = _env("SECRET_KEY")
if not SECRET_KEY:
    if _secret_file.exists():
        SECRET_KEY = _secret_file.read_text().strip()
    else:
        SECRET_KEY = secrets.token_hex(32)
        _secret_file.write_text(SECRET_KEY)
        _private(_secret_file)

# Login is always required. APP_PASSWORD sets the password; without it, one is generated on the
# first start and kept in DATA_DIR/password.txt (printed in the log that one time).
PASSWORD_FILE = DATA_DIR / "password.txt"
PASSWORD_GENERATED = False
APP_PASSWORD = _env("APP_PASSWORD")
PASSWORD_FROM_ENV = bool(APP_PASSWORD)
if not APP_PASSWORD:
    if PASSWORD_FILE.exists():
        APP_PASSWORD = PASSWORD_FILE.read_text().strip()
    if not APP_PASSWORD:
        APP_PASSWORD = secrets.token_urlsafe(12)
        PASSWORD_FILE.write_text(APP_PASSWORD + "\n")
        _private(PASSWORD_FILE)
        PASSWORD_GENERATED = True
