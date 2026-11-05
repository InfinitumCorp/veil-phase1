// Common server for Infinitum apps that run in VEIL's side panel: page
// serving, shared assets, and "Sign in with Cumulus://ID".
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, json, serveStatic, persistentSecret } from "./http.mjs";
import { cidClient } from "./oidc-client.mjs";

const COMMON_STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");

/**
 * options: { name, publicUrl, issuer, clientId, clientSecret, dataDir, staticDir,
 *            frameAncestors, routes(ctx) -> extra routes, fetchImpl }
 * Returns { server, auth } where auth.user(ctx) gives the signed-in user or null.
 */
export function createInfinitumApp({ name, publicUrl, issuer, clientId, clientSecret, dataDir, staticDir,
                                     frameAncestors = "'none'", routes = () => [], fetchImpl = fetch }) {
  const auth = cidClient({
    issuer, clientId, clientSecret, redirectUri: `${publicUrl}/auth/callback`,
    secret: persistentSecret(dataDir, "cookie-secret"), secure: publicUrl.startsWith("https:"), fetchImpl,
  });
  const all = [
    { method: "GET", path: "/", handler: (req, res) => serveStatic(res, staticDir, "index.html") },
    { method: "GET", path: "/auth/login", handler: auth.login },
    { method: "GET", path: "/auth/callback", handler: auth.callback },
    { method: "GET", path: "/auth/logout", handler: auth.logout },
    { method: "GET", path: "/api/me", handler: (req, res, ctx) => json(res, 200, { user: auth.user(ctx) }) },
    { method: "GET", path: /^\/static\/common\/(?<file>[\w.-]+)$/, handler: (req, res, ctx) => serveStatic(res, COMMON_STATIC, ctx.params.file) },
    ...routes({ auth }),
  ];
  const server = createApp({ name, routes: all, staticDir, frameAncestors });
  return { server, auth };
}
