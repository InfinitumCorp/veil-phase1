#!/usr/bin/env python3
"""Manage the VEIL patch series on top of tor-browser.

    veil_patches.py lint  PATCH_DIR
    veil_patches.py apply PATCH_DIR TOR_BROWSER_CHECKOUT
    veil_patches.py new   PATCH_DIR --tag TAG --subject "..."

The series file lists patches in apply order. Each patch is git
format-patch output whose commit message carries VEIL trailers (see README).
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

TAGS = {"branding", "chrome", "workspace", "update", "network", "fingerprint", "content"}
# Tags whose changes a website or the Tor network could observe, or that
# guard workspace isolation, need two independent reviewers.
TWO_REVIEWER_TAGS = {"network", "fingerprint", "content", "workspace"}

SUBJECT_RE = re.compile(r"^Subject: (?:\[PATCH[^\]]*\]\s*)?(.+)$", re.M)
TRAILER_RE = re.compile(r"^(VEIL-Tag|VEIL-Reason|Reviewed-by):[ \t]*(.*)$", re.M)
EMAIL_RE = re.compile(r"<([^<>@\s]+@[^<>\s]+)>")


@dataclass
class PatchInfo:
    path: Path
    subject: str = ""
    tag: str | None = None
    reason: str | None = None
    reviewers: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def read_series(patch_dir: Path) -> list[Path]:
    series = patch_dir / "series"
    if not series.is_file():
        raise FileNotFoundError(f"{series} not found")
    entries = []
    for raw in series.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            entries.append(patch_dir / line)
    return entries


def parse_patch(path: Path) -> PatchInfo:
    info = PatchInfo(path)
    text = path.read_text(errors="replace")
    header = text.split("\n---\n", 1)[0]  # commit message part only

    m = SUBJECT_RE.search(header)
    info.subject = m.group(1).strip() if m else ""
    if not info.subject:
        info.errors.append("missing Subject")

    tags, reasons = [], []
    for key, value in TRAILER_RE.findall(header):
        value = value.strip()
        if key == "VEIL-Tag":
            tags.append(value)
        elif key == "VEIL-Reason":
            reasons.append(value)
        else:
            info.reviewers.append(value)

    if len(tags) != 1:
        info.errors.append(f"needs exactly one VEIL-Tag trailer (found {len(tags)})")
    else:
        info.tag = tags[0]
        if info.tag not in TAGS:
            info.errors.append(f"unknown VEIL-Tag '{info.tag}' (allowed: {', '.join(sorted(TAGS))})")

    if len(reasons) != 1 or not reasons[0]:
        info.errors.append("needs exactly one non-empty VEIL-Reason trailer")
    else:
        info.reason = reasons[0]

    emails = []
    for r in info.reviewers:
        em = EMAIL_RE.search(r)
        if not em:
            info.errors.append(f"Reviewed-by without an email: '{r}'")
        else:
            emails.append(em.group(1).lower())
    distinct = set(emails)
    if len(distinct) != len(emails):
        info.errors.append("the same reviewer is listed more than once")
    needed = 2 if info.tag in TWO_REVIEWER_TAGS else 1
    if len(distinct) < needed:
        info.errors.append(f"tag '{info.tag}' needs {needed} distinct reviewer(s), found {len(distinct)}")

    if "\ndiff --git " not in text:
        info.errors.append("contains no diff")
    return info


def lint(patch_dir: Path) -> int:
    try:
        series = read_series(patch_dir)
    except FileNotFoundError as exc:
        print(f"lint: {exc}", file=sys.stderr)
        return 2

    failures = 0
    listed = set()
    for path in series:
        if path.name in listed:
            print(f"FAIL {path.name}: listed twice in series")
            failures += 1
            continue
        listed.add(path.name)
        if not path.is_file():
            print(f"FAIL {path.name}: listed in series but missing")
            failures += 1
            continue
        info = parse_patch(path)
        if info.errors:
            failures += 1
            for err in info.errors:
                print(f"FAIL {path.name}: {err}")
        else:
            print(f"ok   {path.name} [{info.tag}] {info.subject}")

    for stray in sorted(p.name for p in patch_dir.glob("*.patch")):
        if stray not in listed:
            print(f"FAIL {stray}: patch file not listed in series")
            failures += 1

    print(f"{len(series)} patch(es), {failures} failure(s)")
    return 1 if failures else 0


def apply(patch_dir: Path, checkout: Path) -> int:
    if lint(patch_dir) != 0:
        print("apply: refusing to apply a series that fails lint", file=sys.stderr)
        return 1
    for path in read_series(patch_dir):
        print(f"==> git am {path.name}")
        result = subprocess.run(
            ["git", "-C", str(checkout), "am", "--3way", "--keep-cr", str(path.resolve())])
        if result.returncode != 0:
            subprocess.run(["git", "-C", str(checkout), "am", "--abort"])
            print(f"apply: {path.name} did not apply; rebase it onto the new upstream", file=sys.stderr)
            return 1
    return 0


def new(patch_dir: Path, tag: str, subject: str) -> int:
    if tag not in TAGS:
        print(f"new: unknown tag '{tag}'", file=sys.stderr)
        return 2
    series = read_series(patch_dir) if (patch_dir / "series").exists() else []
    number = len(series) + 1
    slug = re.sub(r"[^a-z0-9]+", "-", subject.lower()).strip("-")[:48]
    path = patch_dir / f"{number:04d}-{slug}.patch"
    reviewers = "Reviewed-by: FIRST REVIEWER <first@example.invalid>\n"
    if tag in TWO_REVIEWER_TAGS:
        reviewers += "Reviewed-by: SECOND REVIEWER <second@example.invalid>\n"
    path.write_text(
        "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\n"
        "From: AUTHOR <author@example.invalid>\n"
        f"Subject: [PATCH] {subject}\n\n"
        "Describe the change.\n\n"
        f"VEIL-Tag: {tag}\n"
        "VEIL-Reason: REPLACE with one line on why this is needed\n"
        f"{reviewers}"
        "---\n"
        "Replace this template with `git format-patch` output for the commit.\n")
    with (patch_dir / "series").open("a") as fh:
        fh.write(path.name + "\n")
    print(f"created {path} (template: replace with real format-patch output)")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Manage the VEIL patch series")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("lint"); p.add_argument("patch_dir", type=Path)
    p = sub.add_parser("apply"); p.add_argument("patch_dir", type=Path); p.add_argument("checkout", type=Path)
    p = sub.add_parser("new"); p.add_argument("patch_dir", type=Path)
    p.add_argument("--tag", required=True); p.add_argument("--subject", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "lint":
        return lint(args.patch_dir)
    if args.cmd == "apply":
        return apply(args.patch_dir, args.checkout)
    return new(args.patch_dir, args.tag, args.subject)


if __name__ == "__main__":
    sys.exit(main())
