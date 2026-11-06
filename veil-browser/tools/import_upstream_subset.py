#!/usr/bin/env python3
"""Import a verified subset of the tor-browser tree for cutting VEIL patches.

When the full repository can't be cloned (no access to gitlab.torproject.org),
the files the VEIL patches touch can be fetched one by one by their git blob
ids and packed as a tar with a MANIFEST.json ({repo, commit, tag, files:
[{path, id, mode}]}). This tool:

  1. checks every file's git blob hash against the id in the manifest, so a
     file that changed in transit (or was swapped) is rejected;
  2. creates a git repository holding those files at their upstream paths,
     committed as "upstream subset of <tag> (<commit>)".

Patches cut on top of that commit with `git format-patch` touch only these
files and carry identical context, so they apply to the full tree at the same
commit. bootstrap.sh's `apply` step is the final proof on the build machine.

    python3 import_upstream_subset.py SUBSET.tar WORK_DIR
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path


def git_blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def load(tar_path: Path) -> tuple[dict, dict[str, bytes]]:
    with tarfile.open(tar_path) as tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        if "MANIFEST.json" not in members:
            raise ValueError("MANIFEST.json missing")
        manifest = json.loads(tar.extractfile(members["MANIFEST.json"]).read())
        data = {}
        for entry in manifest["files"]:
            path = entry["path"]
            if path.startswith("/") or ".." in Path(path).parts:
                raise ValueError(f"unsafe path {path!r}")
            if path not in members:
                raise ValueError(f"{path} listed in manifest but not in archive")
            data[path] = tar.extractfile(members[path]).read()
    return manifest, data


def verify(manifest: dict, data: dict[str, bytes]) -> list[str]:
    return [f"{e['path']}: expected {e['id']}, got {git_blob_id(data[e['path']])}"
            for e in manifest["files"] if git_blob_id(data[e["path"]]) != e["id"]]


def import_subset(tar_path: Path, work: Path) -> str:
    manifest, data = load(tar_path)
    bad = verify(manifest, data)
    if bad:
        raise ValueError("hash mismatch:\n  " + "\n  ".join(bad))
    if work.exists() and any(work.iterdir()):
        raise ValueError(f"{work} is not empty")
    work.mkdir(parents=True, exist_ok=True)
    for e in manifest["files"]:
        dest = work / e["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data[e["path"]])
        if e.get("mode") == "100755":
            dest.chmod(0o755)
    git = ["git", "-C", str(work), "-c", "user.name=Upstream subset", "-c", "user.email=upstream@invalid",
           "-c", "commit.gpgSign=false"]
    subprocess.run(["git", "init", "-q", "-b", "upstream", str(work)], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    msg = (f"upstream subset of {manifest['tag']} ({manifest['commit']})\n\n"
           f"{len(manifest['files'])} files from {manifest['repo']}, each checked against its git blob id.")
    subprocess.run(git + ["commit", "-q", "-m", msg], check=True)
    # Prove the tree matches upstream file by file: git's own blob ids must equal the manifest's.
    listed = subprocess.run(git + ["ls-tree", "-r", "HEAD"], capture_output=True, text=True, check=True).stdout
    ids = {line.split("\t", 1)[1]: line.split()[2] for line in listed.splitlines()}
    assert all(ids[e["path"]] == e["id"] for e in manifest["files"])
    return manifest["commit"]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[-1])
    commit = import_subset(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"imported and verified subset of {commit}")
