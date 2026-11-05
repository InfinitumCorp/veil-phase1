// Tests for sign-in with Cumulus://ID, run with `node --test`. A fake
// Cumulus://ID token endpoint stands in for the real service.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = p => path.join(here, "../../../veil-browser/src", p);
const { CumulusID, CumulusIDError, readConfig, pkceChallenge, PENDING_TTL_MS } = await import(src("VeilCumulusID.sys.mjs"));
const { VeilSignIn } = await import(src("VeilSignIn.sys.mjs"));

const CID = {
  issuer: "https://id.cumulus.example",
  authorize_url: "https://id.cumulus.example/authorize",
  token_url: "https://id.cumulus.example/token",
  client_id: "veil-browser",
  redirect_uri: "https://id.cumulus.example/veil/callback",
};
const REGISTRY = { signin: { label: "Sign In", url: "https://cid.example/", cid: CID } };
const NOW = 1_800_000_000_000;

const b64url = s => Buffer.from(s).toString("base64url");
const jwt = claims => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

// Builds a client plus a fake token endpoint that checks PKCE like a real one.
function setup({ claims = {}, tokenStatus = 200, now = NOW } = {}) {
  const opened = [], requests = [];
  let challenge = null;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const body = new URLSearchParams(init.body);
    const ok = createHash("sha256").update(body.get("code_verifier")).digest("base64url") === challenge;
    if (!ok) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
    return {
      ok: tokenStatus === 200, status: tokenStatus,
      json: async () => ({ access_token: "at", id_token: jwt({
        iss: CID.issuer, aud: CID.client_id, sub: "user-1", name: "Ada Lovelace",
        exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000), nonce: client.pending?.nonce ?? seenNonce,
        ...claims }) }),
    };
  };
  let seenNonce = null;
  const clock = { t: now };
  const client = new CumulusID({ registry: REGISTRY, openTab: (u, o) => opened.push([u, o]), fetch, now: () => clock.t });
  const begin = async () => {
    const href = await client.start();
    const q = new URL(href).searchParams;
    challenge = q.get("code_challenge");
    seenNonce = q.get("nonce");
    return q;
  };
  const redirect = (q, extra = "") => `${CID.redirect_uri}?code=abc&state=${q.get("state")}${extra}`;
  return { client, opened, requests, begin, redirect, clock };
}

test("Sign In opens Cumulus://ID's sign-in page with PKCE, state and nonce", async () => {
  const { opened, begin } = setup();
  const q = await begin();
  const url = new URL(opened[0][0]);
  assert.equal(url.origin + url.pathname, CID.authorize_url);
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "veil-browser");
  assert.equal(q.get("redirect_uri"), CID.redirect_uri);
  assert.equal(q.get("scope"), "openid profile");
  assert.equal(q.get("code_challenge_method"), "S256");
  for (const k of ["state", "nonce", "code_challenge"]) assert.ok(q.get(k).length >= 43, k);
  assert.deepEqual(opened[0][1], { inBackground: false, relatedToCurrent: true });
});

test("the PKCE challenge is the SHA-256 of the verifier", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
               "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");   // RFC 7636 appendix B
});

test("a successful sign-in shows the user's name and keeps tokens in memory", async () => {
  const { client, begin, redirect, requests } = setup();
  const q = await begin();
  const account = await client.handleRedirect(redirect(q));
  assert.deepEqual(account, { signedIn: true, name: "Ada Lovelace" });
  assert.ok(client.signedIn());
  const body = new URLSearchParams(requests[0].init.body);
  assert.equal(requests[0].url, CID.token_url);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "abc");
  assert.equal(requests[0].init.credentials, "omit");
});

test("the redirect address is recognised; other addresses are not", () => {
  const { client } = setup();
  assert.ok(client.isRedirect(`${CID.redirect_uri}?code=x`));
  assert.ok(!client.isRedirect("https://evil.example/veil/callback?code=x"));
  assert.ok(!client.isRedirect("https://id.cumulus.example/other?code=x"));
  assert.ok(!client.isRedirect("not a url"));
});

