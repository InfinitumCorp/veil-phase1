#!/usr/bin/env python3
"""Sign, verify and bundle the VEIL launcher registry.

The registry ships inside the browser and changes only through signed
browser updates, so no workspace ever fetches it at runtime. Signing it
separately means a tampered registry fails the build even if someone edits
the bundled file.

    registry_tool.py keygen  OUT_PREFIX            # dev keys only; release keys live in the HSM
    registry_tool.py sign    REGISTRY_JSON PRIVKEY # writes REGISTRY_JSON.sig
    registry_tool.py verify  REGISTRY_JSON KEYS_DIR
    registry_tool.py build   REGISTRY_JSON KEYS_DIR OUT_JS
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey)

ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def validate(reg: dict) -> list[str]:
    errors = []
    if reg.get("schema") != 1:
        errors.append("schema must be 1")
    if not isinstance(reg.get("version"), int) or reg["version"] < 1:
        errors.append("version must be a positive integer")
    apps = reg.get("apps")
    if not isinstance(apps, list) or not apps:
        return errors + ["apps must be a non-empty list"]
    seen = set()
    for i, app in enumerate(apps):
        where = f"apps[{i}]"
        if not isinstance(app, dict):
            errors.append(f"{where} must be an object")
            continue
        extra = set(app) - {"id", "name", "summary", "url"}
        if extra:
            errors.append(f"{where} has unknown fields: {sorted(extra)}")
        if not ID_RE.match(str(app.get("id", ""))):
            errors.append(f"{where}.id invalid")
        elif app["id"] in seen:
            errors.append(f"{where}.id duplicate '{app['id']}'")
        else:
            seen.add(app["id"])
        for k in ("name", "summary"):
            if not isinstance(app.get(k), str) or not app[k].strip() or len(app[k]) > 80:
                errors.append(f"{where}.{k} must be 1-80 characters")
        url = app.get("url")
        if not isinstance(url, str) or not url.startswith("https://") or any(c in url for c in "\"'<> "):
            errors.append(f"{where}.url must be a plain https:// URL")
    return errors


def load_keys(keys_dir: Path) -> list[Ed25519PublicKey]:
    keys = []
    for path in sorted(keys_dir.glob("*.pub")):
        key = serialization.load_pem_public_key(path.read_bytes())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError(f"{path} is not an Ed25519 public key")
        keys.append(key)
    if not keys:
        raise ValueError(f"no *.pub keys in {keys_dir}")
    return keys


def verify(reg_path: Path, keys_dir: Path) -> dict:
    reg = json.loads(reg_path.read_text())
    errors = validate(reg)
    if errors:
        raise ValueError("invalid registry: " + "; ".join(errors))
    sig_path = reg_path.with_suffix(reg_path.suffix + ".sig")
    if not sig_path.is_file():
        raise ValueError(f"missing signature {sig_path.name}")
    sig = base64.b64decode(sig_path.read_text().strip(), validate=True)
    data = canonical(reg)
    for key in load_keys(keys_dir):
        try:
            key.verify(sig, data)
            return reg
        except InvalidSignature:
            continue
    raise ValueError("signature does not match any trusted key")


def cmd_keygen(prefix: Path) -> int:
    key = Ed25519PrivateKey.generate()
    prefix.parent.mkdir(parents=True, exist_ok=True)
    priv = prefix.with_suffix(".key")
    priv.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    priv.chmod(0o600)
    prefix.with_suffix(".pub").write_bytes(key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    print(f"wrote {priv} and {prefix.with_suffix('.pub')} (development keys only)")
    return 0


def cmd_sign(reg_path: Path, priv_path: Path) -> int:
    reg = json.loads(reg_path.read_text())
    errors = validate(reg)
    if errors:
        print("refusing to sign: " + "; ".join(errors), file=sys.stderr)
        return 1
    key = serialization.load_pem_private_key(priv_path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        print("not an Ed25519 private key", file=sys.stderr)
        return 1
    sig = key.sign(canonical(reg))
    reg_path.with_suffix(reg_path.suffix + ".sig").write_text(base64.b64encode(sig).decode() + "\n")
    print(f"signed {reg_path.name} version {reg['version']}")
    return 0


def cmd_build(reg_path: Path, keys_dir: Path, out_js: Path) -> int:
    reg = verify(reg_path, keys_dir)
    out_js.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(reg, ensure_ascii=False, sort_keys=True, indent=2)
    # Escape '<' so the JSON can never close a script context.
    payload = payload.replace("<", "\\u003c")
    out_js.write_text(
        "/* Generated by registry_tool.py from a verified, signed registry. Do not edit. */\n"
        '"use strict";\n'
        f"const VEIL_REGISTRY = Object.freeze({payload});\n")
    print(f"wrote {out_js} ({len(reg['apps'])} apps, registry version {reg['version']})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="VEIL launcher registry tool")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("keygen"); p.add_argument("prefix", type=Path)
    p = sub.add_parser("sign"); p.add_argument("registry", type=Path); p.add_argument("key", type=Path)
    p = sub.add_parser("verify"); p.add_argument("registry", type=Path); p.add_argument("keys_dir", type=Path)
    p = sub.add_parser("build"); p.add_argument("registry", type=Path); p.add_argument("keys_dir", type=Path)
    p.add_argument("out_js", type=Path)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "keygen":
            return cmd_keygen(args.prefix)
        if args.cmd == "sign":
            return cmd_sign(args.registry, args.key)
        if args.cmd == "verify":
            reg = verify(args.registry, args.keys_dir)
            print(f"ok: registry version {reg['version']}, {len(reg['apps'])} apps, signature valid")
            return 0
        return cmd_build(args.registry, args.keys_dir, args.out_js)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"registry_tool: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
