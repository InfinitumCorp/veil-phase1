// Serves the clickable VEIL prototype: a web version of the browser shell
// (tabs, address bar, side panel) that runs VEIL's real modules from
// veil-browser/src and VEIL's real start page from veil-chrome/src.
//
// It is a prototype, not the browser: pages load in frames on this machine
// and nothing goes over Tor. The real browser is Tor Browser plus the
// patches in veil-browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, send, serveStatic } from "../infinitum-common/http.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CHROME_SRC = path.join(ROOT, "veil-chrome", "src");
const MODULES = path.join(ROOT, "veil-browser", "src");
// Local cache written by veil-browser/tools/fetch_geo.py. Never fetched from here.
const GEO_CACHE = process.env.VEIL_GEO_DIR
  ? path.resolve(process.env.VEIL_GEO_DIR)
  : path.join(ROOT, "veil-browser", "data", "geo", "cache");
const GEO_FILES = new Set(["geoip.dat", "geosite.dat"]);

/** registry: the dev app list (localhost addresses), same shape as the signed one. */
export function createPrototype({ registry, frameSources }) {
  const registryJs = `"use strict";\nconst VEIL_REGISTRY = Object.freeze(${JSON.stringify(registry).replace(/</g, "\\u003c")});\n`;
  const routes = [
    { method: "GET", path: "/", handler: (req, res) => serveStatic(res, path.join(HERE, "static"), "index.html") },
    { method: "GET", path: "/registry.json", handler: (req, res) => send(res, 200, JSON.stringify(registry), { "Content-Type": "application/json" }) },
    { method: "GET", path: /^\/geo\/(?<file>geoip\.dat|geosite\.dat)$/, handler: (req, res, ctx) => {
      const file = ctx.params.file;
      if (!GEO_FILES.has(file)) return send(res, 404, "Not found");
      serveStatic(res, GEO_CACHE, file);
    } },
    { method: "GET", path: "/veil/callback", handler: (req, res) => serveStatic(res, path.join(HERE, "static"), "callback.html") },
    // VEIL's real browser modules, as ES modules.
    { method: "GET", path: /^\/modules\/(?<file>Veil\w+\.sys\.mjs)$/, handler: (req, res, ctx) => serveStatic(res, MODULES, ctx.params.file) },
    // VEIL's real start page, with the prototype's stand-in for the browser bridge.
    { method: "GET", path: "/start/home/home.html", handler: (req, res) => {
      const page = fs.readFileSync(path.join(CHROME_SRC, "home", "home.html"), "utf8")
        .replace('<script src="../shared/bridge.js"></script>', '<script src="../prototype-rpm.js"></script>\n  <script src="../shared/bridge.js"></script>');
      send(res, 200, page, { "Content-Type": "text/html; charset=utf-8",
        // The start page's own CSP is in the page; allow the shell to frame it.
        "Content-Security-Policy": "frame-ancestors 'self'" });
    } },
    { method: "GET", path: "/start/generated/registry.js", handler: (req, res) => send(res, 200, registryJs, { "Content-Type": "text/javascript" }) },
    { method: "GET", path: "/start/prototype-rpm.js", handler: (req, res) => serveStatic(res, path.join(HERE, "static"), "rpm.js") },
    { method: "GET", path: /^\/start\/(?<file>(?:home|shared)\/[\w.-]+)$/, handler: (req, res, ctx) => {
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
      serveStatic(res, CHROME_SRC, ctx.params.file);
    } },
  ];
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    `connect-src 'self' ${frameSources.join(" ")}`, `frame-src 'self' ${frameSources.join(" ")} https:`,
    "base-uri 'none'", "object-src 'none'", "form-action 'self'",
  ].join("; ");
  return createApp({ name: "veil-prototype", csp, frameAncestors: "'self'", routes, staticDir: path.join(HERE, "static") });
}
