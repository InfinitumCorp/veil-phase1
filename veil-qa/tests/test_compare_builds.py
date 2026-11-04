"""Gate 1: two builders must agree byte for byte."""
import compare_builds

PIN = "tor_browser_version=16.0\ntor_browser_commit=abc123\n"
H1, H2 = "a" * 64, "b" * 64


def builder(tmp_path, name, sums, pin=PIN):
    d = tmp_path / name
    d.mkdir()
    (d / "pin.lock").write_text(pin)
    (d / "sha256sums.txt").write_text("".join(f"{h}  {n}\n" for n, h in sums.items()))
    return d


def test_identical_builds_pass(tmp_path):
    a = builder(tmp_path, "a", {"veil-linux.tar.xz": H1, "veil.mar": H2})
    b = builder(tmp_path, "b", {"veil.mar": H2, "veil-linux.tar.xz": H1})
    assert compare_builds.compare(a, b)["identical"]
    assert compare_builds.main([str(a), str(b)]) == 0


def test_one_byte_difference_fails(tmp_path):
    a = builder(tmp_path, "a", {"veil-linux.tar.xz": H1})
    b = builder(tmp_path, "b", {"veil-linux.tar.xz": H2})
    report = compare_builds.compare(a, b)
    assert not report["identical"] and report["differ"] == ["veil-linux.tar.xz"]
    assert compare_builds.main([str(a), str(b)]) == 1


def test_missing_artifact_fails(tmp_path):
    a = builder(tmp_path, "a", {"x.tar.xz": H1, "y.mar": H2})
    b = builder(tmp_path, "b", {"x.tar.xz": H1})
    assert compare_builds.compare(a, b)["only_a"] == ["y.mar"]


def test_different_upstream_pin_fails(tmp_path):
    a = builder(tmp_path, "a", {"x": H1})
    b = builder(tmp_path, "b", {"x": H1}, pin=PIN.replace("abc123", "def456"))
    report = compare_builds.compare(a, b)
    assert not report["identical"] and "tor_browser_commit" in report["pin_mismatch"]


def test_empty_build_is_not_reproducible(tmp_path):
    a = builder(tmp_path, "a", {})
    b = builder(tmp_path, "b", {})
    assert not compare_builds.compare(a, b)["identical"]


def test_malformed_sums_is_bad_input(tmp_path):
    a = builder(tmp_path, "a", {"x": H1})
    b = builder(tmp_path, "b", {"x": H1})
    (b / "sha256sums.txt").write_text("not-a-hash  x\n")
    assert compare_builds.main([str(a), str(b)]) == 2
