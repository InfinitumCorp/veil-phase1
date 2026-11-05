/* VEIL sign-in with Cumulus://ID.
 *
 * "Sign In" on the start page runs a standard OpenID Connect sign-in
 * (authorization code flow with PKCE, RFC 7636) against Cumulus://ID:
 *
 *   1. VEIL opens the Cumulus://ID sign-in page in a new tab. The user signs
 *      in there, on Cumulus://ID's own page, so VEIL never sees a password.
 *   2. Cumulus://ID redirects the tab to VEIL's redirect address with a
 *      one-time code. The browser catches that navigation before it loads,
 *      closes the tab and hands the address to handleRedirect().
 *   3. VEIL exchanges the code (plus the PKCE secret only it knows) for an ID
 *      token at the token endpoint, checks the token, and shows the user as
 *      signed in.
 *
 * Anonymity: every request above goes over Tor, so Cumulus://ID learns who
 * the user is (they signed in) but never their IP address or location.
 * Tokens live in memory only, never on disk, and New Identity forgets them.
 *
 * Configuration comes from the signed app registry (registry.signin.cid), so
 * a spoofed page cannot redirect sign-in to a look-alike service:
 *   { "issuer":        "https://id.cumulus.example",
 *     "authorize_url": "https://id.cumulus.example/authorize",
 *     "token_url":     "https://id.cumulus.example/token",
 *     "client_id":     "veil-browser",
 *     "redirect_uri":  "https://id.cumulus.example/veil/callback" }
 * Until Cumulus://ID publishes these, the registry has no "cid" block and
 * Sign In opens the Cumulus://ID page instead (see VeilSignIn).
 */

export class CumulusIDError extends Error {}

export const SCOPE = "openid profile";
export const PENDING_TTL_MS = 10 * 60 * 1000;   // a sign-in must finish within 10 minutes
export const CLOCK_SKEW_S = 120;

const FIELDS = ["issuer", "authorize_url", "token_url", "client_id", "redirect_uri"];

/** Validate the "cid" block from the registry. */
export function readConfig(registry) {
  const cid = registry && registry.signin && registry.signin.cid;
  if (!cid) return null;
  for (const f of FIELDS) {
    if (typeof cid[f] !== "string" || !cid[f]) throw new CumulusIDError(`cid.${f} is missing`);
  }
  for (const f of ["issuer", "authorize_url", "token_url", "redirect_uri"]) {
    const u = new URL(cid[f]);
    if (u.protocol !== "https:" || u.username || u.password) {
      throw new CumulusIDError(`cid.${f} must be a plain https:// address`);
    }
  }
  return { ...cid };
}

const b64url = bytes =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(text) {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

const randomToken = crypto => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function pkceChallenge(verifier, crypto = globalThis.crypto) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Read the claims of an ID token (structure only; see checkClaims). */
export function decodeIdToken(jwt) {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) throw new CumulusIDError("ID token is malformed");
  try {
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    throw new CumulusIDError("ID token payload is unreadable");
  }
}

/**
 * Check ID token claims. The token comes straight from the token endpoint
 * over TLS, which OpenID Connect Core 3.1.3.7 allows in place of checking its
 * signature; issuer, audience, expiry and nonce are always checked.
 */
export function checkClaims(claims, { issuer, clientId, nonce, nowS }) {
  if (claims.iss !== issuer) throw new CumulusIDError("ID token is from the wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new CumulusIDError("ID token is not for VEIL");
  if (aud.length > 1 && claims.azp !== clientId) throw new CumulusIDError("ID token azp is not VEIL");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw new CumulusIDError("ID token has expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > nowS) throw new CumulusIDError("ID token is from the future");
  if (claims.nonce !== nonce) throw new CumulusIDError("ID token nonce does not match");
  if (typeof claims.sub !== "string" || !claims.sub) throw new CumulusIDError("ID token has no subject");
}

export class CumulusID {
  /**
   * deps: { registry, openTab(url, opts), fetch(url, init), now(), crypto }
   * fetch must be the browser's own fetch, which goes over Tor.
   */
  constructor({ registry, openTab, fetch, now = () => Date.now(), crypto = globalThis.crypto }) {
    this.config = readConfig(registry);
    this.openTab = openTab;
    this.fetch = fetch;
    this.now = now;
    this.crypto = crypto;
    this.pending = null;
    this.session = null;      // { sub, name, idToken, accessToken, expiresAt } in memory only
  }

  get enabled() {
    return this.config !== null;
  }

  /** Step 1: open the Cumulus://ID sign-in page. Returns the address opened. */
  async start() {
    if (!this.enabled) throw new CumulusIDError("Cumulus://ID is not configured in this build");
    const verifier = randomToken(this.crypto);
    const state = randomToken(this.crypto);
    const nonce = randomToken(this.crypto);
    const challenge = await pkceChallenge(verifier, this.crypto);
    this.pending = { verifier, state, nonce, startedAt: this.now() };

    const url = new URL(this.config.authorize_url);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.client_id,
      redirect_uri: this.config.redirect_uri,
      scope: SCOPE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    this.openTab(url.href, { inBackground: false, relatedToCurrent: true });
    return url.href;
  }

  /** True if a navigation is the Cumulus://ID redirect back to VEIL. */
  isRedirect(address) {
    if (!this.enabled) return false;
    try {
      const u = new URL(address);
      const r = new URL(this.config.redirect_uri);
      return u.origin === r.origin && u.pathname === r.pathname;
    } catch {
      return false;
    }
  }

  /** Steps 2-3: finish sign-in from the redirect address. Returns the account. */
  async handleRedirect(address) {
    if (!this.isRedirect(address)) throw new CumulusIDError("not the Cumulus://ID redirect address");
    const pending = this.pending;
    this.pending = null;                       // one use only, success or failure
    if (!pending) throw new CumulusIDError("no sign-in was started");
    if (this.now() - pending.startedAt > PENDING_TTL_MS) throw new CumulusIDError("sign-in took too long; try again");

    const params = new URL(address).searchParams;
    if (params.get("state") !== pending.state) throw new CumulusIDError("sign-in state does not match");
    if (params.get("error")) throw new CumulusIDError(`Cumulus://ID refused sign-in: ${params.get("error")}`);
    const code = params.get("code");
    if (!code) throw new CumulusIDError("Cumulus://ID returned no code");

    const response = await this.fetch(this.config.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirect_uri,
        client_id: this.config.client_id,
        code_verifier: pending.verifier,
      }).toString(),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new CumulusIDError(`token request failed (${response.status})`);
    const tokens = await response.json();
    if (!tokens || typeof tokens.id_token !== "string") throw new CumulusIDError("no ID token returned");

    const claims = decodeIdToken(tokens.id_token);
    const nowS = Math.floor(this.now() / 1000);
    checkClaims(claims, { issuer: this.config.issuer, clientId: this.config.client_id, nonce: pending.nonce, nowS });

    const name = [claims.name, claims.preferred_username, claims.email]
      .find(v => typeof v === "string" && v.trim()) || "";
    this.session = {
      sub: claims.sub,
      name: name.slice(0, 64),
      idToken: tokens.id_token,
      accessToken: typeof tokens.access_token === "string" ? tokens.access_token : null,
      expiresAt: claims.exp * 1000,
    };
    return { signedIn: true, name: this.session.name };
  }

  signedIn() {
    return this.session !== null && this.session.expiresAt > this.now();
  }

  /** Sign out, and New Identity: forget everything. */
  forget() {
    this.pending = null;
    this.session = null;
  }
}
