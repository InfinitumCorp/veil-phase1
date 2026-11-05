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


def test_guard_is_planned_in_patch_series(root):
    series = (root / "veil-browser" / "patches" / "series").read_text()
    assert "VeilAnonymityGuard" in series
