#!/usr/bin/env python3
"""Cut VEIL's tor-browser patch series from VEIL's sources.

    python3 veil-browser/tools/cut_patches.py TREE OUT_DIR

TREE is a git checkout of tor-browser at the pinned commit (a full clone, or
the verified subset from import_upstream_subset.py), on a clean branch. Each
patch below is applied as one commit with VEIL trailers, then the series is
written with `git format-patch` to OUT_DIR, with a `series` file.

Every edit to an upstream file is anchored on exact text: if the anchor is
missing or not unique (upstream moved things), cutting stops with the file
and anchor, instead of guessing. Rerun after a rebase to regenerate.

Patches are cut without Reviewed-by trailers. They go to the pending series
(veil_patches.py lint --pending) until people review them.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "veil-browser" / "src"
GLUE = SRC / "glue"
CHROME = ROOT / "veil-chrome" / "src"
COMPONENT = "browser/components/veil"

AUTHOR = ("Infinitum Corporation", "info@theinfinitumcorporation.com")
MPL_PY = ("# This Source Code Form is subject to the terms of the Mozilla Public\n"
          "# License, v. 2.0. If a copy of the MPL was not distributed with this\n"
          "# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n")


class AnchorError(Exception):
    pass


class Tree:
    def __init__(self, path: Path):
        self.path = path

    def p(self, rel: str) -> Path:
        return self.path / rel

    def read(self, rel: str) -> str:
        return self.p(rel).read_text()

    def write(self, rel: str, text: str | bytes) -> None:
        f = self.p(rel)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(text.encode() if isinstance(text, str) else text)

    def replace(self, rel: str, old: str, new: str) -> None:
        text = self.read(rel)
        n = text.count(old)
        if n != 1:
            raise AnchorError(f"{rel}: anchor found {n} times (need exactly 1):\n{old}")
        self.write(rel, text.replace(old, new))

    def insert_after(self, rel: str, anchor: str, addition: str) -> None:
        self.replace(rel, anchor, anchor + addition)

    def insert_before(self, rel: str, anchor: str, addition: str) -> None:
        self.replace(rel, anchor, addition + anchor)

    def git(self, *args: str, **kw) -> str:
        env = {**os.environ, "GIT_AUTHOR_NAME": AUTHOR[0], "GIT_AUTHOR_EMAIL": AUTHOR[1],
               "GIT_COMMITTER_NAME": AUTHOR[0], "GIT_COMMITTER_EMAIL": AUTHOR[1],
               # Fixed dates keep regenerated patches byte-identical.
               "GIT_AUTHOR_DATE": "2026-11-06T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-06T00:00:00Z"}
        return subprocess.run(["git", "-C", str(self.path), "-c", "commit.gpgSign=false", *args],
                              capture_output=True, text=True, check=True, env=env, **kw).stdout

    def commit(self, tag: str, subject: str, body: str, reason: str) -> None:
        self.git("add", "-A")
        msg = f"{subject}\n\n{body.strip()}\n\nVEIL-Tag: {tag}\nVEIL-Reason: {reason}\n"
        self.git("commit", "-q", "-F", "-", input=msg)


# ---------------------------------------------------------------- component

def module_text(name: str, *, without: tuple[str, ...] = ()) -> str:
    """A VEIL module's source; `without` drops lines mentioning those names
    (used to cut VeilBrowser before the guard exists, in patch 0002)."""
    src = (GLUE / name) if (GLUE / name).exists() else (SRC / name)
    lines = src.read_text().splitlines(keepends=True)
    return "".join(l for l in lines if not any(w in l for w in without))


def write_component(t: Tree, modules: list[str], content: dict[str, str]) -> None:
    """browser/components/veil: moz-src modules plus chrome content."""
    t.write(f"{COMPONENT}/moz.build", MPL_PY + (
        '\nwith Files("**"):\n    BUG_COMPONENT = ("Firefox", "General")\n\n'
        'JAR_MANIFESTS += ["jar.mn"]\n\nMOZ_SRC_FILES += [\n'
        + "".join(f'    "{m}",\n' for m in sorted(modules)) + "]\n"))
    entries = sorted(content)
    width = max(len(f"content/browser/veil/{e}") for e in entries) + 2
    t.write(f"{COMPONENT}/jar.mn", MPL_PY + "\nbrowser.jar:\n" + "".join(
        f"  {('content/browser/veil/' + e).ljust(width)}({content[e]})\n" for e in entries))


HOME_CONTENT = {
    "home/home.html": "content/home/home.html",
    "home/home.js": "content/home/home.js",
    "shared/bridge.js": "content/shared/bridge.js",
    "shared/veil.css": "content/shared/veil.css",
    "veil-browser.css": "content/veil-browser.css",
    # Written by bootstrap.sh from the signed registry (registry_tool.py build);
    # the build fails without them, so an unsigned registry can't ship.
    "generated/registry.js": "content/generated/registry.js",
    "generated/registry.json": "content/generated/registry.json",
}
ICONS = {f"icons/{i}.svg": f"content/icons/{i}.svg" for i in ("cndctr", "scalvs")}

APP_ICON = {
    "cndctr": '<path d="M5 6 L2 9 L5 12 M11 6 L14 9 L11 12" fill="none" stroke="currentColor" stroke-width="1.6" '
              'stroke-linecap="round" stroke-linejoin="round"/>',
    "scalvs": '<circle cx="8" cy="9" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6"/>'
              '<circle cx="8" cy="9" r="1.6" fill="currentColor"/>',
}


def copy_home(t: Tree) -> None:
    for f in ("home/home.html", "home/home.js", "shared/bridge.js", "shared/veil.css"):
        t.write(f"{COMPONENT}/content/{f}", (CHROME / f).read_text())
    t.write(f"{COMPONENT}/content/veil-browser.css", (GLUE / "veil-browser.css").read_text())
    t.write(f"{COMPONENT}/content/generated/.gitignore", "# Written by bootstrap.sh; never committed.\n*\n!.gitignore\n")


# ---------------------------------------------------------------- patches

def p0001_branding(t: Tree) -> None:
    subprocess.run([sys.executable, "-I", str(ROOT / "veil-browser/branding/make_branding.py"), str(t.path)],
                   check=True, capture_output=True)
    t.commit("branding", "VEIL branding for the release channel", """
