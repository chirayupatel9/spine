"""Digital Asset Links for the Android app: public, well-formed, and absent until configured."""
from conftest import ANDROID_PACKAGE


def test_assetlinks_is_public_and_well_formed(client):
    r = client.get("/.well-known/assetlinks.json")          # no sign-in: Google's verifier fetches it
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    [link] = r.json()
    assert link["relation"] == ["delegate_permission/common.handle_all_urls"]
    assert link["target"]["namespace"] == "android_app"
    assert link["target"]["package_name"] == ANDROID_PACKAGE
    # normalised to upper-case colon pairs; the malformed entry is dropped
    assert link["target"]["sha256_cert_fingerprints"] == [":".join(["AB"] * 32), ":".join(["0F"] * 32)]


def test_assetlinks_absent_until_configured(client, main, monkeypatch):
    monkeypatch.setattr(main, "ANDROID_CERT_SHA256", [])
    assert client.get("/.well-known/assetlinks.json").status_code == 404
    monkeypatch.setattr(main, "ANDROID_CERT_SHA256", ["AB" * 32])
    monkeypatch.setattr(main, "ANDROID_PACKAGE", "")
    assert client.get("/.well-known/assetlinks.json").status_code == 404


def test_other_well_known_paths_still_need_sign_in(client):
    assert client.get("/.well-known/assetlinks.jsonx", follow_redirects=False).status_code in (302, 307)
