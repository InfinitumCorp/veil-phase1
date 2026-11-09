// Local geo lists: annotation and optional ad blocking, with no route and no lookup.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const geo = await import(path.join(here, "../../../veil-browser/src/VeilGeoData.sys.mjs"));
const guard = await import(path.join(here, "../../../veil-browser/src/VeilAnonymityGuard.sys.mjs"));

const {
  decide, parseGeoSite, parseGeoIp, extraBlockingEnabled, readExtraBlocking,
  EXTRA_BLOCK_CATEGORIES, EXTRA_BLOCKING_DEFAULT, SETTING_KEY, GeoDataError,
} = geo;

// Independent of the product parser: one GeoIPList and one GeoSiteList.
const GEOIP_US = Uint8Array.from(Buffer.from("0a0e0a02555312080a04010203001018", "hex"));
const GEOSITE_ADS = Uint8Array.from(Buffer.from(
  "0a1f0a0c63617465676f72792d616473120f0802120b6164732e6578616d706c65", "hex"));

function varint(n) {
  const out = [];
  let value = n;
  while (true) {
    let byte = value & 0x7f;
    value >>= 7;
    if (value) out.push(byte | 0x80);
    else { out.push(byte); return Uint8Array.from(out); }
  }
}
function field(number, wire, payload) {
  const key = varint((number << 3) | wire);
  return Buffer.concat([key, payload]);
}
function lengthDelimited(number, payload) {
  const body = Buffer.from(payload);
  return field(number, 2, Buffer.concat([varint(body.length), body]));
}
function domain(type, value) {
  return Buffer.concat([field(1, 0, varint(type)), lengthDelimited(2, Buffer.from(value))]);
}
function siteList(entries) {
  return Buffer.concat(entries.map(([name, type, value]) =>
    lengthDelimited(1, Buffer.concat([lengthDelimited(1, Buffer.from(name)), lengthDelimited(2, domain(type, value))]))));
}

test("the extra blocking setting defaults off", () => {
  assert.equal(EXTRA_BLOCKING_DEFAULT, false);
  assert.equal(SETTING_KEY, "veil.geosite.extraBlocking");
  for (const value of [undefined, null, false, 0, "", "0", "true", "on", "yes"]) {
    assert.equal(extraBlockingEnabled(value), false, String(value));
  }
  assert.equal(extraBlockingEnabled(true), true);
  assert.equal(extraBlockingEnabled("1"), true);
  assert.equal(readExtraBlocking(undefined), false);
  assert.equal(readExtraBlocking({ getItem: () => null }), false);
  assert.equal(readExtraBlocking({ getItem: () => "0" }), false);
  assert.equal(readExtraBlocking({ getItem: () => { throw new Error("blocked"); } }), false);
  assert.equal(readExtraBlocking({ getItem: () => "1" }), true);
});

test("extra categories are only the ad and tracker lists", () => {
  assert.deepEqual([...EXTRA_BLOCK_CATEGORIES], [
    "category-ads", "category-ads-all", "category-ads-and-telemetry",
  ]);
  for (const name of EXTRA_BLOCK_CATEGORIES) {
    assert.equal(/geo(location)?-|direct|^cn$|private/i.test(name), false, name);
  }
});

test("published list names are folded to lower case", () => {
  const geosite = parseGeoSite(siteList([
    ["CATEGORY-ADS", 3, "Ads.Example"],
    ["CN", 2, "example.cn"],
  ]));
  assert.equal(geosite.lists.has("category-ads"), true);
  assert.equal(decide({ hostname: "ads.example", geosite, extraBlocking: true }).block, true);
  const kept = parseGeoSite(siteList([
    ["CATEGORY-ADS", 3, "ads.example"],
    ["CN", 2, "example.cn"],
  ]), { keep: EXTRA_BLOCK_CATEGORIES });
  assert.deepEqual([...kept.lists.keys()], ["category-ads"]);
});

test("hardcoded geosite fixture blocks only while the setting is on", () => {
  const geosite = parseGeoSite(GEOSITE_ADS);
  assert.equal(geosite.lists.get("category-ads")[0].value, "ads.example");
  const off = decide({ hostname: "ads.example", geosite, extraBlocking: false });
  assert.deepEqual(off, { block: false, category: null, tags: [] });
  const on = decide({ hostname: "a.ads.example", geosite, extraBlocking: true });
  assert.equal(on.block, true);
  assert.equal(on.category, "category-ads");
  assert.deepEqual(on.tags, ["geosite:category-ads"]);
  assert.deepEqual(Object.keys(on).sort(), ["block", "category", "tags"]);
});

