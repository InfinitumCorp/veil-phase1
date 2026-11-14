"""Runs every JavaScript test suite under Node: the browser modules, Cumulus://ID, and the apps."""
import shutil
import subprocess

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
@pytest.mark.parametrize("suite", sorted(p.name for p in (__import__("pathlib").Path(__file__).parent / "js").glob("*.test.mjs")))
def test_browser_modules(root, suite):
    result = subprocess.run(
        ["node", "--test", str(root / "veil-qa" / "tests" / "js" / suite)],
        capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_guard_is_installed_and_started_first(root):
    patch = next((root / "veil-browser" / "patches" / "pending").glob("0003-*.patch")).read_text()
    assert "VEIL-Tag: network" in patch
    assert "+++ b/browser/components/veil/VeilAnonymityGuard.sys.mjs" in patch
    # Started in _beforeUIStartup, before VeilBrowser and before any window.
    added = [l[1:] for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++")]
    glue = "\n".join(added)
    assert ').VeilAnonymityGuard.init();' in glue
    # The patch is what the browser build installs, so it has to be the source.
    src = (root / "veil-browser" / "src" / "VeilAnonymityGuard.sys.mjs").read_text()
    start = patch.index("+++ b/browser/components/veil/VeilAnonymityGuard.sys.mjs\n")
    body = []
    for line in patch[start:].splitlines()[1:]:
        if line.startswith("diff --git "):
            break
        if line.startswith("+"):
            body.append(line[1:] + "\n")
    assert "".join(body) == src
