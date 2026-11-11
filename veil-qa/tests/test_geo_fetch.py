"""The geo fetch lock, the offline loader policy, and the settings switch."""
import json
import subprocess
from pathlib import Path

import pytest

import fetch_geo

GEOIP_SHA = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2"
GEOSITE_SHA = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2"
PRODUCT_DIRS = (
    "veil-browser/src",
    "veil-browser/tools",
    "veil-prototype",
    "veil-chrome/src",
    "apps",
    "cumulus-id",
    "infinitum-common",
)
ROUTE_TOKENS = ("network.proxy", "failover_direct", "dns.lookup", "node:dns", "outboundTag", "socks_remote_dns")


def test_lockfile_pins_the_v2fly_releases(root):
    lock = json.loads((root / "veil-browser/data/geo/geo-lock.json").read_text())
    assert lock["cache_dir"] == "veil-browser/data/geo/cache"
    geoip, geosite = lock["datasets"]
    assert geoip["project"] == "v2fly/geoip"
    assert geoip["license"] == "CC-BY-SA-4.0"
    assert geoip["tag"] == "202611080027"
    assert geoip["asset"] == "geoip.dat"
    assert geoip["filename"] == "geoip.dat"
    assert geoip["sha256"] == GEOIP_SHA
    assert geoip["url"].endswith("/v2fly/geoip/releases/download/202611080027/geoip.dat")
    assert geoip["sha256sum_url"].endswith("geoip.dat.sha256sum")
    assert geosite["project"] == "v2fly/domain-list-community"
    assert geosite["license"] == "MIT"
    assert geosite["tag"] == "20261108011013"
    assert geosite["asset"] == "dlc.dat"
    assert geosite["filename"] == "geosite.dat"
    assert geosite["sha256"] == GEOSITE_SHA
    assert geosite["url"].endswith("/dlc.dat")
    blob = json.dumps(lock).lower()
    for banned in ("loyalsoldier", "sing-box", "singbox", "sagernet"):
        assert banned not in blob


def test_cache_dir_is_gitignored(root):
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "veil-browser/data/geo/cache/geoip.dat"],
        cwd=root, capture_output=True)
    assert ignored.returncode == 0
    ignored_site = subprocess.run(
        ["git", "check-ignore", "-q", "veil-browser/data/geo/cache/geosite.dat"],
        cwd=root, capture_output=True)
    assert ignored_site.returncode == 0
    assert fetch_geo.DEFAULT_CACHE == root / "veil-browser/data/geo/cache"


def test_official_checksum_must_match_the_lock_and_the_bytes():
    dataset = fetch_geo.load_lock(fetch_geo.DEFAULT_LOCK)["datasets"][0]
    payload = b"not the real geoip file"
    official = f"{GEOIP_SHA}  geoip.dat\n"
    with pytest.raises(fetch_geo.VerifyError, match="verification failed"):
        fetch_geo.verify_bytes(payload, official, dataset)
    real = __import__("hashlib").sha256(payload).hexdigest()
    forged = dict(dataset, sha256=real)
    with pytest.raises(fetch_geo.VerifyError, match="official"):
        fetch_geo.verify_bytes(payload, official, forged)


def test_mismatch_writes_nothing(tmp_path):
    lock = fetch_geo.load_lock(fetch_geo.DEFAULT_LOCK)
    sentinel = tmp_path / "geoip.dat"
    sentinel.write_bytes(b"already here")

    def read_url(url):
        if url.endswith(".sha256sum"):
            asset = "geoip.dat" if "geoip" in url else "dlc.dat"
            digest = GEOIP_SHA if asset == "geoip.dat" else GEOSITE_SHA
            return f"{digest}  {asset}\n".encode()
        return b"wrong bytes"

    with pytest.raises(fetch_geo.VerifyError, match="verification failed"):
        fetch_geo.install(lock, tmp_path, read_url)
    assert sentinel.read_bytes() == b"already here"
    assert not (tmp_path / "geosite.dat").exists()
    assert list(tmp_path.glob(".*.partial")) == []