test("the setting off does not consult the lists", () => {
  const geosite = new Proxy({}, { get() { throw new Error("lists were read while off"); } });
  const geoip = new Proxy({}, { get() { throw new Error("geoip was read while off"); } });
  const decision = decide({ hostname: "ads.example", ip: "1.2.3.4", geosite, geoip, extraBlocking: "0" });
  assert.equal(decision.block, false);
  assert.deepEqual(decision.tags, []);
});

test("a country list is annotation only and never a block", () => {
  const bytes = siteList([
    ["category-ads-all", 3, "tracker.test"],
    ["geolocation-cn", 2, "example.cn"],
    ["direct", 2, "leave.example"],
  ]);
  const geosite = parseGeoSite(bytes);
  assert.equal(geosite.lists.has("direct"), false);
  const country = decide({ hostname: "www.example.cn", geosite, extraBlocking: true });
  assert.equal(country.block, false);
  assert.equal(country.category, null);
  assert.deepEqual(country.tags, ["geosite:geolocation-cn"]);
  const tracker = decide({ hostname: "tracker.test", geosite, extraBlocking: true });
  assert.equal(tracker.block, true);
  assert.equal(tracker.category, "category-ads-all");
  const kept = parseGeoSite(bytes, { keep: EXTRA_BLOCK_CATEGORIES });
  assert.deepEqual([...kept.lists.keys()], ["category-ads-all"]);
});

test("domain suffix match does not treat a lookalike as the same site", () => {
  const geosite = parseGeoSite(siteList([["category-ads", 2, "ads.example"]]));
  assert.equal(decide({ hostname: "notads.example", geosite, extraBlocking: true }).block, false);
  assert.equal(decide({ hostname: "ADS.EXAMPLE.", geosite, extraBlocking: true }).block, true);
});

test("plain, full, and regex rules stay local matches", () => {
  const geosite = parseGeoSite(siteList([
    ["category-ads", 0, "doubleclick"],
    ["category-ads-all", 1, "^tracker\\.test$"],
  ]));
  assert.equal(decide({ hostname: "ads.doubleclick.net", geosite, extraBlocking: true }).category, "category-ads");
  assert.equal(decide({ hostname: "tracker.test", geosite, extraBlocking: true }).category, "category-ads-all");
  assert.equal(decide({ hostname: "tracker.test.extra", geosite, extraBlocking: true }).block, false);
});

