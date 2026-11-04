"""Gate 3: the dashboards make zero network requests and trust only a signed registry.

Two layers: a static scan of every dashboard source file, and a real
headless-browser load that records every request the pages make.
"""
import base64
import json
import re
import shutil

import pytest

import registry_tool

ALLOWED_FORM_ACTIONS = {
    "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/",
    "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion",
    "https://duckduckgo.com",
}
NETWORK_APIS = re.compile(r"\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.connection)\b|\bimport\s*\(")
REMOTE_ATTR = re.compile(r"""\b(src|href|srcset|poster|data)\s*=\s*["']\s*(https?:)?//""", re.I)
CSS_REMOTE = re.compile(r"""(url\(\s*["']?\s*(https?:)?//|@import)""", re.I)


def chrome_src(root):
    return root / "veil-chrome" / "src"


def test_no_network_apis_in_scripts(root):
    for js in chrome_src(root).rglob("*.js"):
        if "generated" in js.parts:
            continue
        assert not NETWORK_APIS.search(js.read_text()), f"network API in {js.name}"


def test_no_remote_resources_in_html(root):
    for page in chrome_src(root).rglob("*.html"):
        assert not REMOTE_ATTR.search(page.read_text()), f"remote resource in {page.name}"


def test_no_remote_css(root):
    for css in chrome_src(root).rglob("*.css"):
        assert not CSS_REMOTE.search(css.read_text()), f"remote CSS in {css.name}"


def test_every_page_has_locked_down_csp(root):
    for page in chrome_src(root).rglob("*.html"):
        html = page.read_text()
        m = re.search(r'http-equiv="Content-Security-Policy"\s+content="([^"]+)"', html)
        assert m, f"{page.name} has no CSP"
        csp = {d.split()[0]: d.split()[1:] for d in m.group(1).split(";") if d.strip()}
        assert csp.get("default-src") == ["'none'"], page.name
        assert csp.get("script-src") == ["'self'"], page.name
        assert csp.get("base-uri") == ["'none'"], page.name
        for action in csp.get("form-action", []):
            assert action in ALLOWED_FORM_ACTIONS, f"{page.name}: unexpected form-action {action}"


def test_anonymous_page_has_no_launcher_or_account_features(root):
    html = (chrome_src(root) / "anonymous" / "home.html").read_text()
    js = (chrome_src(root) / "anonymous" / "home.js").read_text()
    # Features, not words: the page may say "no wallet", but must not load
    # the app registry, render a launcher, or link to Infinitum products.
    assert "registry.js" not in html
    assert 'id="launcher"' not in html
    assert "VEIL_REGISTRY" not in js
    assert "infinitum-corporation" not in html + js


def test_authenticated_page_never_claims_anonymity(root):
    html = (chrome_src(root) / "authenticated" / "home.html").read_text().lower()
    assert "not anonymous" in html
    assert "you are anonymous" not in html


# ---- registry signing ---------------------------------------------------

@pytest.fixture
def signed_registry(root, tmp_path):
    reg = tmp_path / "registry.json"
    shutil.copy(root / "veil-chrome" / "registry" / "registry.json", reg)
    keys = tmp_path / "keys"
    keys.mkdir()
    registry_tool.cmd_keygen(tmp_path / "dev")
    shutil.copy(tmp_path / "dev.pub", keys / "dev.pub")
    assert registry_tool.cmd_sign(reg, tmp_path / "dev.key") == 0
    return reg, keys, tmp_path


def test_shipped_registry_is_valid(root):
    reg = json.loads((root / "veil-chrome" / "registry" / "registry.json").read_text())
    assert registry_tool.validate(reg) == []


def test_signed_registry_verifies_and_builds(signed_registry, tmp_path):
    reg, keys, _ = signed_registry
    out = tmp_path / "registry.js"
    assert registry_tool.cmd_build(reg, keys, out) == 0
    assert "Object.freeze" in out.read_text()


def test_tampered_registry_is_rejected(signed_registry):
    reg, keys, _ = signed_registry
    data = json.loads(reg.read_text())
    data["apps"][0]["url"] = "https://attacker.example/phish"
    reg.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="signature"):
        registry_tool.verify(reg, keys)


def test_registry_signed_by_untrusted_key_is_rejected(signed_registry):
    reg, keys, tmp = signed_registry
    registry_tool.cmd_keygen(tmp / "other")
    for p in keys.glob("*.pub"):
        p.unlink()
    shutil.copy(tmp / "other.pub", keys / "other.pub")
    with pytest.raises(ValueError, match="trusted key"):
        registry_tool.verify(reg, keys)


def test_bad_app_mark_is_refused():
    bad = {"schema": 1, "version": 1, "apps": [
        {"id": "x", "mark": "TOOLONG", "name": "X", "summary": "s", "url": "https://x.example"}]}
    assert registry_tool.validate(bad)


def test_unsafe_registry_urls_are_refused():
    bad = {"schema": 1, "version": 1, "apps": [
        {"id": "x", "name": "X", "summary": "s", "url": "javascript:alert(1)"}]}
    assert registry_tool.validate(bad)


def test_release_keys_dir_holds_no_dev_keys(root):
    keys = root / "veil-chrome" / "registry" / "keys"
    assert not list(keys.glob("dev*.pub"))


# ---- real browser load ----------------------------------------------------

def _browser_path():
    for name in ("google-chrome", "chromium", "chromium-browser"):
        path = shutil.which(name)
        if path:
            return path
    return None


@pytest.mark.skipif(_browser_path() is None, reason="no headless Chrome/Chromium available")
@pytest.mark.parametrize("workspace", ["anonymous", "authenticated"])
def test_dashboard_makes_no_network_requests(signed_registry, root, tmp_path, workspace):
    from playwright.sync_api import sync_playwright

    reg, keys, _ = signed_registry
    site = tmp_path / "site"
    shutil.copytree(chrome_src(root), site)
    registry_tool.cmd_build(reg, keys, site / "generated" / "registry.js")

    requests, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=_browser_path(), args=["--no-sandbox"])
        page = browser.new_page()
        page.on("request", lambda r: requests.append(r.url))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto((site / workspace / "home.html").as_uri())
        page.wait_for_load_state("networkidle")
        status = page.text_content("#tor-status-text")
        tiles = page.locator("#launcher .app").count() if workspace == "authenticated" else 0
        browser.close()

    remote = [u for u in requests if not u.startswith("file://")]
    assert remote == [], f"{workspace} dashboard made network requests: {remote}"
    assert errors == [], errors
    assert "Preview mode" in status
    if workspace == "authenticated":
        assert tiles == len(json.loads(reg.read_text())["apps"])
