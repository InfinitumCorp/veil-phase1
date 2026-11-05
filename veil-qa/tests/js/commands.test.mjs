// Tests for VEIL address-bar app commands, run with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = p => path.join(here, "../../../veil-browser/src", p);
const { parse, suggestion, run, panelUrl, MAX_PROMPT } = await import(src("VeilAppCommands.sys.mjs"));
const { AppPanel } = await import(src("VeilAppPanel.sys.mjs"));

const REGISTRY = { apps: [
  { id: "cndctr", name: "/CNDCTR/™", url: "https://apps.example/cndctr" },
  { id: "scalvs", name: "SCALVS.ai™", url: "https://apps.example/scalus#old" },
] };

test("both spellings reach each app, any case", () => {
  for (const [input, id] of [["@scalvs hi", "scalvs"], ["@Scalus hi", "scalvs"],
                             ["@CNDCTR go", "cndctr"], ["@conductor go", "cndctr"]]) {
    assert.equal(parse(input).id, id, input);
  }
});

test("the rest of the line becomes the prompt, tidied", () => {
  assert.deepEqual(parse("  @scalvs   summarize\n this   page "), { id: "scalvs", prompt: "summarize this page" });
  assert.deepEqual(parse("@scalvs"), { id: "scalvs", prompt: "" });
});

test("ordinary input is not a command", () => {
  for (const input of ["scalvs hi", "@scalvsx hi", "email@scalvs.com", "@", "@unknown hi",
                       "https://scalvs.ai", "what is @scalvs", "", null, 42]) {
    assert.equal(parse(input), null, String(input));
  }
});

test("prompts are capped", () => {
  assert.equal(parse("@scalvs " + "x".repeat(MAX_PROMPT + 50)).prompt.length, MAX_PROMPT);
});

test("the suggestion row names the app and never searches or records history", () => {
  const s = suggestion("@scalvs summarize this page", REGISTRY);
  assert.equal(s.label, "Ask SCALVS.ai™: summarize this page");
  assert.equal(s.sendToSearchEngine, false);
  assert.equal(s.recordInHistory, false);
  assert.equal(suggestion("@cndctr export reports", REGISTRY).label, "Run in /CNDCTR/™: export reports");
  assert.equal(suggestion("@cndctr", REGISTRY).label, "Open /CNDCTR/™");
  assert.equal(suggestion("@scalvs hi", { apps: [] }), null);   // app not in this build
});

test("the prompt rides in the fragment, never the query string", () => {
  const url = new URL(panelUrl("https://apps.example/scalus?x=1", "a&b #c"));
  assert.equal(url.search, "?x=1");
  assert.equal(decodeURIComponent(url.hash.slice("#prompt=".length)), "a&b #c");
  assert.equal(panelUrl("https://apps.example/scalus#old", ""), "https://apps.example/scalus");
});

test("running a command opens the panel with the prompt", () => {
  const calls = [];
  const panel = { show: a => calls.push(["show", a]), hide: () => calls.push(["hide"]), setWidth: w => calls.push(["width", w]) };
  const p = new AppPanel({ registry: REGISTRY, panel });
  run("@scalvs summarize this page", p);
  assert.deepEqual(calls.at(-1), ["show", { url: "https://apps.example/scalus#prompt=summarize%20this%20page", title: "SCALVS.ai™" }]);
  run("@scalvs again", p);                       // already open: stays open, new prompt
  assert.equal(calls.filter(c => c[0] === "hide").length, 0);
  assert.equal(run("not a command", p), null);
});
