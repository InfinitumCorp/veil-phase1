#!/usr/bin/env python3
"""Write VEIL branding into a tor-browser tree (patch 0001).

tor-browser-build builds with --with-branding=browser/branding/tb-<channel>,
so VEIL rebrands those directories in place instead of adding a new one that
the build system would also have to learn about.

    python3 veil-browser/branding/make_branding.py TOR_BROWSER_TREE [--channel release]

Every image is rendered from src/veil-icon.svg and src/veil-wordmark.svg, so
the output is reproducible: same sources, same bytes (PNG and ICO metadata
carry no timestamps).
"""
from __future__ import annotations

import argparse
import io
import subprocess
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
INK = "#111820"

NAMES = {"release": "VEIL", "alpha": "VEIL Alpha", "nightly": "VEIL Nightly"}
SITE = "https://infinitum-corporation.vercel.app/products/veil"

MPL = ("# This Source Code Form is subject to the terms of the Mozilla Public\n"
       "# License, v. 2.0. If a copy of the MPL was not distributed with this\n"
       "# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n")


def render(svg: Path, size: int) -> Image.Image:
    png = subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg)],
                         capture_output=True, check=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


def icon(size: int) -> Image.Image:
    # Below 48 px the </> mark is noise; use the plain V.
    return render(SRC / ("veil-icon-small.svg" if size < 48 else "veil-icon.svg"), size)


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def ico_bytes(sizes: list[int]) -> bytes:
    images = [icon(s) for s in sorted(sizes)]
    buf = io.BytesIO()
    images[-1].save(buf, "ICO", sizes=[(s, s) for s in sorted(sizes)], append_images=images[:-1])
    return buf.getvalue()


def icns_bytes() -> bytes:
    buf = io.BytesIO()
    big = icon(1024)
    big.save(buf, "ICNS", append_images=[icon(s) for s in (16, 32, 48, 128, 256, 512)])
    return buf.getvalue()


def write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def brand(tree: Path, channel: str) -> list[Path]:
    name = NAMES[channel]
    d = tree / "browser" / "branding" / f"tb-{channel}"
    if not d.is_dir():
        raise SystemExit(f"{d} not found: is this a tor-browser tree?")
    out: dict[str, bytes | str] = {}

    for s in (16, 22, 24, 32, 48, 64, 128, 256):
        out[f"default{s}.png"] = png_bytes(icon(s))
    out["VisualElements_150.png"] = png_bytes(icon(150))
    out["VisualElements_70.png"] = png_bytes(icon(70))
    out["content/about-logo.png"] = png_bytes(icon(192))
    out["content/about-logo@2x.png"] = png_bytes(icon(384))
    for f in ("firefox.ico", "document.ico"):
        out[f] = ico_bytes([16, 32, 48, 64, 128, 256])
    out["document_pdf.ico"] = ico_bytes([16, 32, 48, 256])
    for f in ("newtab.ico", "newwindow.ico", "pbmode.ico"):
        out[f] = ico_bytes([16, 32])
    out["firefox.icns"] = out["document.icns"] = icns_bytes()

    icon_svg = (SRC / "veil-icon.svg").read_text()
    out["content/about-logo.svg"] = icon_svg
    out["content/about-logo-small.svg"] = (SRC / "veil-icon-small.svg").read_text()
    out["content/document_pdf.svg"] = icon_svg
    out["content/about-wordmark.svg"] = (SRC / "veil-wordmark.svg").read_text()

    out["configure.sh"] = MPL + f'\nMOZ_APP_DISPLAYNAME="{name}"\n'
    out["locales/en-US/brand.ftl"] = (
        MPL + "\n"
        f"-brand-shorter-name = VEIL\n"
        f"-brand-short-name = {name}\n"
        f"-brand-full-name = {name}\n"
        f"-brand-product-name = VEIL\n"
        f"-vendor-short-name = Infinitum Corporation\n"
        "trademarkInfo = VEIL is a trademark of Infinitum Corporation. "
        "Built on Tor Browser by The Tor Project; “Tor” and the Tor logo are registered trademarks of The Tor Project, Inc.\n")
    out["locales/en-US/brand.properties"] = (
        MPL + "\n"
        "# The shortened application name. Shared between versions.\n"
        "brandShorterName=VEIL\n"
        f"brandShortName={name}\n"
        f"brandFullName={name}\n")
    out["pref/firefox-branding.js"] = (
        "/* This Source Code Form is subject to the terms of the Mozilla Public\n"
        " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\n"
        "// VEIL branding prefs.\n\n"
        f'pref("startup.homepage_override_url", "{SITE}");\n'
        f'pref("app.update.url.details", "{SITE}");\n'
        f'pref("app.update.url.manual", "{SITE}");\n'
        f'pref("app.releaseNotesURL", "{SITE}#release-%BB_VERSION_FOR_URLS%");\n'
        f'pref("app.releaseNotesURL.aboutDialog", "{SITE}#release-%BB_VERSION_FOR_URLS%");\n\n'
        "// Interval: Time between checks for a new version (in seconds)\n"
        'pref("app.update.interval", 43200); // 12 hours\n'
        "// The number of days a binary is permitted to be old\n"
        "// without checking for an update.  This assumes that\n"
        "// app.update.checkInstallTime is true.\n"
        'pref("app.update.checkInstallTime.days", 63);\n'
        "// Number of usages of the web console.\n"
        "// If this is less than 5, then pasting code into the web console is disabled\n"
        'pref("devtools.selfxss.count", 0);\n')

    manifest = (d / "firefox.VisualElementsManifest.xml").read_text()
    out["firefox.VisualElementsManifest.xml"] = manifest.replace("BackgroundColor='#271339'", f"BackgroundColor='{INK}'")
    css = (d / "content" / "aboutDialog.css").read_text()
    out["content/aboutDialog.css"] = (css.replace("--about-dialog-background-color: #20123a;",
                                                  f"--about-dialog-background-color: {INK};")
                                         .replace("hsla(235, 43%, 10%, 0.5)", "hsla(210, 30%, 8%, 0.5)"))

    written = []
    for rel, data in sorted(out.items()):
        write(d / rel, data)
        written.append(d / rel)
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("tree", type=Path)
    ap.add_argument("--channel", default="release", choices=sorted(NAMES))
    a = ap.parse_args()
    for p in brand(a.tree, a.channel):
        print(p.relative_to(a.tree))


if __name__ == "__main__":
    main()
