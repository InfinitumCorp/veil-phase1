// /CNDCTR/ — Infinitum's automation console, in VEIL's side panel.
//
// Give it commands in plain English, now or on a schedule ("every weekday at
// 9 remind me to check the board"). "@cndctr ..." in VEIL's address bar opens
// the panel and runs the command. Tasks belong to your Cumulus://ID account,
// so sign-in is required to run them.
//
// Actions: remind (posts to your activity feed), note (saves a note), and ask
// SCALVS.ai (asks on your behalf and posts the answer).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, readBody, jsonStore, randomToken, listen } from "../../infinitum-common/http.mjs";
import { createInfinitumApp } from "../../infinitum-common/app-server.mjs";
import { parseCommand, nextRun, describeSchedule, describeAction, validTimeZone, HELP } from "./commands.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_TASKS = 50;
const MAX_ACTIVITY = 50;
const MAX_NOTES = 200;

export function createConductor({ publicUrl, issuer, clientSecret, dataDir, frameAncestors,
                                  scalvsUrl = process.env.SCALVS_INTERNAL_URL || "", scalvsToken = process.env.SCALVS_SERVICE_TOKEN || "",
                                  tickMs = 10_000, now = () => Date.now(), fetchImpl = fetch }) {
  const store = jsonStore(path.join(dataDir, "accounts.json"), { accounts: {} });
  const account = sub => (store.get().accounts[sub] ||= { tz: "UTC", tasks: [], notes: [], activity: [] });

  const log = (acct, text, kind = "info") => {
    acct.activity.unshift({ at: now(), kind, text });
    acct.activity.length = Math.min(acct.activity.length, MAX_ACTIVITY);
  };

  async function askScalvs(question) {
    if (!scalvsUrl) return "SCALVS.ai isn't linked to /CNDCTR/ on this server.";
    try {
      const r = await fetchImpl(`${scalvsUrl}/api/ask`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Token": scalvsToken },
        body: JSON.stringify({ messages: [{ role: "user", content: question }] }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return `SCALVS.ai couldn't answer: ${data.error || r.status}`;
      return data.reply || data.notice || "(No answer.)";
    } catch {
      return "SCALVS.ai couldn't be reached.";
    }
  }

  async function perform(acct, task) {
    const a = task.action;
    if (a.type === "remind") log(acct, `Reminder: ${a.text}`, "remind");
    else if (a.type === "note") {
      acct.notes.unshift({ at: now(), text: a.text });
      acct.notes.length = Math.min(acct.notes.length, MAX_NOTES);
      log(acct, `Saved note: ${a.text}`, "note");
    } else if (a.type === "ask") {
      log(acct, `SCALVS.ai — ${a.text}\n${await askScalvs(a.text)}`, "ask");
    }
  }

  /** Run every task that is due. Exposed for tests. */
  async function tick() {
    const t = now();
    let changed = false;
    for (const acct of Object.values(store.get().accounts)) {
      for (const task of [...acct.tasks]) {
        if (task.next === null || task.next > t) continue;
        await perform(acct, task);
        task.next = task.schedule.type === "once" ? null : nextRun(task.schedule, t, acct.tz);
        if (task.next === null) acct.tasks = acct.tasks.filter(x => x !== task);
        changed = true;
      }
    }
    if (changed) store.save();
  }
  const timer = tickMs ? setInterval(() => tick().catch(err => console.error("[cndctr]", err)), tickMs) : null;
  timer?.unref();

  const view = acct => ({
    tz: acct.tz,
    tasks: acct.tasks.map((t, i) => ({ n: i + 1, text: `${describeAction(t.action)} ${describeSchedule(t.schedule, acct.tz)}`,
                                       next: t.next })),
    activity: acct.activity.slice(0, 20),
  });

  async function run(acct, text) {
    const c = parseCommand(text, now(), acct.tz);
    if (c.kind === "help") return HELP;
    if (c.kind === "error") return c.message;
    if (c.kind === "list") {
      if (!acct.tasks.length) return "No scheduled tasks.";
      return acct.tasks.map((t, i) => `${i + 1}. ${describeAction(t.action)}, ${describeSchedule(t.schedule, acct.tz)}`).join("\n");
    }
    if (c.kind === "notes") return acct.notes.length ? acct.notes.slice(0, 20).map(n => `• ${n.text}`).join("\n") : "No notes yet.";
    if (c.kind === "cancel") {
      const task = acct.tasks[c.n - 1];
      if (!task) return `There's no task ${c.n}. Type "list" to see them.`;
      acct.tasks.splice(c.n - 1, 1);
      return `Cancelled: ${describeAction(task.action)}.`;
    }
    // A task: run it now, or schedule it.
    const task = { id: randomToken(9), schedule: c.schedule, action: c.action, created: now(),
                   next: c.schedule.type === "once" ? c.schedule.at : nextRun(c.schedule, now(), acct.tz) };
    if (c.schedule.type === "once" && c.schedule.at <= now()) {
      await perform(acct, task);
      return acct.activity[0].text;
    }
    if (acct.tasks.length >= MAX_TASKS) return `You have ${MAX_TASKS} tasks already. Cancel one first.`;
    acct.tasks.push(task);
    return `Scheduled: I'll ${describeAction(c.action)} ${describeSchedule(c.schedule, acct.tz)}.`;
  }

  const app = createInfinitumApp({
    name: "cndctr", publicUrl, issuer, clientId: "cndctr", clientSecret, dataDir, frameAncestors,
    staticDir: path.join(HERE, "static"), fetchImpl,
    routes: ({ auth }) => [
      { method: "GET", path: "/api/state", handler: (req, res, ctx) => {
        const user = auth.user(ctx);
        json(res, 200, user ? { user, ...view(account(user.sub)) } : { user: null });
      } },
      { method: "POST", path: "/api/command", handler: async (req, res, ctx) => {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
        const user = auth.user(ctx);
        if (!user) return json(res, 401, { error: "Sign in with Cumulus://ID to run commands." });
        const body = await readBody(req);
        const acct = account(user.sub);
        if (typeof body.tz === "string" && validTimeZone(body.tz)) acct.tz = body.tz;
        const reply = await run(acct, String(body.text || ""));
        store.save();
        json(res, 200, { reply, ...view(acct) });
      } },
    ],
  });
  return { ...app, tick, run, account, stop: () => timer && clearInterval(timer) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CNDCTR_PORT || 8402);
  const { server } = createConductor({
    publicUrl: process.env.CNDCTR_URL || `http://localhost:${port}`, issuer: process.env.CID_ISSUER || "http://localhost:8400",
    clientSecret: process.env.CNDCTR_CLIENT_SECRET, dataDir: process.env.CNDCTR_DATA || path.join(HERE, "data"),
    frameAncestors: process.env.FRAME_ANCESTORS || "'none'",
  });
  listen(server, port).then(p => console.log(`/CNDCTR/ on port ${p}`));
}
