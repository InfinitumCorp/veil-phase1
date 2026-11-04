"""The fingerprint collector runs and returns every signal the diff relies on."""
import shutil
import sys

import pytest


def _browser():
    for name in ("google-chrome", "chromium", "chromium-browser"):
        if shutil.which(name):
            return shutil.which(name)
    return None


@pytest.mark.skipif(_browser() is None, reason="no headless Chrome/Chromium available")
def test_collector_returns_all_signals(root):
    from playwright.sync_api import sync_playwright
    sys.path.insert(0, str(root / "veil-qa" / "browser"))
    import fingerprint_diff

    server, url = fingerprint_diff.serve_collector()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=_browser(), args=["--no-sandbox"])
            page = b.new_page()
            page.goto(url)
            page.wait_for_function("document.title === 'done'", timeout=30000)
            fp = page.evaluate("window.__veilFingerprint")
            b.close()
    finally:
        server.shutdown()

    for key in ("userAgent", "timezone", "screen", "canvas", "webgl", "fonts", "apis",
                "mediaQueries", "timerResolutionMs"):
        assert key in fp, key
    assert len(fp["canvas"]) == 64


def test_diff_flags_every_difference(root):
    sys.path.insert(0, str(root / "veil-qa" / "browser"))
    import fingerprint_diff
    a = {"userAgent": "x", "apis": {"webrtc": "undefined"}, "screen": [1000, 1000]}
    b = {"userAgent": "x", "apis": {"webrtc": "function"}, "screen": [1000, 1000]}
    problems = fingerprint_diff.diff(a, b)
    assert [p["signal"] for p in problems] == ["apis.webrtc"]
    assert fingerprint_diff.diff(a, a) == []