def test_matching_bytes_are_published_under_the_cache_names(tmp_path):
    lock = fetch_geo.load_lock(fetch_geo.DEFAULT_LOCK)
    wrong = {"geoip.dat": b"geoip-bytes", "dlc.dat": b"geosite-bytes"}

    def read_wrong(url):
        name = url.rsplit("/", 1)[-1]
        if name.endswith(".sha256sum"):
            asset = name[: -len(".sha256sum")]
            digest = __import__("hashlib").sha256(wrong[asset]).hexdigest()
            return f"{digest}  {asset}\n".encode()
        return wrong[name]

    # The lockfile pins the real hashes, so a stand-in file must fail closed.
    with pytest.raises(fetch_geo.VerifyError):
        fetch_geo.install(lock, tmp_path, read_wrong)
    assert list(tmp_path.iterdir()) == []

    local = json.loads(json.dumps(lock))
    tiny = {"geoip.dat": b"g", "dlc.dat": b"s"}
    for ds, asset in ((local["datasets"][0], "geoip.dat"), (local["datasets"][1], "dlc.dat")):
        ds["sha256"] = __import__("hashlib").sha256(tiny[asset]).hexdigest()

    def read_tiny(url):
        name = url.rsplit("/", 1)[-1]
        if name.endswith(".sha256sum"):
            asset = name[: -len(".sha256sum")]
            digest = local["datasets"][0 if asset == "geoip.dat" else 1]["sha256"]
            return f"{digest}  {asset}\n".encode()
        return tiny[name]

    written = fetch_geo.install(local, tmp_path, read_tiny)
    assert [p.name for p in written] == ["geoip.dat", "geosite.dat"]
    assert (tmp_path / "geoip.dat").read_bytes() == b"g"
    assert (tmp_path / "geosite.dat").read_bytes() == b"s"


def test_forbidden_sources_and_hosts_are_refused():
    lock = fetch_geo.load_lock(fetch_geo.DEFAULT_LOCK)
    bad = json.loads(json.dumps(lock))
    bad["datasets"][0]["url"] = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat"
    with pytest.raises(fetch_geo.VerifyError, match="loyalsoldier"):
        fetch_geo.check_dataset(bad["datasets"][0])
    bad = json.loads(json.dumps(lock))
    bad["datasets"][0]["url"] = "https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat"
    with pytest.raises(fetch_geo.VerifyError, match="sing-box|sagernet"):
        fetch_geo.check_dataset(bad["datasets"][0])
    bad = json.loads(json.dumps(lock))
    bad["datasets"][0]["url"] = "https://example.com/v2fly/geoip/releases/download/x/geoip.dat"
    with pytest.raises(fetch_geo.VerifyError, match="github.com"):
        fetch_geo.check_dataset(bad["datasets"][0])
    with pytest.raises(fetch_geo.VerifyError, match="host"):
        fetch_geo.http_read("http://github.com/v2fly/geoip/releases/download/x/geoip.dat")


def test_notices_attribute_both_datasets(root):
    text = (root / "THIRD_PARTY_NOTICES").read_text()
    for needle in (
        "v2fly/geoip", "v2fly/domain-list-community", GEOIP_SHA, GEOSITE_SHA,
        "CC-BY-SA-4.0", "CC-BY-4.0", "MIT License", "Copyright (c) 2018-2019 V2Ray",
        "DB-IP", "dlc.dat", "category-ads",
    ):
        assert needle in text, needle
    low = text.lower()
    assert "github.com/loyalsoldier" not in low
    assert "github.com/sagernet" not in low
    assert "sing-box" in low  # named only as a source this tree does not use


def test_settings_switch_is_off_and_local(root):
    page = (root / "veil-prototype/static/index.html").read_text()
    assert 'id="geosite-extra"' in page
    assert "Block extra ad and tracker domains" in page
    start = page.index('id="geosite-extra"')
    tag = page[page.rfind("<input", 0, start):page.find(">", start) + 1]
    assert "checked" not in tag
    shell = (root / "veil-prototype/static/shell.js").read_text()
    assert "readExtraBlocking(localStorage)" in shell
    assert "if (navigationBlocked(url)) return;" in shell
    assert "fetch(LOCAL_GEOSITE_PATH)" in shell
    assert "github.com" not in shell
    assert "dns.lookup" not in shell
    server = (root / "veil-prototype/server.mjs").read_text()
    assert "geoip.dat" in server and "geosite.dat" in server
    assert "https://github.com" not in server


def test_product_code_does_not_route_on_geo_data(root):
    offenders = []
    for rel in PRODUCT_DIRS:
        base = root / rel
        for path in base.rglob("*"):
            if path.suffix not in {".mjs", ".js", ".py"} or not path.is_file():
                continue
            text = path.read_text(errors="replace")
            if not any(mark in text for mark in ("VeilGeoData", "geoip.dat", "geosite.dat", "parseGeoSite")):
                continue
            # The fetch script is the maintainer downloader. It must not describe a route.
            if path.name == "fetch_geo.py":
                assert "network.proxy" not in text
                assert "dns.lookup" not in text
                continue
            for token in ROUTE_TOKENS:
                if token in text:
                    offenders.append(f"{path.relative_to(root)} contains {token}")
    assert offenders == []