Rebrand browser/branding/tb-release in place: tor-browser-build selects
browser/branding/tb-<channel>, so no build-system change is needed.
Names, vendor and support URLs say VEIL / Infinitum Corporation; the
trademark line credits Tor Browser and The Tor Project. Every icon is
rendered from VEIL's own SVGs by veil-browser/branding/make_branding.py
(reproducible: same sources, same bytes), so no Tor Project logo ships
under the VEIL name.""", "VEIL must not ship under Tor Browser's name or logo")


P0002_MODULES = ["AboutVeilHomeChild.sys.mjs", "AboutVeilHomeParent.sys.mjs", "VeilAppPanel.sys.mjs",
                 "VeilBrowser.sys.mjs", "VeilCumulusID.sys.mjs", "VeilSidePanel.sys.mjs", "VeilSignIn.sys.mjs"]


def p0002_chrome(t: Tree) -> None:
    for m in P0002_MODULES:
        t.write(f"{COMPONENT}/{m}", module_text(m, without=("VeilAnonymityGuard",)))
    copy_home(t)
    write_component(t, P0002_MODULES, HOME_CONTENT)

    t.insert_before("browser/components/moz.build", '    "webrtc",\n', '    "veil",\n')

    ar = "browser/components/about/AboutRedirector.cpp"
    t.replace(ar, '#define BASE_BROWSER_HOME_PAGE_URL "about:tor"',
              '// VEIL: home, new tab and welcome open VEIL\'s start page.\n'
              '#define BASE_BROWSER_HOME_PAGE_URL "about:veil-home"')
    t.insert_after(ar, '    {"tor", "chrome://browser/content/abouttor/aboutTor.html",\n'
                       '     BASE_BROWSER_HOME_PAGE_FLAGS},\n',
                   '    {"veil-home", "chrome://browser/content/veil/home/home.html",\n'
                   '     BASE_BROWSER_HOME_PAGE_FLAGS},\n')
    t.insert_after("browser/components/about/components.conf", "    'unloads',\n", "    'veil-home',\n")

    t.replace("browser/app/profile/000-tor-browser.js",
              'pref("browser.startup.homepage", "about:tor");',
              'pref("browser.startup.homepage", "about:veil-home");')

    t.insert_before("browser/components/DesktopActorRegistry.sys.mjs", "  AboutWelcome: {\n", """\
  AboutVeilHome: {
    parent: {
      esModuleURI:
        "moz-src:///browser/components/veil/AboutVeilHomeParent.sys.mjs",
    },
    child: {
      esModuleURI:
        "moz-src:///browser/components/veil/AboutVeilHomeChild.sys.mjs",
      events: {
        DOMWindowCreated: {},
      },
    },

    matches: ["about:veil-home"],
  },

