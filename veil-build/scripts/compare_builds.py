#!/usr/bin/env python3
"""Compare the outputs of two independent VEIL builders.

Gate 1 of Phase I: two builders must produce byte-identical artifacts.
Each builder publishes a sha256sums.txt (as written by build.sh) and its
pin.lock. This tool checks both pins match, then compares every artifact.

    compare_builds.py BUILDER_A_DIR BUILDER_B_DIR [--json]

Exit status: 0 identical, 1 mismatch, 2 bad input.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def read_sums(path: Path) -> dict[str, str]:
    sums: dict[str, str] = {}
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or len(parts[0]) != 64:
            raise ValueError(f"{path}:{lineno}: not a sha256sum line")
        digest, name = parts
        name = name.lstrip("*")
        if name in sums:
            raise ValueError(f"{path}:{lineno}: duplicate entry {name}")
        sums[name] = digest.lower()
    return sums


def read_pin(path: Path) -> dict[str, str]:
    pin: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            pin[k.strip()] = v.strip()
    return pin


def compare(a: Path, b: Path) -> dict:
    report: dict = {"identical": False, "pin_mismatch": {}, "only_a": [],
                    "only_b": [], "differ": [], "matched": 0}

    pin_a, pin_b = read_pin(a / "pin.lock"), read_pin(b / "pin.lock")
    for key in sorted(set(pin_a) | set(pin_b)):
        if pin_a.get(key) != pin_b.get(key):
            report["pin_mismatch"][key] = [pin_a.get(key), pin_b.get(key)]

    sums_a, sums_b = read_sums(a / "sha256sums.txt"), read_sums(b / "sha256sums.txt")
    report["only_a"] = sorted(set(sums_a) - set(sums_b))
    report["only_b"] = sorted(set(sums_b) - set(sums_a))
    for name in sorted(set(sums_a) & set(sums_b)):
        if sums_a[name] == sums_b[name]:
            report["matched"] += 1
        else:
            report["differ"].append(name)

    report["identical"] = (not report["pin_mismatch"] and not report["only_a"]
                           and not report["only_b"] and not report["differ"]
                           and report["matched"] > 0)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("builder_a", type=Path)
    ap.add_argument("builder_b", type=Path)
    ap.add_argument("--json", action="store_true", help="print a JSON report")
    args = ap.parse_args(argv)

    try:
        report = compare(args.builder_a, args.builder_b)
    except (OSError, ValueError) as exc:
        print(f"compare_builds: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for key, (va, vb) in report["pin_mismatch"].items():
            print(f"PIN MISMATCH {key}: {va} != {vb}")
        for n in report["only_a"]:
            print(f"ONLY IN A    {n}")
        for n in report["only_b"]:
            print(f"ONLY IN B    {n}")
        for n in report["differ"]:
            print(f"DIFFERS      {n}")
        verdict = "REPRODUCIBLE" if report["identical"] else "NOT REPRODUCIBLE"
        print(f"{verdict}: {report['matched']} artifact(s) matched")
    return 0 if report["identical"] else 1


if __name__ == "__main__":
    sys.exit(main())
