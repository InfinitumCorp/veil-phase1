#!/usr/bin/env python3
"""Create, sign and verify VEIL release manifests.

A release manifest is published (and independently checked) before an
update is served. It lists every artifact's hash and size, the upstream pin
the build came from, and is signed with the channel's Ed25519 manifest key.
Separate keys per channel mean an alpha key can never sign a release.

    release_manifest.py create  --channel C --version V --target T --artifacts DIR --pin PIN.LOCK -o OUT.json
    release_manifest.py sign    MANIFEST.json PRIVKEY
    release_manifest.py verify  MANIFEST.json --channels CHANNELS.json [--artifacts DIR] [--installed VERSION]

verify fails on: bad signature, a key from another channel, an artifact whose
hash or size differs, a missing artifact, or a version not newer than the
installed one (downgrade or replay).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey)

CHANNELS = ("release", "alpha", "nightly")
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|nightly)\.(\d+))?$")
PIN_KEYS = ("tor_browser_version", "tor_browser_build_tag", "tor_browser_build_commit",
            "tor_browser_tag", "tor_browser_commit", "veil_browser_head")


class ManifestError(Exception):
    pass


def parse_version(v: str) -> tuple:
    """MAJOR.MINOR.PATCH with optional -alpha.N / -nightly.N pre-release.

    A pre-release sorts before the plain version it leads to:
    1.2.0-alpha.3 < 1.2.0-nightly.1 < 1.2.0
    """
    m = VERSION_RE.match(v or "")
    if not m:
        raise ManifestError(f"bad version '{v}' (want MAJOR.MINOR.PATCH[-alpha.N|-nightly.N])")
    major, minor, patch, pre, num = m.groups()
    pre_rank = {"alpha": 0, "nightly": 1, None: 2}[pre]
    return int(major), int(minor), int(patch), pre_rank, int(num or 0)


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_pin(path: Path) -> dict:
    pin = {}
    for line in path.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            pin[k.strip()] = v.strip()
    missing = [k for k in PIN_KEYS if not pin.get(k)]
    if missing:
        raise ManifestError(f"pin.lock missing {missing}")
    return {k: pin[k] for k in PIN_KEYS}


def create(channel: str, version: str, target: str, artifacts: Path, pin: Path) -> dict:
    if channel not in CHANNELS:
        raise ManifestError(f"unknown channel '{channel}'")
    parsed = parse_version(version)
    if channel == "release" and parsed[3] != 2:
        raise ManifestError("release channel versions cannot carry a pre-release suffix")
    if channel != "release" and parsed[3] == 2:
        raise ManifestError(f"{channel} versions need a -{channel}.N suffix")
    files = sorted(p for p in artifacts.iterdir()
                   if p.is_file() and p.name not in ("sha256sums.txt", "pin.lock"))
    if not files:
        raise ManifestError(f"no artifacts in {artifacts}")
    return {
        "schema": 1,
        "channel": channel,
        "version": version,
        "target": target,
        "upstream": read_pin(pin),
        "artifacts": [{"name": p.name, "sha256": sha256_file(p), "size": p.stat().st_size}
                      for p in files],
    }


def sign(manifest: dict, key: Ed25519PrivateKey) -> dict:
    body = {k: v for k, v in manifest.items() if k != "signature"}
    sig = key.sign(canonical(body))
    return {**body, "signature": base64.b64encode(sig).decode()}


def load_channel_key(channels_path: Path, channel: str) -> Ed25519PublicKey:
    cfg = json.loads(channels_path.read_text())
    try:
        rel = cfg["channels"][channel]["manifest_key"]
    except KeyError:
        raise ManifestError(f"channel '{channel}' not defined in {channels_path.name}")
    key = serialization.load_pem_public_key((channels_path.parent / rel).read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise ManifestError(f"{rel} is not an Ed25519 key")
    return key


def verify(manifest: dict, channels_path: Path, artifacts: Path | None = None,
           installed: str | None = None) -> None:
    if manifest.get("schema") != 1:
        raise ManifestError("unsupported manifest schema")
    channel = manifest.get("channel")
    if channel not in CHANNELS:
        raise ManifestError(f"unknown channel '{channel}'")
    sig_b64 = manifest.get("signature")
    if not isinstance(sig_b64, str):
        raise ManifestError("manifest is not signed")
    try:
        sig = base64.b64decode(sig_b64, validate=True)
    except ValueError:
        raise ManifestError("signature is not valid base64")
    body = {k: v for k, v in manifest.items() if k != "signature"}
    try:
        load_channel_key(channels_path, channel).verify(sig, canonical(body))
    except InvalidSignature:
        raise ManifestError(f"signature invalid for the {channel} channel key")

    new_version = parse_version(manifest.get("version", ""))
    if installed is not None and new_version <= parse_version(installed):
        raise ManifestError(
            f"version {manifest['version']} is not newer than installed {installed} (downgrade or replay)")

    if artifacts is not None:
        for art in manifest.get("artifacts", []):
            path = artifacts / art["name"]
            if not path.is_file():
                raise ManifestError(f"artifact missing: {art['name']}")
            if path.stat().st_size != art["size"]:
                raise ManifestError(f"size mismatch: {art['name']}")
            if sha256_file(path) != art["sha256"]:
                raise ManifestError(f"hash mismatch: {art['name']}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="VEIL release manifests")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create")
    p.add_argument("--channel", required=True); p.add_argument("--version", required=True)
    p.add_argument("--target", required=True); p.add_argument("--artifacts", type=Path, required=True)
    p.add_argument("--pin", type=Path, required=True); p.add_argument("-o", "--out", type=Path, required=True)
    p = sub.add_parser("sign"); p.add_argument("manifest", type=Path); p.add_argument("key", type=Path)
    p = sub.add_parser("verify"); p.add_argument("manifest", type=Path)
    p.add_argument("--channels", type=Path, required=True)
    p.add_argument("--artifacts", type=Path); p.add_argument("--installed")
    args = ap.parse_args(argv)

    try:
        if args.cmd == "create":
            m = create(args.channel, args.version, args.target, args.artifacts, args.pin)
            args.out.write_text(json.dumps(m, indent=2) + "\n")
            print(f"wrote {args.out} ({len(m['artifacts'])} artifacts, unsigned)")
        elif args.cmd == "sign":
            key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ManifestError("not an Ed25519 private key")
            m = sign(json.loads(args.manifest.read_text()), key)
            args.manifest.write_text(json.dumps(m, indent=2) + "\n")
            print(f"signed {args.manifest}")
        else:
            m = json.loads(args.manifest.read_text())
            verify(m, args.channels, args.artifacts, args.installed)
            print(f"ok: {m['channel']} {m['version']} for {m['target']}, signature valid")
        return 0
    except (ManifestError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"release_manifest: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