""")

    bridge = (CHROME / "shared" / "bridge.js").read_text()
    outgoing = re.findall(r'"(VEIL:\w+)"', re.search(r"OUTGOING = new Set\(\[(.*?)\]\)", bridge, re.S).group(1))
    incoming = re.findall(r'"(VEIL:\w+)"', re.search(r"INCOMING = new Set\(\[(.*?)\]\)", bridge, re.S).group(1))
    t.insert_before("toolkit/modules/RemotePageAccessManager.sys.mjs", '    "about:welcome": {\n',
                    '    "about:veil-home": {\n'
                    '      RPMSendAsyncMessage: [\n' + "".join(f'        "{m}",\n' for m in outgoing) + "      ],\n"
                    '      RPMAddMessageListener: [\n' + "".join(f'        "{m}",\n' for m in incoming) + "      ],\n"
                    "    },\n")

    t.insert_after("browser/components/BrowserGlue.sys.mjs",
                   "  _beforeUIStartup: function BG__beforeUIStartup() {\n    lazy.SessionStartup.init();\n",
                   "\n    // VEIL: registry, sign-in and side panels, before the first window.\n"
                   "    // A failure here must not stop the browser from starting.\n"
                   "    try {\n"
                   "      ChromeUtils.importESModule(\n"
                   '        "moz-src:///browser/components/veil/VeilBrowser.sys.mjs"\n'
                   "      ).VeilBrowser.init();\n"
                   "    } catch (e) {\n"
                   "      console.error(\"VEIL: VeilBrowser.init failed\", e);\n"
                   "    }\n")
    t.insert_after("browser/base/content/browser-init.js", "    gTorCircuitPanel.init();\n",
                   "\n    // VEIL: this window's side panel and Anonymous chip.\n"
                   "    ChromeUtils.importESModule(\n"
                   '      "moz-src:///browser/components/veil/VeilBrowser.sys.mjs"\n'
                   "    ).VeilBrowser.onWindowLoaded(window);\n")
    t.replace("browser/base/content/navigator-toolbox.inc.xhtml",
              '        <toolbartabstop/>\n        <html:moz-urlbar id="urlbar"',
              '        <toolbartabstop/>\n'
              '        <html:div id="veil-anonymous-chip" role="status">Anonymous</html:div>\n'
              '        <html:moz-urlbar id="urlbar"')
    t.insert_after("browser/base/content/browser.xhtml", '  <link rel="stylesheet" href="chrome://browser/skin/" />\n',
                   '  <link rel="stylesheet" href="chrome://browser/content/veil/veil-browser.css" />\n')

    t.commit("chrome", "VEIL start page, sign-in and app side panel", """
Add browser/components/veil: VEIL's start page (about:veil-home), the
Cumulus://ID sign-in flow, and the side panel for VEIL's apps.

- about:veil-home is registered like about:tor (same flags, so it runs in
  an unprivileged content process) and replaces it as home, new tab and
  welcome page.
- Its actor talks to the page only through RemotePageChild, limited by
  RemotePageAccessManager to the messages in veil-chrome's bridge.js.
- VeilBrowser starts in BrowserGlue._beforeUIStartup and sets up each
  window from browser-init.js; the "Anonymous" chip sits in front of the
  address bar.
