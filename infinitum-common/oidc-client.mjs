// "Sign in with Cumulus://ID" for Infinitum apps (server side).
//
// Each app is a confidential OpenID Connect client of Cumulus://ID. Sign-in
// runs in a popup window, so it works when the app is open in VEIL's side
// panel: the popup signs in on Cumulus://ID's own page, then tells the panel
// to reload and closes itself. The app keeps a signed session cookie.
import crypto from "node:crypto";
import { cookie, redirect, html, signer, randomToken, escapeHtml } from "./http.mjs";
import { verifyJwt } from "./jwt.mjs";

const TX_COOKIE = "cid_tx";
const SESSION_COOKIE = "app_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TX_TTL_MS = 10 * 60 * 1000;

export function cidClient({ issuer, clientId, clientSecret, redirectUri, secret, secure = false, fetchImpl = fetch }) {
  const box = signer(secret);
  let jwksCache = null;

  async function jwks(force = false) {
    if (!jwksCache || force) {
      const r = await fetchImpl(`${issuer}/jwks.json`);
      if (!r.ok) throw new Error(`Cumulus://ID keys unavailable (${r.status})`);
      jwksCache = await r.json();
    }
    return jwksCache;
  }

  /** Start sign-in: redirect to Cumulus://ID. ?popup=1 when opened as a popup. */
  function login(req, res, ctx) {
    const verifier = randomToken();
    const tx = { state: randomToken(), nonce: randomToken(), verifier,
                 popup: ctx.query.get("popup") === "1", exp: Date.now() + TX_TTL_MS };
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${issuer}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid profile email",
      state: tx.state, nonce: tx.nonce, code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    redirect(res, url.href, { "Set-Cookie": cookie(TX_COOKIE, box.sign(tx), { maxAge: TX_TTL_MS / 1000, secure }) });
  }

  /** Cumulus://ID redirected back: exchange the code and start a session. */
  async function callback(req, res, ctx) {
    const tx = box.verify(ctx.cookies[TX_COOKIE]);
    const clear = cookie(TX_COOKIE, "", { maxAge: 0, secure });
    const fail = msg => html(res, 400, page("Sign-in failed", `<p>${escapeHtml(msg)}</p><p><a href="/">Back</a></p>`), { "Set-Cookie": clear });
    if (!tx || ctx.query.get("state") !== tx.state) return fail("This sign-in has expired or was not started here. Please try again.");
    if (ctx.query.get("error")) return fail(`Cumulus://ID said: ${ctx.query.get("error")}`);
    const code = ctx.query.get("code");
    if (!code) return fail("Cumulus://ID returned no code.");

    const r = await fetchImpl(`${issuer}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: tx.verifier }).toString(),
    });
    if (!r.ok) return fail(`Token request failed (${r.status}).`);
    const tokens = await r.json();
    let claims;
    try {
      claims = verifyJwt(tokens.id_token, await jwks(), { issuer, audience: clientId, nonce: tx.nonce });
    } catch (err) {
      if (err.message !== "unknown signing key") return fail(`ID token rejected: ${err.message}`);
      claims = verifyJwt(tokens.id_token, await jwks(true), { issuer, audience: clientId, nonce: tx.nonce });
    }
    const session = box.sign({ sub: claims.sub, name: claims.name || "", email: claims.email || "", exp: Date.now() + SESSION_TTL_MS });
    const cookies = [clear, cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_MS / 1000, secure })];
    if (tx.popup) {
      // Tell the panel (window.opener) to reload, then close the popup.
      return html(res, 200, page("Signed in", `<p>Signed in. You can close this window.</p><script src="/static/common/popup-done.js"></script>`), { "Set-Cookie": cookies });
    }
    redirect(res, "/", { "Set-Cookie": cookies });
  }

  function user(ctx) {
    const s = box.verify(ctx.cookies[SESSION_COOKIE]);
    return s ? { sub: s.sub, name: s.name, email: s.email } : null;
  }

  function logout(req, res) {
    redirect(res, "/", { "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAge: 0, secure }) });
  }

  return { login, callback, user, logout };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/static/common/app.css"></head><body class="message"><main>${body}</main></body></html>`;
}
