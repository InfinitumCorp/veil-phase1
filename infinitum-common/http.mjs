// Minimal HTTP toolkit for Infinitum services. Node built-ins only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_BODY = 64 * 1024;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}

export function cookie(name, value, { maxAge, path: p = "/", httpOnly = true, sameSite = "Lax", secure = false } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += "; HttpOnly";
  if (secure) c += "; Secure";
  return c;
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  if (type === "application/json") {
    try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("bad JSON"), { status: 400 }); }
  }
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

/** Security headers every response gets. `frameAncestors` controls who may embed pages. */
function baseHeaders({ csp, frameAncestors }) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `${csp}; frame-ancestors ${frameAncestors}`,
    "Cache-Control": "no-store",
  };
}

export const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'";

export function createApp({ name, csp = DEFAULT_CSP, frameAncestors = "'none'", routes, staticDir = null, log = true }) {
  const headers = baseHeaders({ csp, frameAncestors });
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const url = new URL(req.url, "http://local");
    const ctx = { url, query: url.searchParams, cookies: parseCookies(req.headers.cookie), params: {} };
    try {
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) continue;
        const m = typeof r.path === "string" ? (r.path === url.pathname ? [] : null) : r.path.exec(url.pathname);
        if (!m) continue;
        ctx.params = m.groups || {};
        await r.handler(req, res, ctx);
        return;
      }
      if (url.pathname === "/favicon.ico") return send(res, 204, "");
      if (staticDir && req.method === "GET" && url.pathname.startsWith("/static/")) {
        return serveStatic(res, staticDir, url.pathname.slice("/static/".length));
      }
      send(res, 404, "Not found");
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && log) console.error(`[${name}]`, err);
      if (!res.headersSent) send(res, status, status >= 500 ? "Something went wrong" : err.message);
    }
  });
  return server;
}

export function send(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
}
export function html(res, status, body, extra = {}) {
  send(res, status, body, { "Content-Type": "text/html; charset=utf-8", ...extra });
}
export function json(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json", ...extra });
}
export function redirect(res, location, extra = {}) {
  res.writeHead(303, { Location: location, ...extra });
  res.end();
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

export function serveStatic(res, root, rel) {
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  });
}

/** HMAC-signed values for cookies: tamper-evident, not secret. */
export function signer(secret) {
  const mac = v => crypto.createHmac("sha256", secret).update(v).digest("base64url");
  return {
    sign(obj) {
      const v = Buffer.from(JSON.stringify(obj)).toString("base64url");
      return `${v}.${mac(v)}`;
    },
    verify(token) {
      if (typeof token !== "string") return null;
      const [v, m] = token.split(".");
      if (!v || !m) return null;
      const expected = Buffer.from(mac(v));
      const given = Buffer.from(m);
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
      try {
        const obj = JSON.parse(Buffer.from(v, "base64url").toString());
        if (obj.exp && obj.exp < Date.now()) return null;
        return obj;
      } catch { return null; }
    },
  };
}

/** A secret kept in the service's data folder so sessions survive restarts. */
export function persistentSecret(dataDir, name) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  try { return fs.readFileSync(file, "utf8").trim(); } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

/** Small JSON file store with atomic writes. */
export function jsonStore(file, initial) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = structuredClone(initial); }
  return {
    get: () => data,
    save() {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function listen(server, port, host = "127.0.0.1") {
  return new Promise(resolve => server.listen(port, host, () => resolve(server.address().port)));
}
