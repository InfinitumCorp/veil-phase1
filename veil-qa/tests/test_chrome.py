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


def test_one_always_anonymous_page(root):
    pages = sorted(p.relative_to(chrome_src(root)).as_posix() for p in chrome_src(root).rglob("*.html"))
    assert pages == ["home/home.html"]
    html = (chrome_src(root) / "home" / "home.html").read_text()
    js = (chrome_src(root) / "home" / "home.js").read_text()
    bridge = (chrome_src(root) / "shared" / "bridge.js").read_text()
    # No way to leave Tor from the start page.
    for text in ("SwitchWorkspace", "not anonymous", "direct connection to", "switch to direct"):
        assert text not in html + js + bridge, text


def test_sign_in_address_never_comes_from_the_page(root):
    html = (chrome_src(root) / "home" / "home.html").read_text()
    m = re.search(r'<a class="signin"[^>]*>', html)
    assert m and "href" not in m.group(0)
    js = (chrome_src(root) / "home" / "home.js").read_text()
    assert 'VeilBridge.send("VEIL:OpenSignIn")' in js  # no URL argument


def test_app_panel_message_carries_only_the_app_id(root):
    js = (chrome_src(root) / "home" / "home.js").read_text()
    assert 'VeilBridge.send("VEIL:OpenAppPanel", { id: app.id })' in js
    assert "OpenAppPanel\", { url" not in js


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


def test_registry_apps_must_be_alphabetical():
    apps = [{"id": i, "name": n, "summary": "s", "url": "https://x.example"}
            for i, n in (("b", "+SPCTR"), ("a", "FABRIC"))]
    assert any("alphabetical" in e for e in registry_tool.validate({"schema": 1, "version": 1, "apps": apps}))
    assert registry_tool.validate({"schema": 1, "version": 1, "apps": apps[::-1]}) == []


def test_sort_ignores_symbols_and_reads_ae_as_ae():
    names = ["+SPCTR™", "ÆTHER™", "/CNDCTR/™", "E(O)N™"]
    assert sorted(names, key=registry_tool.sort_key) == ["ÆTHER™", "/CNDCTR/™", "E(O)N™", "+SPCTR™"]


@pytest.mark.parametrize("url", ["http://id.example", "javascript:alert(1)", "https://id.example/\"x"])
def test_unsafe_sign_in_url_is_refused(url):
    reg = {"schema": 1, "version": 1, "signin": {"label": "Sign In", "url": url},
           "apps": [{"id": "x", "name": "X", "summary": "s", "url": "https://x.example"}]}
    assert any("signin.url" in e for e in registry_tool.validate(reg))


def test_cumulus_id_settings_are_validated():
    good = {"issuer": "https://id.example", "authorize_url": "https://id.example/a",
            "token_url": "https://id.example/t", "client_id": "veil-browser",
            "redirect_uri": "https://id.example/cb"}
    def reg(cid):
        return {"schema": 1, "version": 1,
                "signin": {"label": "Sign In", "url": "https://id.example", "cid": cid},
                "apps": [{"id": "x", "name": "X", "summary": "s", "url": "https://x.example"}]}
    assert registry_tool.validate(reg(good)) == []
    assert registry_tool.validate(reg({**good, "token_url": "http://id.example/t"}))
    assert registry_tool.validate(reg({k: v for k, v in good.items() if k != "client_id"}))


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
def test_start_page_in_a_real_browser(signed_registry, root, tmp_path):
    from playwright.sync_api import sync_playwright

    reg, keys, _ = signed_registry
    data = json.loads(reg.read_text())
    site = tmp_path / "site"
    shutil.copytree(chrome_src(root), site)
    registry_tool.cmd_build(reg, keys, site / "generated" / "registry.js")

    requests, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=_browser_path(), args=["--no-sandbox"])
        page = browser.new_page()
        page.on("request", lambda r: requests.append(r.url))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto((site / "home" / "home.html").as_uri())
        page.wait_for_load_state("networkidle")
        status = page.text_content("#tor-status-text")
        names = page.locator("#launcher .app-link").all_text_contents()
        menu_names = page.locator("#apps-panel .menu-app-name").all_text_contents()
        mail_href = page.get_attribute("#mail", "href")
        top_right = page.evaluate("""['#mail', '#apps-button', '#signin'].map(s =>
            Math.round(document.querySelector(s).getBoundingClientRect().left))""")
        menu_hidden = page.is_hidden("#apps-panel")
        page.click("#apps-button")
        menu_open = page.is_visible("#apps-panel")
        page.keyboard.press("Escape")
        menu_closed = page.is_hidden("#apps-panel")
        signin_text = page.text_content("#signin")
        signin_href = page.get_attribute("#signin", "href")
        signin_visible = page.is_visible("#signin")
        signin_right = page.evaluate(
            "document.querySelector('#signin').getBoundingClientRect().right > innerWidth - 40")
        label = page.text_content("#workspace")
        browser.close()

    remote = [u for u in requests if not u.startswith("file://")]
    assert remote == [], f"start page made network requests: {remote}"
    assert errors == [], errors
    assert "Preview mode" in status
    by_name = lambda apps: sorted((a["name"] for a in apps), key=registry_tool.sort_key)
    assert names == by_name(a for a in data["apps"] if a.get("panel") or a.get("footer"))
    assert menu_names == by_name(data["apps"])
    assert mail_href == data["mail"]["url"]
    assert top_right == sorted(top_right) and top_right[0] > 900     # Mail, Apps, Sign In, in that order, at the right
    assert menu_hidden and menu_open and menu_closed
    assert signin_text == "Sign In" and signin_visible and signin_right
    assert signin_href == data["signin"]["url"]
    assert label == "Anonymous"
