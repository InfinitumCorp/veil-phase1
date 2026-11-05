// Cumulus://ID — one account for everything Infinitum.
//
// An OpenID Connect provider (authorization code flow with PKCE):
//   GET  /.well-known/openid-configuration   discovery
//   GET  /jwks.json                          public signing keys
//   GET  /authorize                          start sign-in (shows sign-in page if needed)
//   POST /token                              exchange a code for tokens
//   GET  /userinfo                           profile for an access token
//   GET|POST /login, /register, /logout      account pages
//   GET  /                                   account page
//
// Security choices:
//  - Passwords are hashed with scrypt; the plain password is never stored.
//  - Redirect addresses must match a registered address exactly.
//  - Public clients (the VEIL browser) must use PKCE with S256.
//  - Codes are single-use and expire after 60 seconds.
//  - Forms carry a CSRF token (double-submit cookie); failed sign-ins are
//    rate-limited per email address.
//  - Pages cannot be framed, except by origins listed in frameAncestors
//    (used only by the local prototype).
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApp, html, json, redirect, send, cookie, readBody, escapeHtml, DEFAULT_CSP,
  signer, persistentSecret, jsonStore, randomToken, listen,
} from "../infinitum-common/http.mjs";
import { loadSigningKey, signJwt } from "../infinitum-common/jwt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_TTL_MS = 60 * 1000;
const TOKEN_TTL_S = 60 * 60;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ---- passwords -----------------------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function checkPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

// A real hash to compare against when the email is unknown, so a missing
// account takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