- The app registry is not part of this patch: bootstrap.sh writes it
  from the signed registry (registry_tool.py build), and the build fails
  if it is missing.""", "VEIL's start page and apps replace about:tor")


def p0003_guard(t: Tree) -> None:
    modules = P0002_MODULES + ["VeilAnonymityGuard.sys.mjs"]
    t.write(f"{COMPONENT}/VeilAnonymityGuard.sys.mjs", module_text("VeilAnonymityGuard.sys.mjs"))
    t.write(f"{COMPONENT}/VeilBrowser.sys.mjs", module_text("VeilBrowser.sys.mjs"))
    write_component(t, modules, HOME_CONTENT)
    t.insert_before("browser/components/BrowserGlue.sys.mjs",
                    "\n    // VEIL: registry, sign-in and side panels, before the first window.\n",
                    "\n    // VEIL: fail closed. Goes offline if any setting would let traffic\n"
                    "    // bypass Tor; started first so nothing else can run without it.\n"
                    "    ChromeUtils.importESModule(\n"
                    '      "moz-src:///browser/components/veil/VeilAnonymityGuard.sys.mjs"\n'
                    "    ).VeilAnonymityGuard.init();\n")
    t.commit("network", "Anonymity guard: go offline if Tor could be bypassed", """
Install VeilAnonymityGuard and start it first in _beforeUIStartup (and
again, idempotently, from VeilBrowser.init). At startup and on every
change to the network preferences it checks that traffic can only leave
through Tor's SOCKS proxy with remote DNS; if not, the browser goes
offline and stays offline until the settings are safe again. It never
changes a network setting itself and changes nothing a website can
observe.""", "VEIL is always anonymous: a weakened Tor setting must stop traffic, not leak it")


def p0004_no_tor_off(t: Tree) -> None:
    t.replace("toolkit/components/tor-launcher/TorProviderBuilder.sys.mjs", """\
    let provider = TorProviders.tor;
    const kEnvName = "TOR_PROVIDER";
    if (
      Services.env.exists(kEnvName) &&
      Services.env.get(kEnvName) in TorProviders
    ) {
      provider = TorProviders[Services.env.get(kEnvName)];
    }
    return provider;""", """\
    let provider = TorProviders.tor;
    const kEnvName = "TOR_PROVIDER";
    // VEIL: there is no way to run without Tor. TOR_PROVIDER=none is
    // ignored; the mock provider exists only for automated tests.
    if (
      Services.env.exists(kEnvName) &&
      Services.env.get(kEnvName) === "mock" &&
      Cu.isInAutomation
    ) {
      provider = TorProviders.mock;
    }
    return provider;""")
    t.replace("toolkit/components/tor-launcher/TorLauncherUtil.sys.mjs", """\
      const kEnvProvider = "TOR_PROVIDER";
""", "")
    t.replace("toolkit/components/tor-launcher/TorLauncherUtil.sys.mjs", """\
      if (
        Services.env.exists(kEnvProvider) &&
        Services.env.get(kEnvProvider) === "none"
      ) {
        return false;
      }
""", "")
    t.commit("network", "Remove the way to run with Tor turned off", """
Tor Browser can be started with TOR_PROVIDER=none, which builds the
browser with no Tor provider at all. VEIL has one always-anonymous
workspace, so that path is removed: TOR_PROVIDER=none is ignored and
the mock provider is only available under test automation.

Using a system tor (TOR_SKIP_LAUNCH, as Tails and Whonix do) is kept:
traffic still goes through Tor, and the anonymity guard checks that
the proxy settings point at a SOCKS proxy with remote DNS.""",
             "No setting or environment variable may turn Tor off in VEIL")


def p0006_commands(t: Tree) -> None:
    modules = P0002_MODULES + ["VeilAnonymityGuard.sys.mjs", "VeilAppCommands.sys.mjs", "VeilUrlbarProvider.sys.mjs"]
    for m in ("VeilAppCommands.sys.mjs", "VeilUrlbarProvider.sys.mjs"):
        t.write(f"{COMPONENT}/{m}", module_text(m))
    for app, shape in APP_ICON.items():
        t.write(f"{COMPONENT}/content/icons/{app}.svg",
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 18" width="16" height="16" '
                f'fill="none" color="context-fill">{shape}</svg>\n')
    write_component(t, modules, {**HOME_CONTENT, **ICONS})
    t.insert_after("browser/components/urlbar/UrlbarProvidersManager.sys.mjs", "var localProviderModules = [\n", """\
  {
    // VEIL: @scalvs / @cndctr commands open the app in the side panel.
    name: "VeilUrlbarProvider",
    module: "moz-src:///browser/components/veil/VeilUrlbarProvider.sys.mjs",
    supportedSAPs: ["urlbar"],
  },
