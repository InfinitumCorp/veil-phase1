#!/usr/bin/env python3
"""Find the exact upstream Tor Browser tags for the pinned release.

Run on a machine that can reach gitlab.torproject.org, before bootstrap:

    python3 veil-build/scripts/resolve_upstream.py            # report only
    python3 veil-build/scripts/resolve_upstream.py --write    # also update veil.conf

For TOR_BROWSER_VERSION (for example 16.0) and TOR_BROWSER_ESR (for example
153.6.0esr) it lists the tags in both upstream repositories, keeps only the
final release tags (no alphas, no later point releases), and picks the highest
buildN of each. It then fetches just those tag objects (no source) and reports
the OpenPGP key that signed each one.

It never trusts a key by itself: --write records the tags, and records signer
fingerprints only if they are listed with --trust, which a reviewer passes
after checking them against the Tor Project's published signing keys.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

CONF = Path(__file__).resolve().parents[1] / "veil.conf"


@dataclass
class Tag:
    name: str
    build: int
    commit: str
    signer: str | None = None


def read_conf(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m:
            values[m.group(1)] = m.group(2).strip()
    return values


def tag_patterns(version: str, esr: str) -> dict[str, re.Pattern]:
    v, e = re.escape(version), re.escape(esr)
    return {
        "TOR_BROWSER_BUILD_TAG": re.compile(rf"^tbb-{v}-build(\d+)$"),
        "TOR_BROWSER_TAG": re.compile(rf"^tor-browser-{e}-{v}-1-build(\d+)$"),
    }


def ls_remote_tags(url: str) -> dict[str, str]:
    """Tag name -> commit it points at (peeled for annotated tags)."""
    out = subprocess.run(["git", "ls-remote", "--tags", url], capture_output=True, text=True, check=True).stdout
    tags: dict[str, str] = {}
    for line in out.splitlines():
        sha, ref = line.split("\t", 1)
        name = ref.removeprefix("refs/tags/")
        if name.endswith("^{}"):
            tags[name[:-3]] = sha                 # peeled: the commit itself
        else:
            tags.setdefault(name, sha)
    return tags


def newest(tags: dict[str, str], pattern: re.Pattern) -> Tag | None:
    found = [Tag(n, int(m.group(1)), c) for n, c in tags.items() if (m := pattern.match(n))]
    return max(found, key=lambda t: t.build) if found else None


def tag_signer(url: str, tag: str) -> str | None:
    """Fingerprint of the key that signed `tag`, read from the signature packet.

    Fetches only the tag and commit objects (no trees or files), so it is fast
    even for the Firefox-sized tor-browser repository.
    """
    with tempfile.TemporaryDirectory() as d:
        git = ["git", "-C", d]
        subprocess.run(["git", "init", "-q", d], check=True)
        r = subprocess.run(git + ["fetch", "-q", "--no-tags", "--depth=1", "--filter=tree:0", url,
                                  f"refs/tags/{tag}:refs/tags/{tag}"], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"could not fetch {tag}: {r.stderr.strip()}")
        body = subprocess.run(git + ["cat-file", "tag", tag], capture_output=True, text=True).stdout
        m = re.search(r"-----BEGIN PGP SIGNATURE-----.*?-----END PGP SIGNATURE-----", body, re.S)
        if not m:
            return None
        packets = subprocess.run(["gpg", "--list-packets"], input=m.group(0), capture_output=True, text=True,
                                 env={"GNUPGHOME": d, "PATH": "/usr/bin:/bin:/usr/local/bin"}).stdout
        fpr = re.search(r"issuer fpr v\d ([0-9A-F]{40})", packets)
        if fpr:
            return fpr.group(1)
        keyid = re.search(r"keyid ([0-9A-F]{16})", packets)
        return keyid.group(1) if keyid else None


def write_conf(path: Path, updates: dict[str, str]) -> None:
    lines = path.read_text().splitlines()
    for key, value in updates.items():
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={value}"
                break
        else:
            raise KeyError(f"{key} not found in {path}")
    path.write_text("\n".join(lines) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--conf", type=Path, default=CONF)
    p.add_argument("--write", action="store_true", help="record the resolved tags in veil.conf")
    p.add_argument("--trust", nargs="*", default=[], metavar="FPR",
                   help="signer fingerprints a reviewer has checked; recorded as UPSTREAM_SIGNER_FPRS")
    p.add_argument("--no-signers", action="store_true", help="skip fetching tag objects")
    a = p.parse_args(argv)

    conf = read_conf(a.conf)
    version, esr = conf.get("TOR_BROWSER_VERSION"), conf.get("TOR_BROWSER_ESR")
    if not version or not esr:
        print("veil.conf needs TOR_BROWSER_VERSION and TOR_BROWSER_ESR", file=sys.stderr)
        return 2
    repos = {"TOR_BROWSER_BUILD_TAG": conf["TOR_BROWSER_BUILD_URL"], "TOR_BROWSER_TAG": conf["TOR_BROWSER_URL"]}

    resolved: dict[str, Tag] = {}
    for key, pattern in tag_patterns(version, esr).items():
        tag = newest(ls_remote_tags(repos[key]), pattern)
        if tag is None:
            print(f"{key}: no tag matches {pattern.pattern} in {repos[key]}", file=sys.stderr)
            return 1
        if not a.no_signers:
            tag.signer = tag_signer(repos[key], tag.name)
        resolved[key] = tag
        print(f"{key}={tag.name}")
        print(f"  commit  {tag.commit}")
        print(f"  signer  {tag.signer or ('(not checked)' if a.no_signers else 'UNSIGNED')}")

    signers = {t.signer for t in resolved.values() if t.signer}
    trusted = {f.replace(" ", "").upper() for f in a.trust}
    if a.write:
        if not a.no_signers and any(t.signer is None for t in resolved.values()):
            print("refusing to write: an upstream tag is unsigned", file=sys.stderr)
            return 1
        unknown = signers - trusted
        updates = {k: t.name for k, t in resolved.items()}
        if trusted:
            if unknown:
                print("refusing to write: tags signed by keys not passed to --trust: " + " ".join(sorted(unknown)),
                      file=sys.stderr)
                return 1
            updates["UPSTREAM_SIGNER_FPRS"] = '"' + " ".join(sorted(trusted)) + '"'
        write_conf(a.conf, updates)
        print(f"wrote {', '.join(updates)} to {a.conf}")
    elif signers:
        print("\nCheck these signers against the Tor Project's published keys, then rerun with:")
        print("  --write --trust " + " ".join(sorted(signers)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
