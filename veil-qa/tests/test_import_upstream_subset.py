"""import_upstream_subset.py accepts only files whose git blob ids match the manifest."""
import io
import json
import subprocess
import tarfile

import pytest

import import_upstream_subset as ius


def make_tar(path, files, manifest_files=None):
    manifest = {"repo": "https://example.invalid/tor-browser.git", "commit": "c" * 40, "tag": "tor-browser-test",
                "files": manifest_files or [{"path": p, "id": ius.git_blob_id(d), "mode": "100644"} for p, d in files.items()]}
    with tarfile.open(path, "w") as tar:
        for name, data in [("MANIFEST.json", json.dumps(manifest).encode()), *files.items()]:
            info = tarfile.TarInfo(name); info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


def test_blob_id_matches_git(tmp_path):
    f = tmp_path / "x"; f.write_bytes(b"hello\n")
    assert ius.git_blob_id(b"hello\n") == subprocess.run(["git", "hash-object", str(f)], capture_output=True, text=True).stdout.strip()


def test_imports_verified_files(tmp_path):
    files = {"browser/a.js": b"a\n", "toolkit/b/c.mjs": b"c\n"}
    make_tar(tmp_path / "s.tar", files)
    assert ius.import_subset(tmp_path / "s.tar", tmp_path / "work") == "c" * 40
    assert (tmp_path / "work" / "toolkit/b/c.mjs").read_bytes() == b"c\n"


def test_rejects_changed_file(tmp_path):
    files = {"browser/a.js": b"a\n"}
    make_tar(tmp_path / "s.tar", {"browser/a.js": b"tampered\n"},
             [{"path": "browser/a.js", "id": ius.git_blob_id(b"a\n"), "mode": "100644"}])
    with pytest.raises(ValueError, match="hash mismatch"):
        ius.import_subset(tmp_path / "s.tar", tmp_path / "work")


def test_rejects_unsafe_paths(tmp_path):
    make_tar(tmp_path / "s.tar", {"../evil": b"x"})
    with pytest.raises(ValueError, match="unsafe"):
        ius.import_subset(tmp_path / "s.tar", tmp_path / "work")
