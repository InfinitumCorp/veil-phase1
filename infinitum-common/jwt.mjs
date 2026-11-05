// RS256 JSON Web Tokens with Node's crypto. Used by Cumulus://ID to sign ID
// tokens and by Infinitum apps to verify them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** Load the signing key from dataDir, creating a 2048-bit RSA key the first time. */
export function loadSigningKey(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "signing-key.pem");
  let pem;
  try {
    pem = fs.readFileSync(file, "utf8");
  } catch {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    pem = privateKey.export({ type: "pkcs8", format: "pem" });
    fs.writeFileSync(file, pem, { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const kid = crypto.createHash("sha256").update(jwk.n).digest("base64url").slice(0, 16);
  return { privateKey, publicKey, kid, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export function signJwt(payload, { privateKey, kid }) {
  const head = b64({ alg: "RS256", typ: "JWT", kid });
  const body = b64(payload);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString()),
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString()),
    signed: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  };
}

/**
 * Verify an RS256 token against a JWKS ({keys:[...]}) and check claims.
 * Throws on any problem; returns the payload.
 */
export function verifyJwt(token, jwks, { issuer, audience, nonce, nowS = Math.floor(Date.now() / 1000), skewS = 120 }) {
  const { header, payload, signed, signature } = decodeJwt(token);
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(signed), key, signature)) throw new Error("bad signature");
  if (payload.iss !== issuer) throw new Error("wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new Error("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp + skewS < nowS) throw new Error("expired");
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce mismatch");
  return payload;
}
