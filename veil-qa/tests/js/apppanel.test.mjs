// Tests for the VEIL app side panel (browser side), run with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { AppPanel, AppPanelError, appEntry, clampWidth, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH } =
  await import(path.join(here, "../../../veil-browser/src/VeilAppPanel.sys.mjs"));

const REGISTRY = {
  apps: [
    { id: "cndctr", name: "/CNDCTR/™", url: "https://apps.example/cndctr" },
    { id: "scalvs", name: "SCALVS.ai™", url: "https://apps.example/scalus" },
    { id: "bad", name: "Bad", url: "http://apps.example/bad" },
    { id: "creds", name: "Creds", url: "https://u:p@apps.example/" },
  ],
};

function fakePanel() {
  const calls = [];
  return {
    calls,
    show: arg => calls.push(["show", arg]),
    hide: () => calls.push(["hide"]),
    setWidth: px => calls.push(["width", px]),
  };
}

test("clicking an app opens it in the panel at the default width", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  p.handle({ name: "VEIL:OpenAppPanel", data: { id: "scalvs" } });
  assert.deepEqual(panel.calls, [
    ["width", DEFAULT_WIDTH],
    ["show", { url: "https://apps.example/scalus", title: "SCALVS.ai™" }],
  ]);
  assert.equal(p.openId, "scalvs");
});

test("clicking the same app again closes the panel", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  p.toggle("cndctr");
  p.toggle("cndctr");
  assert.deepEqual(panel.calls.at(-1), ["hide"]);
  assert.equal(p.openId, null);
});

test("clicking the other app switches the panel without resizing it", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  p.toggle("cndctr");
  p.toggle("scalvs");
  assert.deepEqual(panel.calls.map(c => c[0]), ["width", "show", "show"]);
  assert.equal(p.openId, "scalvs");
});

test("the address always comes from the registry, never the page", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  p.handle({ name: "VEIL:OpenAppPanel", data: { id: "scalvs", url: "https://evil.example/" } });
  assert.equal(panel.calls.at(-1)[1].url, "https://apps.example/scalus");
});

for (const [label, id] of [["unknown", "nope"], ["http", "bad"], ["credentialed", "creds"]]) {
  test(`refuses an ${label} app and leaves the panel alone`, () => {
    const panel = fakePanel();
    const p = new AppPanel({ registry: REGISTRY, panel });
    assert.throws(() => p.toggle(id), AppPanelError);
    assert.deepEqual(panel.calls, []);
  });
}

test("a message without an app id is refused", () => {
  const p = new AppPanel({ registry: REGISTRY, panel: fakePanel() });
  assert.throws(() => p.handle({ name: "VEIL:OpenAppPanel", data: {} }), AppPanelError);
  assert.equal(p.handle({ name: "VEIL:Other" }), null);
});

test("resizing is kept within bounds and applied while open", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  assert.equal(p.resize(100), MIN_WIDTH);
  assert.equal(panel.calls.length, 0);            // closed: remembered only
  p.toggle("cndctr");
  assert.deepEqual(panel.calls[0], ["width", MIN_WIDTH]);
  assert.equal(p.resize(5000), MAX_WIDTH);
  assert.deepEqual(panel.calls.at(-1), ["width", MAX_WIDTH]);
  assert.equal(clampWidth(NaN), DEFAULT_WIDTH);
});

test("New Identity closes the panel", () => {
  const panel = fakePanel();
  const p = new AppPanel({ registry: REGISTRY, panel });
  p.toggle("scalvs");
  p.onNewIdentity();
  assert.deepEqual(panel.calls.at(-1), ["hide"]);
  p.onNewIdentity();                              // already closed: no extra hide
  assert.equal(panel.calls.filter(c => c[0] === "hide").length, 1);
});

test("appEntry reports the app's display name as the panel title", () => {
  assert.deepEqual(appEntry(REGISTRY, "cndctr"),
    { id: "cndctr", title: "/CNDCTR/™", url: "https://apps.example/cndctr" });
});

test("http://localhost is refused unless the prototype opts in", () => {
  const reg = { apps: [{ id: "dev", name: "Dev", url: "http://localhost:8401/" },
                       { id: "lan", name: "Lan", url: "http://192.168.1.5/" }] };
  assert.throws(() => appEntry(reg, "dev"), AppPanelError);
  assert.equal(appEntry(reg, "dev", { allowLoopbackHttp: true }).url, "http://localhost:8401/");
  assert.throws(() => appEntry(reg, "lan", { allowLoopbackHttp: true }), AppPanelError);
});
