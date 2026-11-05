"""Runs the browser modules' JavaScript tests (anonymity guard, sign-in, app panel, address-bar commands, Cumulus://ID) under Node."""
import shutil
import subprocess

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
@pytest.mark.parametrize("suite", ["guard.test.mjs", "signin.test.mjs", "apppanel.test.mjs", "commands.test.mjs", "cumulusid.test.mjs"])
def test_browser_modules(root, suite):
    result = subprocess.run(
        ["node", "--test", str(root / "veil-qa" / "tests" / "js" / suite)],
        capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_guard_is_planned_in_patch_series(root):
    series = (root / "veil-browser" / "patches" / "series").read_text()
    assert "VeilAnonymityGuard" in series