export function validateRegistration({ name, email, password, confirm }) {
  const errors = [];
  name = String(name || "").trim();
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  if (!name || name.length > 80) errors.push("Enter your name (up to 80 characters).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.push("Enter a valid email address.");
  if (password.length < 10) errors.push("Use a password of at least 10 characters.");
  if (password.length > 200) errors.push("Use a password of at most 200 characters.");
  if (password && password.toLowerCase() === email) errors.push("Your password can't be your email address.");
  if (confirm !== undefined && password !== confirm) errors.push("The two passwords don't match.");
  return { errors, name, email, password };
}

// ---- the service -----------------------------------------------------------

/**
 * clients: [{ client_id, name, type: "public"|"confidential", secret?,
 *             redirect_uris: [...], post_logout_redirect_uris?: [...],
 *             allowed_origins?: [...] }]   // CORS for the token endpoint
 */
export function createCumulusID({ issuer, dataDir, clients, frameAncestors = "'none'", secure = issuer.startsWith("https:") }) {
  const key = loadSigningKey(dataDir);
  const box = signer(persistentSecret(dataDir, "cookie-secret"));
  const store = jsonStore(path.join(dataDir, "users.json"), { users: {} });
  const clientById = new Map(clients.map(c => [c.client_id, c]));
  for (const c of clients) {
    if (c.type === "confidential" && !c.secret) throw new Error(`client ${c.client_id} needs a secret`);
  }

  const sessions = new Map();     // sid -> { sub, exp, authTime }
  const codes = new Map();        // code -> { ... }
  const accessTokens = new Map(); // token -> { sub, clientId, scope, exp }
  const failures = new Map();     // email -> [timestamps]

  const users = () => store.get().users;
  const findByEmail = email => Object.values(users()).find(u => u.email === email) || null;

  // ---- helpers ----
  function currentUser(ctx) {
    const s = sessions.get(ctx.cookies.cid_sid);
    if (!s || s.exp < Date.now()) return null;
    const u = users()[s.sub];
    return u ? { ...u, authTime: s.authTime } : null;
  }

  function startSession(res, sub) {
    const sid = randomToken();
    sessions.set(sid, { sub, exp: Date.now() + SESSION_TTL_MS, authTime: Math.floor(Date.now() / 1000) });
    return cookie("cid_sid", sid, { maxAge: SESSION_TTL_MS / 1000, secure });
  }

  function csrf(ctx) {
    const existing = ctx.cookies.cid_csrf;
    const token = existing && /^[A-Za-z0-9_-]{20,}$/.test(existing) ? existing : randomToken(24);
    return { token, setCookie: existing === token ? null : cookie("cid_csrf", token, { secure }) };
  }
  function checkCsrf(ctx, body) {
    const a = Buffer.from(String(ctx.cookies.cid_csrf || ""));
    const b = Buffer.from(String(body.csrf || ""));
    if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error("This form expired. Go back and try again."), { status: 400 });
    }
  }

  function tooManyFailures(email) {
    const now = Date.now();
    const list = (failures.get(email) || []).filter(t => now - t < FAILURE_WINDOW_MS);
    failures.set(email, list);
    return list.length >= MAX_FAILURES;
  }

  function clientAuth(req, body) {
    let id = body.client_id, secret = body.client_secret;
    const h = String(req.headers.authorization || "");
    if (h.startsWith("Basic ")) {
      const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
      id = decodeURIComponent(u || "");
      secret = decodeURIComponent(p || "");
    }
    const client = clientById.get(id);
    if (!client) return null;
    if (client.type === "confidential") {
      const a = Buffer.from(String(secret || "")), b = Buffer.from(client.secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    }
    return client;
  }

  function cors(req, res, client) {
    const origin = req.headers.origin;
    if (origin && client && (client.allowed_origins || []).includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }

  /** Validate an authorization request. Returns {params, client} or {error, redirectable}. */
  function checkAuthRequest(q) {
    const get = k => (typeof q.get === "function" ? q.get(k) : q[k]) ?? null;
    const client = clientById.get(get("client_id"));
    if (!client) return { error: "This app isn't registered with Cumulus://ID." };
    const redirectUri = get("redirect_uri");
    if (!client.redirect_uris.includes(redirectUri)) return { error: "This app's return address isn't registered with Cumulus://ID." };
    const params = {
      response_type: get("response_type"), client_id: client.client_id, redirect_uri: redirectUri, state: get("state"), nonce: get("nonce"),
      scope: get("scope") || "", code_challenge: get("code_challenge"), code_challenge_method: get("code_challenge_method"),
      prompt: get("prompt"),
    };
    const back = error => ({ error, redirectable: true, params, client });
    if (get("response_type") !== "code") return back("unsupported_response_type");
    if (!params.scope.split(" ").includes("openid")) return back("invalid_scope");
    if (client.type === "public" && !params.code_challenge) return back("invalid_request");
    if (params.code_challenge && params.code_challenge_method !== "S256") return back("invalid_request");
    if (params.code_challenge && !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return back("invalid_request");
    return { params, client };
  }

  function errorRedirect(res, params, error) {
    const u = new URL(params.redirect_uri);
    u.searchParams.set("error", error);
    if (params.state) u.searchParams.set("state", params.state);
    redirect(res, u.href);
  }

  function issueCode(res, params, user, extraHeaders = {}) {
    const code = randomToken();
    codes.set(code, { ...params, sub: user.id, authTime: user.authTime, exp: Date.now() + CODE_TTL_MS });
    const u = new URL(params.redirect_uri);
    u.searchParams.set("code", code);
    if (params.state) u.searchParams.set("state", params.state);
    redirect(res, u.href, extraHeaders);
  }

  // ---- pages ----
  function layout(title, body, headers = {}) {
    return [`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — Cumulus://ID</title><link rel="stylesheet" href="/static/cid.css"></head><body><header><span class="brand">Cumulus://ID</span></header><main>${body}</main><footer>One account for everything Infinitum. Signed in over Tor, your location stays hidden.</footer></body></html>`, headers];
  }

  function signInPage(res, ctx, { req = "", email = "", error = "", appName = "", status = 200 } = {}) {
    const c = csrf(ctx);
    const forApp = appName ? `<p class="lede">to continue to <strong>${escapeHtml(appName)}</strong></p>` : "";
    const [body] = layout("Sign in", `
      <h1>Sign in</h1>${forApp}
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="csrf" value="${c.token}"><input type="hidden" name="req" value="${escapeHtml(req)}">
        <label>Email<input name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>
      <p class="alt">New to Infinitum? <a href="/register${req ? `?req=${encodeURIComponent(req)}` : ""}">Create a Cumulus://ID</a></p>`);
    html(res, status, body, c.setCookie ? { "Set-Cookie": c.setCookie } : {});
  }

  function registerPage(res, ctx, { req = "", values = {}, errors = [], status = 200 } = {}) {
    const c = csrf(ctx);
    const [body] = layout("Create account", `
      <h1>Create your Cumulus://ID</h1>
      <p class="lede">One account for VEIL, SCALVS.ai, /CNDCTR/ and every Infinitum app.</p>
      ${errors.length ? `<ul class="error" role="alert">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
      <form method="post" action="/register">
        <input type="hidden" name="csrf" value="${c.token}"><input type="hidden" name="req" value="${escapeHtml(req)}">
        <label>Name<input name="name" autocomplete="name" required maxlength="80" value="${escapeHtml(values.name)}"></label>
        <label>Email<input name="email" type="email" autocomplete="username" required value="${escapeHtml(values.email)}"></label>
        <label>Password <span class="hint">at least 10 characters</span><input name="password" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required minlength="10"></label>
        <button type="submit">Create account</button>
      </form>
      <p class="alt">Already have one? <a href="/login${req ? `?req=${encodeURIComponent(req)}` : ""}">Sign in</a></p>`);
    html(res, status, body, c.setCookie ? { "Set-Cookie": c.setCookie } : {});
  }

  /** After sign-in or registration: resume the app's request, or show the account page. */
  function resume(res, ctx, reqBlob, user, setCookie) {
    const pending = reqBlob ? box.verify(reqBlob) : null;
    if (pending) {
      const checked = checkAuthRequest(pending.params);
      if (!checked.error) return issueCode(res, checked.params, user, { "Set-Cookie": setCookie });
    }
    redirect(res, "/", { "Set-Cookie": setCookie });
  }

  const routes = [
    { method: "GET", path: "/.well-known/openid-configuration", handler: (req, res) => json(res, 200, {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks.json`, end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    }) },
    { method: "GET", path: "/jwks.json", handler: (req, res) => json(res, 200, { keys: [key.jwk] }) },

    { method: "GET", path: "/authorize", handler: (req, res, ctx) => {
      const checked = checkAuthRequest(ctx.query);
      if (checked.error && !checked.redirectable) return html(res, 400, layout("Error", `<h1>Can't sign in</h1><p>${escapeHtml(checked.error)}</p>`)[0]);
      if (checked.error) return errorRedirect(res, checked.params, checked.error);
      const user = currentUser(ctx);
      if (user && checked.params.prompt !== "login") return issueCode(res, checked.params, user);
      const reqBlob = box.sign({ params: checked.params, exp: Date.now() + REQUEST_TTL_MS });
      signInPage(res, ctx, { req: reqBlob, appName: checked.client.name });
    } },

    { method: "GET", path: "/login", handler: (req, res, ctx) => signInPage(res, ctx, { req: ctx.query.get("req") || "" }) },
    { method: "POST", path: "/login", handler: async (req, res, ctx) => {
      const body = await readBody(req);
      checkCsrf(ctx, body);
      const email = String(body.email || "").trim().toLowerCase();
      const appName = (() => { const p = box.verify(body.req); return p ? clientById.get(p.params.client_id)?.name : ""; })();
      if (tooManyFailures(email)) {
        return signInPage(res, ctx, { req: body.req, email, appName, status: 429,
          error: "Too many attempts for this account. Wait 15 minutes and try again." });
      }
      const user = findByEmail(email);
      const ok = checkPassword(String(body.password || ""), user ? user.password : DUMMY_HASH) && user;
      if (!ok) {
        failures.get(email).push(Date.now());
        return signInPage(res, ctx, { req: body.req, email, appName, status: 401, error: "That email and password don't match." });
      }
      failures.delete(email);
      const setCookie = startSession(res, user.id);
      resume(res, ctx, body.req, { ...user, authTime: Math.floor(Date.now() / 1000) }, setCookie);
    } },

    { method: "GET", path: "/register", handler: (req, res, ctx) => registerPage(res, ctx, { req: ctx.query.get("req") || "" }) },
    { method: "POST", path: "/register", handler: async (req, res, ctx) => {
      const body = await readBody(req);
      checkCsrf(ctx, body);
      const v = validateRegistration(body);
      if (!v.errors.length && findByEmail(v.email)) v.errors.push("There's already a Cumulus://ID for that email. Sign in instead.");
      if (v.errors.length) return registerPage(res, ctx, { req: body.req, values: { name: v.name, email: v.email }, errors: v.errors, status: 400 });
      const user = { id: randomToken(16), email: v.email, name: v.name, password: hashPassword(v.password), created: new Date().toISOString() };
      users()[user.id] = user;
      store.save();
      const setCookie = startSession(res, user.id);
      resume(res, ctx, body.req, { ...user, authTime: Math.floor(Date.now() / 1000) }, setCookie);
    } },

    { method: "OPTIONS", path: "/token", handler: (req, res) => {
      const origin = req.headers.origin;
      const allowed = clients.some(c => (c.allowed_origins || []).includes(origin));
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
        res.setHeader("Vary", "Origin");
      }
      send(res, 204, "");
    } },
    { method: "POST", path: "/token", handler: async (req, res) => {
      const body = await readBody(req);
      const client = clientAuth(req, body);
      cors(req, res, client);
      const err = (status, error) => json(res, status, { error });
      if (!client) return err(401, "invalid_client");
      if (body.grant_type !== "authorization_code") return err(400, "unsupported_grant_type");
      const entry = codes.get(body.code);
      codes.delete(body.code);                              // single use
      if (!entry || entry.exp < Date.now()) return err(400, "invalid_grant");
      if (entry.client_id !== client.client_id || entry.redirect_uri !== body.redirect_uri) return err(400, "invalid_grant");
      if (entry.code_challenge) {
        const v = String(body.code_verifier || "");
        if (v.length < 43 || v.length > 128) return err(400, "invalid_grant");
        const challenge = crypto.createHash("sha256").update(v).digest("base64url");
        if (challenge !== entry.code_challenge) return err(400, "invalid_grant");
      }
      const user = users()[entry.sub];
      if (!user) return err(400, "invalid_grant");
      const now = Math.floor(Date.now() / 1000);
      const scopes = entry.scope.split(" ");
      const idToken = signJwt({
        iss: issuer, sub: user.id, aud: client.client_id, iat: now, exp: now + TOKEN_TTL_S, auth_time: entry.authTime,
        ...(entry.nonce ? { nonce: entry.nonce } : {}),
        ...(scopes.includes("profile") ? { name: user.name } : {}),
        ...(scopes.includes("email") ? { email: user.email } : {}),
      }, key);
      const accessToken = randomToken();
      accessTokens.set(accessToken, { sub: user.id, clientId: client.client_id, scope: entry.scope, exp: Date.now() + TOKEN_TTL_S * 1000 });
      json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_S, id_token: idToken, scope: entry.scope });
    } },

    { method: "GET", path: "/userinfo", handler: (req, res) => {
      const h = String(req.headers.authorization || "");
      const t = h.startsWith("Bearer ") ? accessTokens.get(h.slice(7)) : null;
      if (!t || t.exp < Date.now()) return json(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": "Bearer" });
      cors(req, res, clientById.get(t.clientId));
      const u = users()[t.sub];
      const scopes = t.scope.split(" ");
      json(res, 200, { sub: u.id, ...(scopes.includes("profile") ? { name: u.name } : {}), ...(scopes.includes("email") ? { email: u.email } : {}) });
    } },

    { method: "GET", path: "/logout", handler: (req, res, ctx) => {
      sessions.delete(ctx.cookies.cid_sid);
      const target = ctx.query.get("post_logout_redirect_uri");
      const client = clientById.get(ctx.query.get("client_id"));
      const ok = target && client && (client.post_logout_redirect_uris || []).includes(target);
      redirect(res, ok ? target : "/", { "Set-Cookie": cookie("cid_sid", "", { maxAge: 0, secure }) });
    } },

    { method: "GET", path: "/", handler: (req, res, ctx) => {
      const user = currentUser(ctx);
      const [body] = user
        ? layout("Your account", `<h1>${escapeHtml(user.name)}</h1><p class="lede">${escapeHtml(user.email)}</p>
            <p>You're signed in to Cumulus://ID. VEIL, SCALVS.ai and /CNDCTR/ use this account.</p>
            <p><a class="button" href="/logout">Sign out</a></p>`)
        : layout("Cumulus://ID", `<h1>Cumulus://ID</h1><p class="lede">One account for everything Infinitum.</p>
            <p><a class="button" href="/login">Sign in</a> <a class="button quiet" href="/register">Create account</a></p>`);
      html(res, 200, body);
    } },
  ];

  // Sign-in forms end in a redirect back to the app, and browsers apply
  // form-action to that redirect too, so allow exactly the registered
  // return origins (and nothing else).
  const returnOrigins = [...new Set(clients.flatMap(c => c.redirect_uris.map(u => new URL(u).origin)))];
  const csp = DEFAULT_CSP.replace("form-action 'self'", `form-action 'self' ${returnOrigins.join(" ")}`);
  const server = createApp({ name: "cumulus-id", routes, csp, staticDir: path.join(HERE, "static"), frameAncestors });
  return { server, issuer, _internal: { sessions, codes, accessTokens, users } };
}

// Run directly: node cumulus-id/server.mjs  (configure with CID_* environment variables)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CID_PORT || 8400);
  const issuer = process.env.CID_ISSUER || `http://localhost:${port}`;
  const clients = JSON.parse(process.env.CID_CLIENTS || "[]");
  const { server } = createCumulusID({ issuer, dataDir: process.env.CID_DATA || path.join(HERE, "data"), clients,
    frameAncestors: process.env.CID_FRAME_ANCESTORS || "'none'" });
  listen(server, port).then(p => console.log(`Cumulus://ID on ${issuer} (port ${p})`));
}
