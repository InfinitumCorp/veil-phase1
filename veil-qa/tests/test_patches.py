"""The patch linter enforces tags, reasons and reviewer counts."""
import veil_patches

DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n"


def patch(tag="chrome", reason="Needed for the dashboard", reviewers=("A <a@x.org>",), subject="Add page"):
    trailers = ""
    if tag is not None:
        trailers += f"VEIL-Tag: {tag}\n"
    if reason is not None:
        trailers += f"VEIL-Reason: {reason}\n"
    trailers += "".join(f"Reviewed-by: {r}\n" for r in reviewers)
    return (f"From abc Mon Sep 17 00:00:00 2001\nFrom: Dev <d@x.org>\nSubject: [PATCH] {subject}\n\n"
            f"Body.\n\n{trailers}---\n f | 2 +-\n\n{DIFF}")


def series(tmp_path, patches):
    d = tmp_path / "patches"
    d.mkdir(parents=True)
    for name, text in patches.items():
        (d / name).write_text(text)
    (d / "series").write_text("# order\n" + "\n".join(patches) + "\n")
    return d


def test_shipped_series_passes_lint(root):
    assert veil_patches.lint(root / "veil-browser" / "patches") == 0


def test_good_patch_passes(tmp_path):
    assert veil_patches.lint(series(tmp_path, {"0001-a.patch": patch()})) == 0


def test_missing_tag_fails(tmp_path):
    info = veil_patches.parse_patch(series(tmp_path, {"0001-a.patch": patch(tag=None)}) / "0001-a.patch")
    assert any("VEIL-Tag" in e for e in info.errors)


def test_unknown_tag_fails(tmp_path):
    info = veil_patches.parse_patch(series(tmp_path, {"p.patch": patch(tag="misc")}) / "p.patch")
    assert any("unknown VEIL-Tag" in e for e in info.errors)


def test_missing_reason_fails(tmp_path):
    info = veil_patches.parse_patch(series(tmp_path, {"p.patch": patch(reason=None)}) / "p.patch")
    assert any("VEIL-Reason" in e for e in info.errors)


def test_sensitive_tags_need_two_distinct_reviewers(tmp_path):
    for tag in ("network", "fingerprint", "content", "workspace"):
        d = series(tmp_path / tag, {"p.patch": patch(tag=tag)})
        assert veil_patches.lint(d) == 1, tag
        d2 = series(tmp_path / f"{tag}2", {"p.patch": patch(tag=tag, reviewers=("A <a@x.org>", "B <b@x.org>"))})
        assert veil_patches.lint(d2) == 0, tag


def test_same_reviewer_twice_does_not_count(tmp_path):
    d = series(tmp_path, {"p.patch": patch(tag="network", reviewers=("A <a@x.org>", "A again <A@x.org>"))})
    assert veil_patches.lint(d) == 1


def test_patch_without_diff_fails(tmp_path):
    text = patch().split("diff --git")[0]
    assert veil_patches.lint(series(tmp_path, {"p.patch": text})) == 1


def test_unlisted_patch_file_fails(tmp_path):
    d = series(tmp_path, {"0001-a.patch": patch()})
    (d / "0002-stray.patch").write_text(patch())
    assert veil_patches.lint(d) == 1


def test_apply_refuses_failing_series(tmp_path):
    d = series(tmp_path, {"p.patch": patch(tag=None)})
    assert veil_patches.apply(d, tmp_path / "checkout") == 1


def test_new_writes_template_with_right_reviewer_slots(tmp_path):
    d = tmp_path / "patches"
    d.mkdir()
    (d / "series").write_text("")
    assert veil_patches.new(d, "fingerprint", "Keep canvas behaviour") == 0
    text = next(d.glob("0001-*.patch")).read_text()
    assert text.count("Reviewed-by:") == 2 and "VEIL-Tag: fingerprint" in text


def test_pending_series_passes_lint_except_reviews(root):
    for d in ("veil-browser/patches/pending", "veil-build/patches/pending"):
        assert veil_patches.lint(root / d, pending=True) == 0, d
        # ...and is not accepted as a reviewed series.
        assert veil_patches.lint(root / d) == 1, d


def test_pending_series_is_the_planned_order(root):
    names = [l for l in (root / "veil-browser/patches/pending/series").read_text().splitlines()
             if l and not l.startswith("#")]
    assert [n[:4] for n in names] == ["0001", "0002", "0003", "0004", "0006"]
    tags = [veil_patches.parse_patch(root / "veil-browser/patches/pending" / n, pending=True).tag for n in names]
    assert tags == ["branding", "chrome", "network", "network", "chrome"]
