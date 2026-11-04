"""Gate 4: tampered, mis-signed, cross-channel and downgraded updates are rejected."""
import json
import shutil

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import release_manifest as rm

PIN = "\n".join(f"{k}=v-{k}" for k in rm.PIN_KEYS) + "\n"


@pytest.fixture
def env(tmp_path, root):
    keys = {}
    (tmp_path / "keys").mkdir()
    for ch in rm.CHANNELS:
        k = Ed25519PrivateKey.generate()
        keys[ch] = k
        (tmp_path / "keys" / f"{ch}.pub").write_bytes(k.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    shutil.copy(root / "veil-update" / "channels.json", tmp_path / "channels.json")
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "veil-1.1.0-linux-x86_64.tar.xz").write_bytes(b"browser bytes" * 100)
    (art / "veil-1.1.0-linux-x86_64.mar").write_bytes(b"mar bytes" * 50)
    (art / "sha256sums.txt").write_text("ignored")
    (tmp_path / "pin.lock").write_text(PIN)
    return tmp_path, keys, art


def make(env, channel="release", version="1.1.0", signer=None):
    tmp, keys, art = env
    m = rm.create(channel, version, "linux-x86_64", art, tmp / "pin.lock")
    return rm.sign(m, keys[signer or channel])


def test_good_release_verifies(env):
    tmp, _, art = env
    rm.verify(make(env), tmp / "channels.json", art, installed="1.0.3")


def test_manifest_records_upstream_pin(env):
    m = make(env)
    assert set(m["upstream"]) == set(rm.PIN_KEYS)
    assert {a["name"] for a in m["artifacts"]} == {
        "veil-1.1.0-linux-x86_64.tar.xz", "veil-1.1.0-linux-x86_64.mar"}


def test_tampered_artifact_is_rejected(env):
    tmp, _, art = env
    m = make(env)
    p = art / "veil-1.1.0-linux-x86_64.mar"
    data = bytearray(p.read_bytes()); data[0] ^= 1; p.write_bytes(bytes(data))
    with pytest.raises(rm.ManifestError, match="hash mismatch"):
        rm.verify(m, tmp / "channels.json", art)


def test_edited_manifest_is_rejected(env):
    tmp, _, _ = env
    m = make(env)
    m["artifacts"][0]["sha256"] = "0" * 64
    with pytest.raises(rm.ManifestError, match="signature invalid"):
        rm.verify(m, tmp / "channels.json")


def test_unsigned_manifest_is_rejected(env):
    tmp, _, _ = env
    m = make(env); del m["signature"]
    with pytest.raises(rm.ManifestError, match="not signed"):
        rm.verify(m, tmp / "channels.json")


def test_alpha_key_cannot_sign_a_release(env):
    tmp, _, _ = env
    with pytest.raises(rm.ManifestError, match="release channel key"):
        rm.verify(make(env, signer="alpha"), tmp / "channels.json")


def test_retargeting_channel_breaks_signature(env):
    tmp, _, _ = env
    m = make(env, channel="alpha", version="1.2.0-alpha.1")
    m["channel"] = "release"
    with pytest.raises(rm.ManifestError):
        rm.verify(m, tmp / "channels.json")


@pytest.mark.parametrize("installed", ["1.1.0", "1.2.0", "2.0.0"])
def test_downgrade_and_replay_are_rejected(env, installed):
    tmp, _, _ = env
    with pytest.raises(rm.ManifestError, match="not newer"):
        rm.verify(make(env), tmp / "channels.json", installed=installed)


def test_missing_artifact_is_rejected(env):
    tmp, _, art = env
    m = make(env)
    (art / "veil-1.1.0-linux-x86_64.mar").unlink()
    with pytest.raises(rm.ManifestError, match="artifact missing"):
        rm.verify(m, tmp / "channels.json", art)


def test_version_ordering():
    assert rm.parse_version("1.2.0-alpha.3") < rm.parse_version("1.2.0")
    assert rm.parse_version("1.2.0-alpha.3") < rm.parse_version("1.2.0-alpha.10")
    assert rm.parse_version("1.10.0") > rm.parse_version("1.9.9")
    with pytest.raises(rm.ManifestError):
        rm.parse_version("1.2")


def test_channel_and_version_suffix_must_agree(env):
    tmp, _, art = env
    with pytest.raises(rm.ManifestError):
        rm.create("release", "1.2.0-alpha.1", "t", art, tmp / "pin.lock")
    with pytest.raises(rm.ManifestError):
        rm.create("alpha", "1.2.0", "t", art, tmp / "pin.lock")


def test_cli_round_trip(env):
    tmp, keys, art = env
    key_path = tmp / "release.key"
    key_path.write_bytes(keys["release"].private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    out = tmp / "manifest.json"
    assert rm.main(["create", "--channel", "release", "--version", "1.1.0", "--target", "linux-x86_64",
                    "--artifacts", str(art), "--pin", str(tmp / "pin.lock"), "-o", str(out)]) == 0
    assert rm.main(["sign", str(out), str(key_path)]) == 0
    assert rm.main(["verify", str(out), "--channels", str(tmp / "channels.json"),
                    "--artifacts", str(art), "--installed", "1.0.0"]) == 0
    assert "signature" in json.loads(out.read_text())
