// End-to-end tests for the Cumulus://ID server: real HTTP, real tokens, and
// VEIL's own sign-in module (VeilCumulusID) as the browser-side client.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const { createCumulusID, validateRegistration, hashPassword, checkPassword } = await import(path.join(root, "cumulus-id/server.mjs"));
const { CumulusID } = await import(path.join(root, "veil-browser/src/VeilCumulusID.sys.mjs"));
const { verifyJwt } = await import(path.join(root, "infinitum-common/jwt.mjs"));

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

const port = await freePort();
const issuer = `http://localhost:${port}`;
const VEIL_CB = "http://localhost:9999/veil/callback";
const APP_CB = "http://localhost:9998/auth/callback";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cid-"));
const { server } = createCumulusID({ issuer, dataDir, clients: [
  { client_id: "veil-browser", name: "VEIL", type: "public", redirect_uris: [VEIL_CB], allowed_origins: ["http://localhost:9999"] },
  { client_id: "scalvs", name: "SCALVS.ai", type: "confidential", secret: "s3cret-for-tests-only", redirect_uris: [APP_CB],
    post_logout_redirect_uris: ["http://localhost:9998/"] },
] });
await new Promise(r => server.listen(port, "127.0.0.1", r));
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// A tiny browser: cookie jar + manual redirects.
function browser() {
  const jar = new Map();
  const store = res => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), v);
    }
  };
  const go = async (url, init = {}) => {
    const res = await fetch(url, { ...init, redirect: "manual",
      headers: { ...(init.headers || {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    store(res);
    return res;
  };
  const field = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const post = (url, fields) => go(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { go, post, field, jar };
}

async function register(b, { name = "Ada Lovelace", email = "ada@example.com", password = "correct horse battery", req = "" } = {}) {
  const page = await (await b.go(`${issuer}/register${req ? `?req=${encodeURIComponent(req)}` : ""}`)).text();
  return b.post(`${issuer}/register`, { csrf: b.field(page, "csrf"), req, name, email, password, confirm: password });
}

test("discovery and keys are published", async () => {
  const conf = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  assert.equal(conf.issuer, issuer);
  assert.deepEqual(conf.code_challenge_methods_supported, ["S256"]);
  const jwks = await (await fetch(`${issuer}/jwks.json`)).json();
  assert.equal(jwks.keys[0].kty, "RSA");
  assert.equal(jwks.keys[0].d, undefined, "private key must not be published");
});

test("VEIL signs in with Cumulus://ID end to end", async () => {
  const b = browser();
  await register(b, { email: "veil-user@example.com" });
  b.jar.clear();                                       // fresh browser: not signed in

  const opened = [];
  const registry = { signin: { url: issuer, cid: { issuer, authorize_url: `${issuer}/authorize`, token_url: `${issuer}/token`,
                                                   client_id: "veil-browser", redirect_uri: VEIL_CB } } };
  const veil = new CumulusID({ registry, openTab: u => opened.push(u), fetch, allowLoopbackHttp: true });
  await veil.start();

  const signInPage = await (await b.go(opened[0])).text();
  assert.match(signInPage, /to continue to <strong>VEIL<\/strong>/);
  const r = await b.post(`${issuer}/login`, { csrf: b.field(signInPage, "csrf"), req: b.field(signInPage, "req"),
                                              email: "veil-user@example.com", password: "correct horse battery" });
  assert.equal(r.status, 303);
  const back = r.headers.get("location");
  assert.ok(veil.isRedirect(back));
  const account = await veil.handleRedirect(back);
  assert.deepEqual(account, { signedIn: true, name: "Ada Lovelace" });

  // The ID token is properly signed by Cumulus://ID.
  const jwks = await (await fetch(`${issuer}/jwks.json`)).json();
  const claims = verifyJwt(veil.session.idToken, jwks, { issuer, audience: "veil-browser" });
  assert.equal(claims.name, "Ada Lovelace");
  // And the access token works at userinfo.
  const info = await (await fetch(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${veil.session.accessToken}` } })).json();
  assert.equal(info.sub, claims.sub);
});

test("a second app signs in without a password (single sign-on)", async () => {
  const b = browser();
  await register(b, { email: "sso@example.com" });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: "scalvs", redirect_uri: APP_CB, scope: "openid profile email",
                                  state: "st", nonce: "nn", code_challenge: challenge, code_challenge_method: "S256" });
  const r = await b.go(`${issuer}/authorize?${q}`);
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, APP_CB);
  assert.equal(loc.searchParams.get("state"), "st");

  const tok = await fetch(`${issuer}/token`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from("scalvs:s3cret-for-tests-only").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: APP_CB, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const { id_token } = await tok.json();
  const jwks = await (await fetch(`${issuer}/jwks.json`)).json();
  const claims = verifyJwt(id_token, jwks, { issuer, audience: "scalvs", nonce: "nn" });
  assert.equal(claims.email, "sso@example.com");

  // Codes are single use.
  const again = await fetch(`${issuer}/token`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from("scalvs:s3cret-for-tests-only").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: APP_CB, code_verifier: verifier }) });
  assert.equal(again.status, 400);
});

test("unregistered return addresses are never redirected to", async () => {
  const r = await fetch(`${issuer}/authorize?response_type=code&client_id=scalvs&scope=openid&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`, { redirect: "manual" });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("location"), null);
});

test("the public VEIL client must use PKCE", async () => {
  const r = await fetch(`${issuer}/authorize?response_type=code&client_id=veil-browser&scope=openid&state=x&redirect_uri=${encodeURIComponent(VEIL_CB)}`, { redirect: "manual" });
  assert.equal(r.status, 303);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_request");
});

test("a wrong PKCE verifier or client secret is refused", async () => {
  const b = browser();
  await register(b, { email: "pkce@example.com" });
  const challenge = crypto.createHash("sha256").update("a".repeat(43)).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: "scalvs", redirect_uri: APP_CB, scope: "openid", code_challenge: challenge, code_challenge_method: "S256" });
  const code = new URL((await b.go(`${issuer}/authorize?${q}`)).headers.get("location")).searchParams.get("code");
  const bad = await fetch(`${issuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from("scalvs:s3cret-for-tests-only").toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: APP_CB, code_verifier: "b".repeat(43) }) });
  assert.equal(bad.status, 400);
  const wrongSecret = await fetch(`${issuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from("scalvs:wrong").toString("base64") }, body: "grant_type=authorization_code&code=x" });
  assert.equal(wrongSecret.status, 401);
});

test("forms need the CSRF token", async () => {
  const b = browser();
  const r = await b.post(`${issuer}/register`, { name: "X", email: "x@example.com", password: "long enough pw", confirm: "long enough pw" });
  assert.equal(r.status, 400);
});

test("repeated wrong passwords are rate limited", async () => {
  const b = browser();
  await register(b, { email: "limit@example.com" });
  b.jar.delete("cid_sid");
  let status;
  for (let i = 0; i < 6; i++) {
    const page = await (await b.go(`${issuer}/login`)).text();
    status = (await b.post(`${issuer}/login`, { csrf: b.field(page, "csrf"), email: "limit@example.com", password: "wrong password!" })).status;
  }
  assert.equal(status, 429);
});

test("passwords are stored as scrypt hashes, never in the clear", () => {
  const users = JSON.parse(fs.readFileSync(path.join(dataDir, "users.json"), "utf8")).users;
  for (const u of Object.values(users)) {
    assert.match(u.password, /^scrypt\$/);
    assert.ok(!JSON.stringify(u).includes("correct horse battery"));
  }
  const h = hashPassword("another long password");
  assert.ok(checkPassword("another long password", h));
  assert.ok(!checkPassword("wrong", h));
});

test("registration rules", () => {
  assert.equal(validateRegistration({ name: "A", email: "a@b.co", password: "0123456789", confirm: "0123456789" }).errors.length, 0);
  assert.ok(validateRegistration({ name: "", email: "nope", password: "short", confirm: "x" }).errors.length >= 4);
  assert.ok(validateRegistration({ name: "A", email: "abcdefghij@b.co", password: "abcdefghij@b.co", confirm: "abcdefghij@b.co" }).errors.length >= 1);
});

test("pages cannot be framed by other sites", async () => {
  const r = await fetch(`${issuer}/login`);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});
