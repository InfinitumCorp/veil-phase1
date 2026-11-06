"""resolve_upstream.py picks the right signed 16.0 tags and never trusts a key on its own."""
import os
import shutil
import subprocess

import pytest

import resolve_upstream as ru

pytestmark = pytest.mark.skipif(shutil.which("gpg") is None or shutil.which("git") is None, reason="needs git and gpg")


def sh(*cmd, cwd=None, env=None):
    return subprocess.run(cmd, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def signer(tmp_path):
    home = tmp_path / "gnupg"
    home.mkdir(mode=0o700)
    env = {**os.environ, "GNUPGHOME": str(home)}
    sh("gpg", "--batch", "--passphrase", "", "--quick-gen-key", "Upstream Test <up@example.test>", "ed25519", "sign", "never", env=env)
    fpr = [l.split(":")[9] for l in sh("gpg", "--with-colons", "--list-secret-keys", env=env).splitlines()
           if l.startswith("fpr:")][0]
    return env, fpr


def make_repo(path, tags, env, signed=True, key=None):
    """A bare 'upstream' with one commit and the given OpenPGP-signed tags."""
    work = path.with_suffix(".work")
    sh("git", "init", "-q", str(work))
    g = ["git", "-C", str(work), "-c", "user.name=Up", "-c", "user.email=up@example.test",
         "-c", "gpg.format=openpgp", "-c", "tag.gpgSign=false", "-c", "commit.gpgSign=false"] + (["-c", f"user.signingkey={key}"] if key else [])
    sh(*g, "commit", "-q", "--allow-empty", "-m", "base", env=env)
    for t in tags:
        sh(*g, "tag", "-s" if signed else "-a", "-m", t, t, env=env)
    sh("git", "clone", "-q", "--bare", str(work), str(path))
    return f"file://{path}"


def make_conf(tmp_path, build_url, browser_url):
    conf = tmp_path / "veil.conf"
    conf.write_text(
        "TOR_BROWSER_VERSION=16.0\nTOR_BROWSER_ESR=153.6.0esr\n"
        f"TOR_BROWSER_BUILD_URL={build_url}\nTOR_BROWSER_URL={browser_url}\n"
        "TOR_BROWSER_BUILD_TAG=CHANGE-ME-run-resolve_upstream\nTOR_BROWSER_TAG=CHANGE-ME-run-resolve_upstream\n"
        "UPSTREAM_SIGNER_FPRS=\n")
    return conf


BUILD_TAGS = ["tbb-16.0a14-build1", "tbb-16.0-build1", "tbb-16.0-build2", "tbb-16.0.1-build1", "tbb-15.0.26-build1"]
BROWSER_TAGS = ["tor-browser-153.5.0esr-16.0-1-build1", "tor-browser-153.6.0esr-16.0-1-build1",
                "tor-browser-153.6.0esr-16.0-1-build3", "tor-browser-153.6.0esr-16.0-2-build1"]


def test_patterns_keep_only_the_final_release():
    pats = ru.tag_patterns("16.0", "153.6.0esr")
    assert [t for t in BUILD_TAGS if pats["TOR_BROWSER_BUILD_TAG"].match(t)] == ["tbb-16.0-build1", "tbb-16.0-build2"]
    assert [t for t in BROWSER_TAGS if pats["TOR_BROWSER_TAG"].match(t)] == [
        "tor-browser-153.6.0esr-16.0-1-build1", "tor-browser-153.6.0esr-16.0-1-build3"]


def test_newest_compares_build_numbers_as_numbers():
    pat = ru.tag_patterns("16.0", "153.6.0esr")["TOR_BROWSER_BUILD_TAG"]
    assert ru.newest({"tbb-16.0-build2": "a", "tbb-16.0-build10": "b"}, pat).name == "tbb-16.0-build10"


def test_resolves_tags_reports_signer_and_writes_only_trusted(tmp_path, signer, capsys):
    env, fpr = signer
    conf = make_conf(tmp_path, make_repo(tmp_path / "build.git", BUILD_TAGS, env, key=fpr),
                     make_repo(tmp_path / "browser.git", BROWSER_TAGS, env, key=fpr))
    os.environ["GNUPGHOME"] = env["GNUPGHOME"]
    try:
        assert ru.main(["--conf", str(conf)]) == 0
        out = capsys.readouterr().out
        assert "TOR_BROWSER_BUILD_TAG=tbb-16.0-build2" in out
        assert "TOR_BROWSER_TAG=tor-browser-153.6.0esr-16.0-1-build3" in out
        assert f"signer  {fpr}" in out
        assert "CHANGE-ME" in conf.read_text()                      # report only

        assert ru.main(["--conf", str(conf), "--write", "--trust", "0" * 40]) == 1   # signer not trusted
        assert "CHANGE-ME" in conf.read_text()

        assert ru.main(["--conf", str(conf), "--write", "--trust", fpr]) == 0
        values = ru.read_conf(conf)
        assert values["TOR_BROWSER_BUILD_TAG"] == "tbb-16.0-build2"
        assert values["TOR_BROWSER_TAG"] == "tor-browser-153.6.0esr-16.0-1-build3"
        assert values["UPSTREAM_SIGNER_FPRS"] == f'"{fpr}"'
    finally:
        os.environ.pop("GNUPGHOME", None)


def test_refuses_to_write_unsigned_tags(tmp_path, signer):
    env, fpr = signer
    conf = make_conf(tmp_path, make_repo(tmp_path / "build.git", BUILD_TAGS, env, signed=False),
                     make_repo(tmp_path / "browser.git", BROWSER_TAGS, env, signed=False))
    assert ru.main(["--conf", str(conf), "--write"]) == 1
    assert "CHANGE-ME" in conf.read_text()


def test_missing_release_tag_is_an_error(tmp_path, signer):
    env, fpr = signer
    conf = make_conf(tmp_path, make_repo(tmp_path / "build.git", ["tbb-16.0a14-build1"], env, key=fpr),
                     make_repo(tmp_path / "browser.git", BROWSER_TAGS, env, key=fpr))
    assert ru.main(["--conf", str(conf), "--no-signers"]) == 1
