// Tests for the VEIL anonymity guard, run with `node --test` (called from
// pytest by test_anonymity_guard.py). They use fake prefs and network
// objects, so no browser build is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, "../../../veil-browser/src/VeilAnonymityGuard.sys.mjs"));
const { assess, Guard, RULES, BLOCKED_TOPIC, RESTORED_TOPIC } = mod;

// Stock Tor Browser-style safe settings (SOCKS path is whatever Tor
// Browser chose; the guard only requires it to be set).
const SAFE = {
  "network.proxy.type": 1,
  "network.proxy.socks": "file:///run/user/1000/tor/socks.socket",
  "network.proxy.socks_version": 5,
  "network.proxy.socks_remote_dns": true,
  "network.proxy.failover_direct": false,
  "network.proxy.no_proxies_on": "",
  "network.trr.mode": 5,
};

function fakeBrowser(initial = SAFE) {
  const values = { ...initial };
  const watchers = [];
  const offlineWatchers = [];
  const events = [];
  const io = {
    _offline: false,
    manageOfflineStatus: true,
    get offline() { return this._offline; },
    set offline(v) { this._offline = v; offlineWatchers.forEach(fn => fn()); },
    onOfflineChange(fn) { offlineWatchers.push(fn); },
  };
  const prefs = {
    read: name => values[name],
    watch: (branch, fn) => watchers.push({ branch, fn }),
  };
  const set = (name, value) => {
    if (value === undefined) delete values[name]; else values[name] = value;
    watchers.filter(w => name.startsWith(w.branch)).forEach(w => w.fn());
  };
  const guard = new Guard({ prefs, io, notify: (topic, problems) => events.push({ topic, problems }) });
  return { guard, io, set, events };
}

test("stock Tor Browser settings are safe", () => {
  assert.deepEqual(assess(n => SAFE[n]), []);
});

test("Unix socket and TCP SOCKS paths are both accepted", () => {
  assert.deepEqual(assess(n => ({ ...SAFE, "network.proxy.socks": "127.0.0.1" })[n]), []);
});

for (const [pref, bad] of [
  ["network.proxy.type", 0],            // no proxy: direct connections
  ["network.proxy.type", 4],            // auto-detect
  ["network.proxy.socks", ""],
  ["network.proxy.socks_version", 4],   // SOCKS4 resolves DNS locally
  ["network.proxy.socks_remote_dns", false],
  ["network.proxy.failover_direct", true],
  ["network.proxy.http", "10.0.0.1"],
  ["network.proxy.ssl", "10.0.0.1"],
  ["network.proxy.no_proxies_on", "example.com"],
  ["network.trr.mode", 2],              // DoH with fallback
  ["network.trr.mode", 3],              // DoH only
]) {
  test(`${pref} = ${JSON.stringify(bad)} is unsafe`, () => {
    const problems = assess(n => ({ ...SAFE, [pref]: bad })[n]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].pref, pref);
  });
}

test("missing proxy settings are unsafe (fail closed)", () => {
  const problems = assess(() => undefined);
  const prefs = problems.map(p => p.pref);
  for (const p of ["network.proxy.type", "network.proxy.socks", "network.proxy.socks_version",
                   "network.proxy.socks_remote_dns"]) {
    assert.ok(prefs.includes(p), p);
  }
});

test("a pref that throws when read is treated as unsafe", () => {
  const problems = assess(n => { if (n === "network.proxy.type") throw new Error("boom"); return SAFE[n]; });
  assert.deepEqual(problems.map(p => p.pref), ["network.proxy.type"]);
});

test("every rule explains itself", () => {
  for (const r of RULES) assert.ok(r.why.length > 10, r.pref);
});

test("safe at startup: stays online, no notice", () => {
  const b = fakeBrowser();
  b.guard.start();
  assert.equal(b.io.offline, false);
  assert.equal(b.events.length, 0);
});

test("unsafe at startup: goes offline before any page loads", () => {
  const b = fakeBrowser({ ...SAFE, "network.proxy.type": 0 });
  b.guard.start();
  assert.equal(b.io.offline, true);
  assert.equal(b.io.manageOfflineStatus, false);
  assert.equal(b.events[0].topic, BLOCKED_TOPIC);
});

test("turning Tor off while browsing takes VEIL offline at once", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("network.proxy.type", 0);
  assert.equal(b.io.offline, true);
  assert.equal(b.events.at(-1).topic, BLOCKED_TOPIC);
});

test("going back online while unsafe is undone", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("network.proxy.socks_remote_dns", false);
  b.io.offline = false;           // e.g. the user clicks "Work online"
  assert.equal(b.io.offline, true);
});

test("restoring safe settings brings VEIL back online and restores auto-detect", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("network.proxy.failover_direct", true);
  assert.equal(b.io.offline, true);
  b.set("network.proxy.failover_direct", false);
  assert.equal(b.io.offline, false);
  assert.equal(b.io.manageOfflineStatus, true);
  assert.equal(b.events.at(-1).topic, RESTORED_TOPIC);
});

test("several bad changes in a row send one blocked notice", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("network.proxy.type", 0);
  b.set("network.proxy.socks", "");
  assert.equal(b.events.filter(e => e.topic === BLOCKED_TOPIC).length, 1);
  assert.equal(b.guard.problems.length, 2);
});

test("fixing only one of two problems keeps VEIL offline", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("network.proxy.type", 0);
  b.set("network.proxy.socks", "");
  b.set("network.proxy.type", 1);
  assert.equal(b.io.offline, true);
  b.set("network.proxy.socks", "127.0.0.1");
  assert.equal(b.io.offline, false);
});

test("changes outside the network branches are ignored", () => {
  const b = fakeBrowser();
  b.guard.start();
  b.set("browser.startup.homepage", "about:blank");
  assert.equal(b.io.offline, false);
  assert.equal(b.events.length, 0);
});
