#!/usr/bin/env python3
"""Compare what websites can see in VEIL's anonymous workspace vs stock Tor Browser.

Gate 2 of Phase I. Runs the same collector page in both browsers, at the
same security level and window size, and fails if any signal differs.

    fingerprint_diff.py --veil PATH/TO/veil --upstream PATH/TO/tor-browser \
        [--profile-veil DIR] [--profile-upstream DIR] [--out report.json]

Needs: geckodriver on PATH and `pip install selenium`. Both browsers are
driven over Marionette with their own bundled profile, so Tor settings are
the real ones. The collector is served from 127.0.0.1, which Tor Browser
allows without a Tor connection, so the test runs offline.

Known-volatile signals (none today) go in IGNORE with a written reason.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Signals allowed to differ, each with the reason. Keep this empty unless a
# security reviewer signs off: every entry is a way to tell VEIL users apart.
IGNORE: dict[str, str] = {}


def serve_collector() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/collector.html"


def collect(binary: Path, profile: Path | None, url: str) -> dict:
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.support.ui import WebDriverWait

    opts = Options()
    opts.binary_location = str(binary)
    if profile:
        opts.profile = str(profile)
    opts.add_argument("-headless")
    driver = webdriver.Firefox(options=opts)
    try:
        driver.set_window_size(1000, 1000)
        driver.get(url)
        WebDriverWait(driver, 60).until(lambda d: d.title == "done")
        return driver.execute_script("return window.__veilFingerprint;")
    finally:
        driver.quit()


def flatten(obj, prefix="") -> dict:
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}{k}."))
    else:
        out[prefix.rstrip(".")] = obj
    return out


def diff(veil: dict, upstream: dict) -> list[dict]:
    a, b = flatten(veil), flatten(upstream)
    problems = []
    for key in sorted(set(a) | set(b)):
        if key in IGNORE:
            continue
        if a.get(key) != b.get(key):
            problems.append({"signal": key, "veil": a.get(key), "upstream": b.get(key)})
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--veil", type=Path, required=True)
    ap.add_argument("--upstream", type=Path, required=True)
    ap.add_argument("--profile-veil", type=Path)
    ap.add_argument("--profile-upstream", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)

    server, url = serve_collector()
    try:
        veil = collect(args.veil, args.profile_veil, url)
        upstream = collect(args.upstream, args.profile_upstream, url)
    finally:
        server.shutdown()

    problems = diff(veil, upstream)
    report = {"identical": not problems, "differences": problems,
              "veil": veil, "upstream": upstream, "ignored": IGNORE}
    if args.out:
        args.out.write_text(json.dumps(report, indent=2))
    for p in problems:
        print(f"DIFFERS {p['signal']}: veil={p['veil']!r} upstream={p['upstream']!r}")
    print("IDENTICAL to upstream Tor Browser" if not problems
          else f"FAIL: {len(problems)} signal(s) let a site tell VEIL apart")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
