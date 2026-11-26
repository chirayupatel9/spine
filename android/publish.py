"""Publish an Android App Bundle to a Google Play track (internal testing unless told otherwise)
through the Google Play Developer API, as a service account.

The release workflow (.github/workflows/android.yml) runs it after building. It works on any
computer too:

    pip install google-auth requests
    PLAY_SERVICE_ACCOUNT_JSON="$(cat key.json)" python android/publish.py app-release.aab

The service account needs "Release apps to testing tracks" for the app in Play Console, under
Users and permissions (README, "Android app").
"""
import argparse
import json
import os
import sys

APPS = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
UPLOADS = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications"


class PlayError(Exception):
    pass


def _ok(r):
    if r.status_code >= 400:
        try:
            msg = r.json()["error"]["message"]
        except Exception:
            msg = r.text[:500]
        raise PlayError(f"Google Play said {r.status_code}: {msg}")
    return r


def publish(session, package: str, bundle: str, track: str = "internal", name: str | None = None) -> int:
    """Upload `bundle` and release it to everyone on `track`, in one edit: if anything fails the
    edit is thrown away and Play is left as it was. Returns the release's version code."""
    app = f"{APPS}/{package}"
    edit = _ok(session.post(f"{app}/edits", timeout=60)).json()["id"]
    try:
        # A resumable upload: ask where to send the bundle, then send it there.
        size = os.path.getsize(bundle)
        start = _ok(session.post(
            f"{UPLOADS}/{package}/edits/{edit}/bundles", params={"uploadType": "resumable"},
            headers={"X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": str(size)}, timeout=60))
        with open(bundle, "rb") as f:
            body = f.read()   # in memory (a few MB), so a retry after a token refresh sends it whole
        sent = _ok(session.put(start.headers["Location"], data=body, headers={"Content-Type": "application/octet-stream"}, timeout=900))
        code = int(sent.json()["versionCode"])
        release = {"versionCodes": [str(code)], "status": "completed"}
        if name:
            release["name"] = name[:50]   # shown in Play Console only
        _ok(session.put(f"{app}/edits/{edit}/tracks/{track}", json={"track": track, "releases": [release]}, timeout=60))
        _ok(session.post(f"{app}/edits/{edit}:commit", timeout=300))
        return code
    except BaseException:
        try:
            session.delete(f"{app}/edits/{edit}", timeout=60)
        except Exception:
            pass
        raise


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundle", help="the signed .aab")
    ap.add_argument("--package", default="dev.chirayupatel.music")
    ap.add_argument("--track", default="internal", help="internal, alpha, beta or production")
    ap.add_argument("--name", help="the release's name in Play Console (at most 50 characters)")
    a = ap.parse_args()
    key = os.environ.get("PLAY_SERVICE_ACCOUNT_JSON", "").strip()
    if not key:
        print("PLAY_SERVICE_ACCOUNT_JSON isn't set: it holds the service account's JSON key.", file=sys.stderr)
        return 2
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_info(json.loads(key), scopes=["https://www.googleapis.com/auth/androidpublisher"])
    try:
        code = publish(AuthorizedSession(creds), a.package, a.bundle, a.track, a.name)
    except PlayError as e:
        print(e, file=sys.stderr)
        return 1
    print(f"Version {code} of {a.package} is out on the {a.track} track.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
