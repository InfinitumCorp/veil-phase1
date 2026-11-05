// SCALVS.ai — Infinitum's research assistant, in VEIL's side panel.
//
// Ask anything; "@scalvs ..." in VEIL's address bar opens the panel with the
// question already asked. Sign-in (Cumulus://ID) is optional: SCALVS.ai works
// anonymously and keeps no conversation history on the server.
//
// Answers come from a language model. Set ANTHROPIC_API_KEY to connect one
// (SCALVS_MODEL picks the model). Without a key, SCALVS.ai says so plainly
// instead of making answers up.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, readBody, listen } from "../../infinitum-common/http.mjs";
import { createInfinitumApp } from "../../infinitum-common/app-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
const RATE = { windowMs: 60_000, max: 20 };

export const SYSTEM_PROMPT =
  "You are SCALVS.ai, Infinitum Corporation's research assistant, running in the side panel of the VEIL " +
  "browser. VEIL routes everything over Tor; never ask for or guess the user's identity or location. " +
  "Answer clearly and briefly, say when you are unsure, and point to sources the user can check.";

/** Validate a conversation from the page. Returns {messages} or {error}. */
export function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return { error: "Ask a question." };
  const messages = input.slice(-MAX_MESSAGES).map(m => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, MAX_CHARS),
  })).filter(m => m.content.trim());
  if (!messages.length || messages.at(-1).role !== "user") return { error: "Ask a question." };
  while (messages.length && messages[0].role !== "user") messages.shift();
  return { messages };
}

/** Ask the model. Returns {reply} or {notice} (no model connected). */
export async function askModel(messages, { apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) {
    return { notice: "SCALVS.ai isn't connected to a model on this server yet, so it can't answer. " +
                     "An administrator can connect one by setting ANTHROPIC_API_KEY." };
  }
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM_PROMPT, messages }),
  });
  if (!r.ok) throw Object.assign(new Error(`The model service returned an error (${r.status}).`), { status: 502 });
  const data = await r.json();
  const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { reply: reply || "(No answer.)" };
}

export function createScalvs({ publicUrl, issuer, clientSecret, dataDir, frameAncestors,
                               apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.SCALVS_MODEL || "claude-sonnet-5-5",
                               serviceToken = process.env.SCALVS_SERVICE_TOKEN || "", fetchImpl = fetch }) {
  const hits = new Map();
  const limited = key => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < RATE.windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > RATE.max;
  };

  return createInfinitumApp({
    name: "scalvs", publicUrl, issuer, clientId: "scalvs", clientSecret, dataDir, frameAncestors,
    staticDir: path.join(HERE, "static"), fetchImpl,
    routes: ({ auth }) => [
      { method: "GET", path: "/api/status", handler: (req, res) => json(res, 200, { model: apiKey ? model : null }) },
      { method: "POST", path: "/api/ask", handler: async (req, res, ctx) => {
        // JSON only: browsers can't send this cross-site without CORS, which we never grant.
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
        const fromService = serviceToken && req.headers["x-service-token"] === serviceToken;   // /CNDCTR/ asking on a user's behalf
        const who = fromService ? "service" : (auth.user(ctx)?.sub || req.socket.remoteAddress);
        if (limited(who)) return json(res, 429, { error: "Too many questions. Wait a minute and try again." });
        const body = await readBody(req);
        const { messages, error } = cleanMessages(body.messages);
        if (error) return json(res, 400, { error });
        json(res, 200, await askModel(messages, { apiKey, model, fetchImpl }));
      } },
    ],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SCALVS_PORT || 8401);
  const { server } = createScalvs({
    publicUrl: process.env.SCALVS_URL || `http://localhost:${port}`, issuer: process.env.CID_ISSUER || "http://localhost:8400",
    clientSecret: process.env.SCALVS_CLIENT_SECRET, dataDir: process.env.SCALVS_DATA || path.join(HERE, "data"),
    frameAncestors: process.env.FRAME_ANCESTORS || "'none'",
  });
  listen(server, port).then(p => console.log(`SCALVS.ai on port ${p}`));
}
