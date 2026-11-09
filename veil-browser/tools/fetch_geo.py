#!/usr/bin/env python3
"""Fetch the pinned v2fly geoip.dat and geosite.dat into a gitignored cache.

The browser never runs this script. A maintainer runs it when the lockfile
is updated. Each download is checked against the lockfile hash and the
official .sha256sum asset published beside it. All three must agree. On any
mismatch this exits non-zero and writes nothing.

    python3 veil-browser/tools/fetch_geo.py
    python3 veil-browser/tools/fetch_geo.py --lock PATH --cache DIR

The dat files are local inputs for offline annotation and optional ad and
tracker blocking. They are not a routing table.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = ROOT / "veil-browser" / "data" / "geo" / "geo-lock.json"
DEFAULT_CACHE = ROOT / "veil-browser" / "data" / "geo" / "cache"

ALLOWED_FILES = {"geoip.dat": "geoip.dat", "geosite.dat": "dlc.dat"}
ALLOWED_PROJECTS = {
    "geoip": "v2fly/geoip",
    "geosite": "v2fly/domain-list-community",
}
# These builds are GPL-3 and are not approved for this tree.
FORBIDDEN = ("loyalsoldier", "sing-box", "singbox", "sagernet")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_BYTES = 64 * 1024 * 1024
GITHUB_HOSTS = {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
                "github-releases.githubusercontent.com"}


class VerifyError(Exception):
    pass


def load_lock(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise VerifyError(f"cannot read lockfile {path}: {exc}") from exc
    if data.get("version") != 1 or not isinstance(data.get("datasets"), list):
        raise VerifyError("lockfile must be version 1 with a datasets list")
    if [d.get("id") for d in data["datasets"]] != ["geoip", "geosite"]:
        raise VerifyError("lockfile must list geoip then geosite, and nothing else")
    for ds in data["datasets"]:
        check_dataset(ds)
    return data


def check_dataset(ds: dict) -> None:
    ident = ds.get("id")
    low = json.dumps(ds).lower()
    for banned in FORBIDDEN:
        if banned in low:
            raise VerifyError(f"{ident}: refusing {banned}; it is not an approved source")
    filename = ds.get("filename")
    asset = ds.get("asset")
    if ALLOWED_FILES.get(filename) != asset:
        raise VerifyError(f"{ident}: filename/asset pair is not an approved v2fly file")
    if ds.get("project") != ALLOWED_PROJECTS.get(ident):
        raise VerifyError(f"{ident}: project must be {ALLOWED_PROJECTS.get(ident)}")
    digest = str(ds.get("sha256", "")).lower()
    if not HASH_RE.fullmatch(digest):
        raise VerifyError(f"{ident}: lockfile sha256 is not 64 hex characters")
    for key in ("url", "sha256sum_url"):
        _check_url(ds.get(key, ""), asset if key == "url" else f"{asset}.sha256sum")


def _check_url(url: str, asset: str) -> None:
    from urllib.parse import urlparse
    parts = urlparse(url)
    if parts.scheme != "https" or parts.hostname != "github.com":
        raise VerifyError(f"refusing URL that is not https://github.com: {url}")
    if ".." in parts.path or not parts.path.endswith("/" + asset):
        raise VerifyError(f"refusing URL whose asset is not {asset}: {url}")
    if not parts.path.startswith("/v2fly/"):
        raise VerifyError(f"refusing URL outside the v2fly organisation: {url}")


def parse_sha256sum(text: str, asset: str) -> str:
    """Return the single hash the official .sha256sum file publishes for asset."""
    found = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        bits = line.split()
        digest = bits[0].lower()
        if not HASH_RE.fullmatch(digest):
            raise VerifyError(f"official checksum line is not a SHA-256: {raw!r}")
        if len(bits) == 1:
            found.append(digest)
            continue
        name = bits[-1].lstrip("*")
        if name != asset and not name.endswith("/" + asset):
            raise VerifyError(f"official checksum names {name}, not {asset}")
        found.append(digest)
    if len(found) != 1:
        raise VerifyError(f"official checksum for {asset} must be exactly one hash, found {len(found)}")
    return found[0]


def verify_bytes(data: bytes, sha256sum_text: str, dataset: dict) -> str:
    """Fail unless the bytes, the lockfile, and the official .sha256sum all match."""
    if len(data) > MAX_BYTES:
        raise VerifyError(f"{dataset['filename']}: download is larger than {MAX_BYTES} bytes")
    official = parse_sha256sum(sha256sum_text, dataset["asset"])
    actual = hashlib.sha256(data).hexdigest()
    expected = dataset["sha256"].lower()
    problems = []
    if official != expected:
        problems.append(f"official .sha256sum {official} != lockfile {expected}")
    if actual != expected:
        problems.append(f"downloaded SHA-256 {actual} != lockfile {expected}")
    if actual != official:
        problems.append(f"downloaded SHA-256 {actual} != official .sha256sum {official}")
    if problems:
        raise VerifyError(f"{dataset['filename']}: verification failed; " + "; ".join(problems))
    return actual


def install(lock: dict, dest: Path, read_url) -> list[Path]:
    """Download and verify every dataset, then publish them into dest.

    read_url(url) -> bytes. Nothing is written if any dataset fails.
    """
    staged: list[tuple[str, bytes]] = []
    for ds in lock["datasets"]:
        check_dataset(ds)
        try:
            blob = read_url(ds["url"])
            sums = read_url(ds["sha256sum_url"])
        except VerifyError:
            raise
        except Exception as exc:
            raise VerifyError(f"{ds['filename']}: download failed: {exc}") from exc
        if not isinstance(blob, (bytes, bytearray)) or not isinstance(sums, (bytes, bytearray)):
            raise VerifyError(f"{ds['filename']}: downloader must return bytes")
        try:
            text = bytes(sums).decode("utf-8")
        except UnicodeError as exc:
            raise VerifyError(f"{ds['filename']}: official checksum is not UTF-8") from exc
        verify_bytes(bytes(blob), text, ds)
        staged.append((ds["filename"], bytes(blob)))

    dest.mkdir(parents=True, exist_ok=True)
    written = []
    partials = []
    try:
        for name, blob in staged:
            if name not in ALLOWED_FILES or "/" in name or "\\" in name:
                raise VerifyError(f"refusing to write unexpected name {name}")
            target = (dest / name).resolve()
            if target.parent != dest.resolve():
                raise VerifyError(f"refusing to write outside the cache: {target}")
            partial = dest / f".{name}.partial"
            partials.append(partial)
            partial.write_bytes(blob)
            partial.replace(target)
            written.append(target)
    except Exception:
        for partial in partials:
            partial.unlink(missing_ok=True)
        raise
    return written


def http_read(url: str, timeout: int = 120) -> bytes:
    from urllib.parse import urlparse
    parts = urlparse(url)
    if parts.scheme != "https" or parts.hostname not in GITHUB_HOSTS:
        raise VerifyError(f"refusing download host {parts.hostname}")
    req = urllib.request.Request(url, headers={"User-Agent": "veil-geo-fetch"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - pinned https hosts above
            final = urlparse(resp.geturl())
            if final.scheme != "https" or final.hostname not in GITHUB_HOSTS:
                raise VerifyError(f"refusing redirect host {final.hostname}")
            chunks = []
            total = 0
            while True:
                block = resp.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_BYTES:
                    raise VerifyError(f"download exceeded {MAX_BYTES} bytes")
                chunks.append(block)
    except VerifyError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise VerifyError(f"download failed for {url}: {exc}") from exc
    return b"".join(chunks)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch pinned v2fly geo datasets into a gitignored cache.")
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = parser.parse_args(argv)
    try:
        lock = load_lock(args.lock)
        written = install(lock, args.cache, http_read)
    except VerifyError as exc:
        print(f"fetch_geo: {exc}", file=sys.stderr)
        print("fetch_geo: nothing new was published; stopping.", file=sys.stderr)
        return 1
    for path in written:
        print(f"verified {path.name} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