""")
    t.commit("chrome", "Address-bar commands for VEIL's apps", """
Typing "@scalvs ..." or "@cndctr ..." in the address bar shows one row
that opens the app in VEIL's side panel with the request. While such a
command is typed, VeilUrlbarProvider is the only provider that runs, so
the text never reaches search suggestions, history matching or a search
engine, and running it doesn't navigate or add history.

Registered through localProviderModules (urlbar only), using the ESR 153
provider API (async isActive, object-form UrlbarResult).""",
             "Run VEIL's apps from the address bar without leaking the request")


def p0007_geodata(t: Tree) -> None:
    t.write(f"{COMPONENT}/VeilGeoData.sys.mjs", module_text("VeilGeoData.sys.mjs"))
    t.insert_before(f"{COMPONENT}/moz.build",
                    '    "VeilSidePanel.sys.mjs",\n',
                    '    "VeilGeoData.sys.mjs",\n')
    t.commit("chrome", "Local geo lists for optional ad and tracker blocking", """
Add VeilGeoData. It reads local geo list bytes and can block a hostname
that is already in the address when the user turns on extra ad and
tracker categories. The setting defaults off, and while it is off the
lists are not consulted.

The module does not resolve names and does not change the preferences
the anonymity guard watches. It cannot add a route that leaves Tor.
The dat files are not in this patch; fetch_geo.py checks their SHA-256
and writes a gitignored cache.""",
             "Optional local ad blocking must not weaken Tor")


SERIES = [
    ("0001", p0001_branding),
    ("0002", p0002_chrome),
    ("0003", p0003_guard),
    ("0004", p0004_no_tor_off),
    # 0005 [update]: VEIL's MAR certificates replace Tor's in
    # toolkit/mozapps/update/updater. Cut once the certificates exist.
    ("0006", p0006_commands),
    ("0007", p0007_geodata),
]


def cut(tree: Path, out: Path) -> list[Path]:
    tree, out = tree.resolve(), out.resolve()
    t = Tree(tree)
    if t.git("status", "--porcelain").strip():
        raise SystemExit(f"{tree} has uncommitted changes")
    base = t.git("rev-parse", "HEAD").strip()
    # In a verified subset, the base commit names the upstream commit it holds.
    m = re.search(r"\(([0-9a-f]{40})\)", t.git("log", "-1", "--format=%s", base))
    upstream = m.group(1) if m else base
    for number, fn in SERIES:
        fn(t)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.patch"):
        old.unlink()
    names = t.git("format-patch", "--binary", "--no-signature", "--zero-commit", "--full-index",
                  "-o", str(out), f"{base}..HEAD").split()
    # Number files as the plan does (0001, 0002, 0003, 0004, 0006).
    paths = []
    for (number, _), name in zip(SERIES, names):
        src = Path(name)
        dst = out / (number + src.name[4:])
        src.rename(dst)
        paths.append(dst)
    (out / "series").write_text(
        "# VEIL patch series awaiting review, cut by veil-browser/tools/cut_patches.py\n"
        f"# against tor-browser {upstream}.\n"
        "# Apply in order. 0005 [update] is cut once VEIL's MAR certificates exist.\n" + "".join(p.name + "\n" for p in paths))
    return paths


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    try:
        for p in cut(Path(sys.argv[1]), Path(sys.argv[2])):
            print(p.name)
    except AnchorError as exc:
        sys.exit(f"cut_patches: upstream changed; fix the anchor:\n{exc}")