const failures = [
  ["a wrong state (forged redirect)", async ({ client, begin }) => { await begin(); return `${CID.redirect_uri}?code=abc&state=forged`; }, /state/],
  ["an error from Cumulus://ID", async ({ begin, redirect }) => redirect(await begin(), "&error=access_denied"), /refused/],
  ["no code", async ({ begin }) => { const q = await begin(); return `${CID.redirect_uri}?state=${q.get("state")}`; }, /no code/],
  ["a sign-in older than 10 minutes", async ({ begin, redirect, clock }) => { const q = await begin(); clock.t += PENDING_TTL_MS + 1; return redirect(q); }, /too long/],
];
for (const [label, make, pattern] of failures) {
  test(`refuses ${label}`, async () => {
    const s = setup();
    const address = await make(s);
    await assert.rejects(s.client.handleRedirect(address), pattern);
    assert.ok(!s.client.signedIn());
  });
}

for (const [label, claims, pattern] of [
  ["the wrong issuer", { iss: "https://evil.example" }, /issuer/],
  ["the wrong audience", { aud: "someone-else" }, /not for VEIL/],
  ["an expired token", { exp: Math.floor(NOW / 1000) - 3600 }, /expired/],
  ["a replayed nonce", { nonce: "old-nonce" }, /nonce/],
  ["no subject", { sub: "" }, /subject/],
]) {
  test(`refuses an ID token with ${label}`, async () => {
    const s = setup({ claims });
    const q = await s.begin();
    await assert.rejects(s.client.handleRedirect(s.redirect(q)), pattern);
    assert.ok(!s.client.signedIn());
  });
}

test("a redirect can be used only once", async () => {
  const s = setup();
  const q = await s.begin();
  await s.client.handleRedirect(s.redirect(q));
  await assert.rejects(s.client.handleRedirect(s.redirect(q)), /no sign-in was started/);
});

test("a failed token request is reported", async () => {
  const s = setup({ tokenStatus: 500 });
  const q = await s.begin();
  await assert.rejects(s.client.handleRedirect(s.redirect(q)), /token request failed \(500\)/);
});

test("New Identity forgets the Cumulus://ID session", async () => {
  const s = setup();
  const q = await s.begin();
  await VeilSignIn.finish({ cumulusId: s.client, address: s.redirect(q) });
  assert.deepEqual(VeilSignIn.account(), { signedIn: true, name: "Ada Lovelace" });
  VeilSignIn.onNewIdentity(s.client);
  assert.ok(!s.client.signedIn());
  assert.deepEqual(VeilSignIn.account(), { signedIn: false, name: "" });
});

test("Sign In uses Cumulus://ID when configured, else opens the CID page", async () => {
  const s = setup();
  const href = await VeilSignIn.open({ registry: REGISTRY, openTab: () => {}, cumulusId: s.client });
  assert.ok(href.startsWith(CID.authorize_url));
  const opened = [];
  const plain = { signin: { label: "Sign In", url: "https://cid.example/page" } };
  const off = new CumulusID({ registry: plain, openTab: () => {}, fetch: async () => {} });
  assert.equal(off.enabled, false);
  assert.equal(await VeilSignIn.open({ registry: plain, openTab: u => opened.push(u), cumulusId: off }), "https://cid.example/page");
  assert.deepEqual(opened, ["https://cid.example/page"]);
});

test("unsafe Cumulus://ID settings are refused", () => {
  assert.throws(() => readConfig({ signin: { cid: { ...CID, token_url: "http://id.cumulus.example/token" } } }), CumulusIDError);
  assert.throws(() => readConfig({ signin: { cid: { ...CID, client_id: "" } } }), CumulusIDError);
  assert.equal(readConfig({ signin: {} }), null);
});
