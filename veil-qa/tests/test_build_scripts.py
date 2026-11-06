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


def _copy_with_conf(root, tmp_path, **values):
    copy = tmp_path / "veil"
    shutil.copytree(root / "veil-build", copy / "veil-build")
    conf = copy / "veil-build" / "veil.conf"
    lines = conf.read_text().splitlines()
    for k, v in values.items():
        lines = [f"{k}={v}" if l.startswith(f"{k}=") else l for l in lines]
    conf.write_text("\n".join(lines) + "\n")
    return copy


def test_bootstrap_refuses_unconfirmed_tag(root, tmp_path):
    copy = _copy_with_conf(root, tmp_path, TOR_BROWSER_TAG="CHANGE-ME-run-resolve_upstream")
    r = run(copy / "veil-build" / "bootstrap.sh", {"WORK_DIR": str(tmp_path / "work")})
    assert r.returncode != 0
    assert "TOR_BROWSER_TAG is not confirmed" in r.stderr


def test_bootstrap_refuses_unconfirmed_build_tag(root, tmp_path):
    copy = _copy_with_conf(root, tmp_path, TOR_BROWSER_BUILD_TAG="CHANGE-ME-run-resolve_upstream")
    r = run(copy / "veil-build" / "bootstrap.sh", {"WORK_DIR": str(tmp_path / "work")})
    assert r.returncode != 0
    assert "TOR_BROWSER_BUILD_TAG is not confirmed" in r.stderr


def test_bootstrap_refuses_missing_signer_keys(root, tmp_path):
    copy = _copy_with_conf(root, tmp_path, UPSTREAM_SIGNER_FPRS="")
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
    assert "TOR_BROWSER_ESR=153.6.0esr" in conf


def test_pin_is_confirmed_and_signed(root):
    import resolve_upstream as ru
    conf = ru.read_conf(root / "veil-build" / "veil.conf")
    assert conf["TOR_BROWSER_BUILD_TAG"] == "tbb-16.0-build1"
    assert conf["TOR_BROWSER_TAG"] == "tor-browser-153.6.0esr-16.0-1-build3"
    assert ru.tag_patterns("16.0", "153.6.0esr")["TOR_BROWSER_TAG"].match(conf["TOR_BROWSER_TAG"])
    fprs = conf["UPSTREAM_SIGNER_FPRS"].strip('"').split()
    assert "B134686F5A2C8DCA475AB4034B60306A5EA28FAE" in fprs and "6621290E449B26AFB029C3BFF21A8411E6B9D00F" in fprs


def test_shipped_keys_cover_pinned_signers(root, tmp_path):
    if shutil.which("gpg") is None:
        import pytest; pytest.skip("needs gpg")
    import resolve_upstream as ru
    fprs = ru.read_conf(root / "veil-build" / "veil.conf")["UPSTREAM_SIGNER_FPRS"].strip('"').split()
    env = {**os.environ, "GNUPGHOME": str(tmp_path)}
    os.chmod(tmp_path, 0o700)
    out = subprocess.run(["gpg", "--batch", "--with-colons", "--show-keys", *map(str, (root / "veil-build" / "keys").glob("*.gpg"))],
                         capture_output=True, text=True, env=env).stdout
    shipped = {l.split(":")[9] for l in out.splitlines() if l.startswith("fpr:")}
    assert set(fprs) <= shipped
