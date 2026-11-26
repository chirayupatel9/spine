"""Sign-in is always required, and repeated wrong passwords are slowed down and then refused."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from conftest import PASSWORD, ROOT


def test_api_needs_sign_in(client):
    assert client.get("/api/albums").status_code == 401
    assert client.get("/api/spotify/token").status_code == 401
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/login"


def test_static_files_need_sign_in(client):
    assert client.get("/app.js", follow_redirects=False).status_code in (302, 307)


def test_open_pages_work_without_sign_in(client):
    assert client.get("/healthz").json() == {"ok": True}
    assert client.get("/login").status_code == 200
    assert client.get("/manifest.webmanifest").status_code == 200
    assert client.get("/icon.svg").status_code == 200


def test_wrong_password(client):
    r = client.post("/login", data={"password": "nope"}, follow_redirects=False)
    assert r.status_code == 401
    assert "Wrong password" in r.text
    assert client.get("/api/albums").status_code == 401


def test_non_ascii_password_is_just_wrong(client):
    assert client.post("/login", data={"password": "pässwörd ✓"}).status_code == 401


def test_sign_in_and_out(client):
    r = client.post("/login", data={"password": PASSWORD}, follow_redirects=False)
    assert r.status_code == 303
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/albums").status_code == 200
    assert client.post("/logout", follow_redirects=False).status_code == 303
    assert client.get("/api/albums").status_code == 401


def test_forged_cookie_is_rejected(client):
    client.cookies.set("av_auth", "0" * 64)
    assert client.get("/api/albums").status_code == 401


def test_too_many_wrong_passwords_locks_that_address(client, main):
    for _ in range(main.LOGIN_MAX_PER_ADDRESS):
        assert client.post("/login", data={"password": "guess"}).status_code == 401
    r = client.post("/login", data={"password": PASSWORD}, follow_redirects=False)
    assert r.status_code == 429                      # even the right password waits
    assert int(r.headers["retry-after"]) > 0
    assert "Too many attempts" in r.text
    main.reset_login_limits()
    assert client.post("/login", data={"password": PASSWORD}, follow_redirects=False).status_code == 303


def test_guesses_spread_over_many_addresses_hit_the_total_cap(client, main):
    import time
    now = time.time()
    for i in range(main.LOGIN_MAX_TOTAL):
        main._login_failed(f"10.0.{i // 250}.{i % 250}", now)
    assert client.post("/login", data={"password": PASSWORD}, follow_redirects=False).status_code == 429


def test_security_headers(client):
    h = client.get("/healthz").headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in h["content-security-policy"]


def _config_in(data_dir: Path, **env) -> str:
    """Import app.config in a fresh process with the given data folder, and report what it decided."""
    full = {k: v for k, v in os.environ.items() if k not in ("APP_PASSWORD",)}
    full.update(DATA_DIR=str(data_dir), MUSIC_DIR=str(data_dir / "music"), **env)
    code = "import app.config as c; print(c.APP_PASSWORD, c.PASSWORD_GENERATED, c.PASSWORD_FROM_ENV)"
    return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=full, capture_output=True, text=True, check=True).stdout.split()


def test_password_is_generated_once_and_kept():
    d = Path(tempfile.mkdtemp())
    pw, generated, from_env = _config_in(d)
    assert generated == "True" and from_env == "False" and len(pw) >= 16
    assert (d / "password.txt").read_text().strip() == pw
    pw2, generated2, _ = _config_in(d)
    assert pw2 == pw and generated2 == "False"


def test_env_password_wins():
    d = Path(tempfile.mkdtemp())
    pw, generated, from_env = _config_in(d, APP_PASSWORD="from-the-environment")
    assert (pw, generated, from_env) == ("from-the-environment", "False", "True")
    assert not (d / "password.txt").exists()


def test_data_from_before_the_rename_is_kept():
    d = Path(tempfile.mkdtemp())
    (d / "spine.db").write_bytes(b"old database")
    _config_in(d, APP_PASSWORD="x" * 12)
    assert (d / "albumviewer.db").read_bytes() == b"old database"
    assert not (d / "spine.db").exists()