test("geoip tags an IP literal and does not tag a name", () => {
  const geoip = parseGeoIp(GEOIP_US);
  const tagged = decide({ ip: "1.2.3.9", geoip, extraBlocking: true });
  assert.equal(tagged.block, false);
  assert.deepEqual(tagged.tags, ["geoip:us"]);
  assert.equal(JSON.stringify(tagged).includes("proxy"), false);
  const named = decide({ hostname: "ads.example", geoip, extraBlocking: true });
  assert.deepEqual(named.tags, []);
  const outside = decide({ ip: "9.9.9.9", geoip, extraBlocking: true });
  assert.deepEqual(outside.tags, []);
  const v6 = parseGeoIp(Buffer.concat([
    lengthDelimited(1, Buffer.concat([
      lengthDelimited(1, Buffer.from("US")),
      lengthDelimited(2, Buffer.concat([
        lengthDelimited(1, Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
        field(2, 0, varint(32)),
      ])),
    ])),
  ]));
  assert.deepEqual(decide({ ip: "2001:db8::1", geoip: v6, extraBlocking: true }).tags, ["geoip:us"]);
});

test("an inverse geoip entry is still only a tag", () => {
  const entry = Buffer.concat([
    lengthDelimited(1, Buffer.from("US")),
    lengthDelimited(2, Buffer.concat([
      lengthDelimited(1, Buffer.from([1, 2, 3, 0])),
      field(2, 0, varint(24)),
    ])),
    field(3, 0, varint(1)),
  ]);
  const geoip = parseGeoIp(lengthDelimited(1, entry));
  assert.deepEqual(decide({ ip: "9.9.9.9", geoip, extraBlocking: true }).tags, ["geoip:us"]);
  assert.equal(decide({ ip: "1.2.3.4", geoip, extraBlocking: true }).block, false);
  assert.deepEqual(decide({ ip: "1.2.3.4", geoip, extraBlocking: true }).tags, []);
});

test("decide is synchronous and its result has no route fields", () => {
  const decision = decide({ hostname: "ads.example", extraBlocking: true });
  assert.equal(decision instanceof Promise, false);
  assert.deepEqual(Object.keys(decision).sort(), ["block", "category", "tags"]);
  const encoded = JSON.stringify(decision);
  for (const token of ["DIRECT", "proxy", "socks", "dns", "route"]) {
    assert.equal(encoded.toLowerCase().includes(token), false, token);
  }
});

test("using the lists does not change the anonymity guard", () => {
  const before = guard.RULES.map(rule => ({ pref: rule.pref, why: rule.why }));
  const prefs = {
    "network.proxy.type": 1,
    "network.proxy.socks": "127.0.0.1",
    "network.proxy.socks_version": 5,
    "network.proxy.socks_remote_dns": true,
    "network.proxy.failover_direct": false,
  };
  const geosite = parseGeoSite(GEOSITE_ADS);
  const geoip = parseGeoIp(GEOIP_US);
  decide({ hostname: "ads.example", ip: "1.2.3.4", geosite, geoip, extraBlocking: true });
  decide({ hostname: "ads.example", geosite, geoip, extraBlocking: false });
  assert.deepEqual(guard.RULES.map(rule => ({ pref: rule.pref, why: rule.why })), before);
  assert.equal(guard.RULES.some(rule => rule.pref === "network.proxy.failover_direct"), true);
  assert.equal(guard.RULES.some(rule => rule.pref === "network.proxy.socks_remote_dns"), true);
  assert.deepEqual(guard.assess(name => prefs[name]).map(problem => problem.pref).includes("network.proxy.type"), false);
  assert.equal(prefs["network.proxy.failover_direct"], false);
  assert.equal(prefs["network.proxy.socks_remote_dns"], true);
  assert.equal(prefs["network.proxy.type"], 1);
});

test("the module source has no lookup and no route of its own", () => {
  const source = readFileSync(path.join(here, "../../../veil-browser/src/VeilGeoData.sys.mjs"), "utf8");
  for (const token of [
    "node:dns", "node:net", "node:http", "dns.lookup", "fetch(", "XMLHttpRequest",
    "WebSocket", "network.proxy", "failover_direct", "outboundTag", "\"DIRECT\"", "'DIRECT'",
    "socks", "urlopen", "github.com",
  ]) {
    assert.equal(source.includes(token), false, token);
  }
});

const fetchedGeosite = path.join(here, "../../../veil-browser/data/geo/cache/geosite.dat");
test("a fetched geosite cache keeps only the ad categories", { skip: !existsSync(fetchedGeosite) }, () => {
  const site = parseGeoSite(readFileSync(fetchedGeosite), { keep: EXTRA_BLOCK_CATEGORIES });
  for (const name of EXTRA_BLOCK_CATEGORIES) {
    assert.ok(site.lists.get(name)?.length > 0, name);
  }
  assert.deepEqual([...site.lists.keys()].sort(), [...EXTRA_BLOCK_CATEGORIES].sort());
  const rule = site.lists.get("category-ads").find(item => item.type === 2 || item.type === 3);
  assert.ok(rule);
  const on = decide({ hostname: rule.value, geosite: site, extraBlocking: true });
  assert.equal(on.block, true);
  assert.equal(on.category, "category-ads");
  assert.equal(decide({ hostname: rule.value, geosite: site, extraBlocking: false }).block, false);
  const encoded = JSON.stringify(on);
  for (const token of ["DIRECT", "proxy", "dns", "route"]) {
    assert.equal(encoded.toLowerCase().includes(token), false, token);
  }
});

test("a truncated list is rejected and does not become a block", () => {
  assert.throws(() => parseGeoSite(Uint8Array.from([0x0a, 0x0f])), GeoDataError);
  assert.equal(decide({ hostname: "ads.example", geosite: { lists: new Map() }, extraBlocking: true }).block, false);
});
