#!/usr/bin/env python3
"""Cut VEIL's tor-browser-build patch series.

    python3 veil-build/tools/cut_build_patches.py TBB_TREE OUT_DIR

TBB_TREE is a git checkout of tor-browser-build at the pinned tag, on a clean
branch. Like veil-browser/tools/cut_patches.py, every edit is anchored on
exact upstream text and the output is byte-identical when re-run.

Why this series exists: tor-browser-build fetches tor-browser by its own
pinned tag from gitlab.torproject.org. Without these changes it would build
stock Tor Browser, not VEIL. The patch points the firefox project at the
VEIL branch that bootstrap.sh checked out and patched, by commit, and gives
VEIL its own update server and MAR channel IDs.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "veil-browser" / "tools"))
from cut_patches import AnchorError, Tree  # noqa: E402

# Placeholder until VEIL's update service exists (see veil-update/channels.json):
# an .invalid host can never resolve, so no update is fetched from anywhere else.
UPDATER_URL = "https://update.veil.invalid/update_3/"
MAR_ID_PREFIX = "veil-infinitum"


def p0001_build_veil(t: Tree) -> None:
    cfg = "projects/firefox/config"
    t.replace(cfg, """\
git_hash: '[% c("var/project-name") %]-[% c("var/firefox_version") %]-[% c("var/browser_branch") %]-build[% c("var/browser_build") %]'
tag_gpg_id: 1
git_url: https://gitlab.torproject.org/tpo/applications/tor-browser.git
""", """\
# VEIL: build the VEIL branch that veil-build/bootstrap.sh checked out and
# patched, by commit. bootstrap.sh verified the upstream tag's signature
# before applying VEIL's patches, records both commits in pin.lock, and
# writes these two values into rbm.local.conf.
git_hash: '[% c("var/veil_browser_commit") %]'
tag_gpg_id: 0
git_url: '[% c("var/veil_browser_git_url") %]'
""")
    t.replace(cfg, """\
  updater_url: 'https://aus1.torproject.org/torbrowser/update_3/'
  mar_id_prefix: 'torbrowser-torproject'
""", f"""\
  # VEIL: VEIL's own update server and MAR channel IDs, so a VEIL install
  # never takes a Tor Browser update and vice versa.
  updater_url: '{UPDATER_URL}'
  mar_id_prefix: '{MAR_ID_PREFIX}'
""")
    t.replace(cfg, """\
  nightly:
    git_hash: '[% c("var/project-name") %]-[% c("var/firefox_version") %]-[% c("var/browser_branch") %]'
    tag_gpg_id: 0
""", """\
  nightly:
    git_hash: '[% c("var/veil_browser_commit") %]'
    tag_gpg_id: 0
""")
    t.replace(cfg, """\
      updater_url: 'https://nightlies.tbb.torproject.org/nightly-updates/updates/[% c("var/nightly_updates_publish_dir") %]'
""", f"""\
      updater_url: '{UPDATER_URL.replace("update_3/", "nightly/")}'
""")
    t.commit("update", "Build VEIL's tor-browser branch with VEIL update settings", """
tor-browser-build fetches tor-browser by its own pinned tag, so on its
own it would build stock Tor Browser. Point the firefox project at the
VEIL branch that bootstrap.sh checked out, verified and patched (by
commit, from rbm.local.conf), and give VEIL its own update URL and MAR
channel ID prefix.

The update URL is a placeholder on .invalid until VEIL's update service
exists, so a VEIL build can never fetch an update from anywhere else.""",
             "Without this, the build would produce Tor Browser instead of VEIL")


SERIES = [("0001", p0001_build_veil)]


def cut(tree: Path, out: Path) -> list[Path]:
    tree, out = tree.resolve(), out.resolve()
    t = Tree(tree)
    if t.git("status", "--porcelain").strip():
        raise SystemExit(f"{tree} has uncommitted changes")
    base = t.git("rev-parse", "HEAD").strip()
    for _, fn in SERIES:
        fn(t)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.patch"):
        old.unlink()
    names = t.git("format-patch", "--no-signature", "--zero-commit", "--full-index",
                  "-o", str(out), f"{base}..HEAD").split()
    paths = [Path(n) for n in names]
    (out / "series").write_text(
        "# VEIL tor-browser-build patch series awaiting review, cut by\n"
        f"# veil-build/tools/cut_build_patches.py against tor-browser-build {base}.\n"
        + "".join(p.name + "\n" for p in paths))
    return paths


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    try:
        for p in cut(Path(sys.argv[1]), Path(sys.argv[2])):
            print(p.name)
    except AnchorError as exc:
        sys.exit(f"cut_build_patches: upstream changed; fix the anchor:\n{exc}")
