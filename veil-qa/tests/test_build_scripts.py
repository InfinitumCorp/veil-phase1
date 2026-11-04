"""The build scripts refuse unsafe states instead of building from them."""
import os
import shutil
import subprocess


def run(script, env_extra=None, *args):
    env = {**os.environ, **(env_extra or {})}
    return subprocess.run(["bash", str(script), *args], capture_output=True, text=True, env=env)


def test_scripts_parse(root):
    for script in ("bootstrap.sh", "build.sh"):
        assert subprocess.run(["bash", "-n", str(root / "veil-build" / script)]).returncode == 0


def test_bootstrap_refuses_unconfirmed_tag(root, tmp_path):
    r = run(root / "veil-build" / "bootstrap.sh", {"WORK_DIR": str(tmp_path)})
    assert r.returncode != 0
    assert "TOR_BROWSER_TAG is not confirmed" in r.stderr


def test_bootstrap_refuses_missing_signer_keys(root, tmp_path):
    copy = tmp_path / "veil"
    shutil.copytree(root / "veil-build", copy / "veil-build")
    conf = copy / "veil-build" / "veil.conf"
    conf.write_text(conf.read_text().replace("CHANGE-ME-confirm-16.0-tag", "tor-browser-test-tag"))
    r = run(copy / "veil-build" / "bootstrap.sh", {"WORK_DIR": str(tmp_path / "work")})
    assert r.returncode != 0
    assert "UPSTREAM_SIGNER_FPRS is empty" in r.stderr


def test_build_requires_bootstrap(root, tmp_path):
    r = run(root / "veil-build" / "build.sh", {"WORK_DIR": str(tmp_path)}, "linux-x86_64")
    assert r.returncode != 0 and "run bootstrap.sh first" in r.stderr


def test_build_rejects_unknown_channel(root, tmp_path):
    r = run(root / "veil-build" / "build.sh", {"WORK_DIR": str(tmp_path)}, "linux-x86_64", "beta")
    assert r.returncode == 2


def test_pin_names_tor_browser_16(root):
    conf = (root / "veil-build" / "veil.conf").read_text()
    assert "TOR_BROWSER_VERSION=16.0" in conf
