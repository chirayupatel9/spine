"""Sign in with Google: OpenID Connect's authorization code flow, with PKCE.

The ID token comes straight from Google's token endpoint over TLS, in exchange for the code and
the client secret, so its claims are trusted as they arrive (OpenID Connect Core 3.1.3.7); its
audience, issuer, expiry and verified email are still checked.
"""
from __future__ import annotations

import base64
import json
import time
from urllib.parse import urlencode

import httpx

from . import config

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")

_http = httpx.Client(timeout=20)


class GoogleError(Exception):
    pass


def configured() -> bool:
    return bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET)


def authorize_url(state: str, challenge: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "client_id": config.GOOGLE_CLIENT_ID,
        "redirect_uri": config.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    })


def exchange(code: str, verifier: str) -> dict:
    """The signed-in person's claims (sub, email, name, picture)."""
    r = _http.post(TOKEN_URL, data={
        "code": code, "client_id": config.GOOGLE_CLIENT_ID, "client_secret": config.GOOGLE_CLIENT_SECRET,
        "redirect_uri": config.GOOGLE_REDIRECT_URI, "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if r.status_code != 200:
        raise GoogleError(f"Google didn't accept the sign-in ({r.status_code})")
    claims = _claims(r.json().get("id_token") or "")
    if claims.get("aud") != config.GOOGLE_CLIENT_ID or claims.get("iss") not in ISSUERS:
        raise GoogleError("That sign-in wasn't meant for this server")
    if float(claims.get("exp") or 0) < time.time():
        raise GoogleError("The sign-in expired. Try again.")
    if not claims.get("sub") or not claims.get("email") or claims.get("email_verified") not in (True, "true"):
        raise GoogleError("Your Google account's email address isn't verified")
    return claims


def _claims(id_token: str) -> dict:
    try:
        payload = id_token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        raise GoogleError("Google sent a sign-in Album Viewer couldn't read") from None
