"""Checks on the Tor Browser glue code (veil-browser/src/glue).

It can't run outside Tor Browser, so these tests check that it parses and
that its security rules are present and agree with the start page.
"""
import re
import shutil
import subprocess

import pytest

GLUE = ("veil-browser", "src", "glue")


def glue(root, name):
    return (root.joinpath(*GLUE) / name).read_text()


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_glue_modules_parse(root):
    for f in root.joinpath(*GLUE).glob("*.sys.mjs"):
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        assert r.returncode == 0, f"{f.name}: {r.stderr}"


def test_bridge_allow_list_matches_start_page(root):
    bridge = (root / "veil-chrome" / "src" / "shared" / "bridge.js").read_text()
    out = set(re.findall(r'"(VEIL:\w+)"', re.search(r"OUTGOING = new Set\(\[(.*?)\]\)", bridge, re.S).group(1)))
    inc = set(re.findall(r'"(VEIL:\w+)"', re.search(r"INCOMING = new Set\(\[(.*?)\]\)", bridge, re.S).group(1)))
    notes = glue(root, "PATCH-NOTES.md")
    m = re.search(r'RPMSendAsyncMessage: \[(.*?)\], RPMAddMessageListener: \[(.*?)\]', notes)
    assert set(re.findall(r'"(VEIL:\w+)"', m.group(1))) == out
    assert set(re.findall(r'"(VEIL:\w+)"', m.group(2))) == inc
    parent = glue(root, "AboutVeilHomeParent.sys.mjs")
    for name in out:
        assert f'"{name}"' in parent, f"parent actor doesn't handle {name}"


def test_app_panel_uses_only_the_id_from_the_page(root):
    parent = glue(root, "AboutVeilHomeParent.sys.mjs")
    assert "data: { id: data?.id }" in parent


def test_address_bar_commands_shut_out_other_providers(root):
    p = glue(root, "VeilUrlbarProvider.sys.mjs")
    assert "PROVIDER_TYPE.HEURISTIC" in p
    assert re.search(r"getPriority\(queryContext\) \{\s*return this\.isActive\(queryContext\) \? PRIORITY : 0;", p)


def test_side_panel_keeps_no_history_and_no_referrer(root):
    p = glue(root, "VeilSidePanel.sys.mjs")
    assert 'disableglobalhistory: "true"' in p
    assert 'remote: "true"' in p
    assert "referrerInfo: null" in p


def test_sign_in_redirect_is_cancelled_before_it_is_sent(root):
    p = glue(root, "VeilBrowser.sys.mjs")
    assert '"http-on-modify-request"' in p
    assert "channel.cancel(Cr.NS_BINDING_ABORTED)" in p
    assert "VeilAnonymityGuard.init()" in p
