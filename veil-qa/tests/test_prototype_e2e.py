"""End to end: the VEIL prototype with Cumulus://ID, SCALVS.ai and /CNDCTR/.

Starts the whole demo on free ports, then drives it in a real headless
browser: start page, Mail and Apps, @commands, Cumulus://ID sign-in for VEIL
and for an app (single sign-on), /CNDCTR/ scheduling and New identity.
"""
import json
import shutil
import socket
import subprocess
import time

import pytest


def _browser():
    for name in ("google-chrome", "chromium", "chromium-browser"):
        if shutil.which(name):
            return shutil.which(name)
    return None


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def demo(root, tmp_path):
    ports = {k: _free_port() for k in ("cid", "scalvs", "cndctr", "veil")}
    script = (f'import("{root}/veil-prototype/run-demo.mjs").then(m => m.startDemo('
              f'{{dataDir: {json.dumps(str(tmp_path))}, ports: {json.dumps(ports)}, quiet: true}}))'
              '.then(() => console.log("ready"))')
    proc = subprocess.Popen(["node", "-e", script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            env={"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path)})
    line = proc.stdout.readline()
    assert "ready" in line, line + proc.stdout.read()
    yield f"http://localhost:{ports['veil']}"
    proc.terminate()
    proc.wait(timeout=10)


@pytest.mark.skipif(_browser() is None or shutil.which("node") is None, reason="needs Chrome and Node")
def test_veil_prototype_end_to_end(demo):
    from playwright.sync_api import sync_playwright

    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=_browser(), args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(demo)
        start = page.frame_locator(".pages iframe >> nth=0")
        panel = page.frame_locator("#panel-frame")

        # Start page: two panel apps at the bottom; Mail and Apps at the top.
        start.locator("#launcher .app-link >> nth=1").wait_for()
        assert start.locator("#launcher .app-link").all_inner_texts() == ["/CNDCTR/™", "SCALVS.ai™"]
        assert start.locator("#mail").is_visible()
        start.locator("#apps-button").click()
        assert len(start.locator("#apps-panel .menu-app").all()) == 7

        # Apps menu: a panel app opens in the side panel.
        start.locator("#apps-panel .menu-app >> text=SCALVS.ai™").click()
        page.locator("#panel").wait_for(state="visible")
        assert page.locator("#panel-title").inner_text() == "SCALVS.ai™"
        page.click("#panel-close")
        assert page.locator("#panel").is_hidden()

        # @scalvs in the address bar opens SCALVS.ai with the question asked.
        page.click("#address")
        page.keyboard.type("@scalvs what is Tor?")
        assert "Ask SCALVS.ai™: what is Tor?" in page.locator("#suggest").inner_text()
        page.keyboard.press("Enter")
        panel.locator(".msg.user").wait_for()
        assert panel.locator(".msg.user").inner_text() == "what is Tor?"
        panel.locator(".msg.notice, .msg.app:not(.thinking)").first.wait_for()

        # Sign In: register at Cumulus://ID and come back signed in.
        start.locator("#signin").click()
        cid = page.frame_locator(".pages iframe >> nth=1")
        cid.locator("text=Create a Cumulus://ID").click()
        cid.locator("input[name=name]").fill("Ada Lovelace")
        cid.locator("input[name=email]").fill("ada@infinitum.example")
        cid.locator("input[name=password]").fill("analytical engine 1843")
        cid.locator("input[name=confirm]").fill("analytical engine 1843")
        cid.locator("button[type=submit]").click()
        page.locator("#chip-text >> text=Signed in").wait_for()
        assert page.locator(".tab .title").all_inner_texts() == ["New tab"]   # sign-in tab closed itself
        page.locator(".tab >> nth=0").click()
        start.locator("#signin >> text=Signed in").wait_for()

        # @cndctr: the command waits for app sign-in, which is single sign-on.
        page.click("#address")
        page.keyboard.type("@cndctr every weekday at 9 remind me to check the board")
        page.keyboard.press("Enter")
        panel.locator(".msg.notice").wait_for()
        with page.expect_popup():
            panel.locator("#who button").click()
        panel.locator("#who >> text=Ada Lovelace").wait_for(timeout=15000)
        panel.locator(".msg.app >> text=every weekday at 09:00").wait_for()
        assert "check the board" in panel.locator("#tasks").inner_text()

        # New identity: back to one fresh tab, signed out, panel closed.
        page.click("#new-identity")
        page.locator("#chip-text >> text=Anonymous").wait_for()
        assert page.locator(".tab .title").all_inner_texts() == ["New tab"]
        assert page.locator("#panel").is_hidden()
        b.close()

    assert errors == [], errors
