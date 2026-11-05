// Tests for VEIL Sign In (browser side), run with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { VeilSignIn, signInUrl, SignInError } =
  await import(path.join(here, "../../../veil-browser/src/VeilSignIn.sys.mjs"));

const REG = { signin: { label: "Sign In", url: "https://id.example/sign-in" } };

test("without Cumulus://ID settings, Sign In opens the Cumulus://ID page in a new tab", async () => {
  const opened = [];
  const href = await VeilSignIn.open({ registry: REG, openTab: (u, o) => opened.push([u, o]) });
  assert.equal(href, "https://id.example/sign-in");
  assert.deepEqual(opened, [["https://id.example/sign-in", { inBackground: false, relatedToCurrent: true }]]);
});

for (const [label, url] of [
  ["http", "http://id.example/sign-in"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/html,<form>"],
  ["file", "file:///etc/passwd"],
  ["embedded credentials", "https://user:pass@id.example/"],
  ["not a URL", "sign in please"],
]) {
  test(`refuses a ${label} sign-in address`, () => {
    assert.throws(() => signInUrl({ signin: { url } }), SignInError);
  });
}

test("refuses when the build has no sign-in address", () => {
  assert.throws(() => signInUrl({}), SignInError);
  assert.throws(() => signInUrl(null), SignInError);
});

test("account starts signed out", () => {
  assert.deepEqual(VeilSignIn.account(), { signedIn: false, name: "" });
});

test("sign-in and New Identity update subscribers", () => {
  const seen = [];
  const stop = VeilSignIn.subscribe(a => seen.push(a));
  VeilSignIn.setAccount({ signedIn: true, name: "Ada" });
  VeilSignIn.onNewIdentity();
  stop();
  VeilSignIn.setAccount({ signedIn: true, name: "ignored" });
  VeilSignIn.onNewIdentity();
  assert.deepEqual(seen, [{ signedIn: true, name: "Ada" }, { signedIn: false, name: "" }]);
});

test("only a strict true counts as signed in, and long names are cut", () => {
  VeilSignIn.setAccount({ signedIn: "yes", name: "x" });
  assert.equal(VeilSignIn.account().signedIn, false);
  VeilSignIn.setAccount({ signedIn: true, name: "n".repeat(200) });
  assert.equal(VeilSignIn.account().name.length, 64);
  VeilSignIn.onNewIdentity();
});
