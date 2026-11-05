"use strict";
(async () => {
  const feed = document.getElementById("feed");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let user = null;
  let seen = 0;                      // newest activity time already shown

  function showTasks(tasks) {
    const box = document.getElementById("tasks");
    const list = document.getElementById("task-list");
    list.replaceChildren();
    for (const t of tasks || []) {
      const li = document.createElement("li");
      li.textContent = t.text;
      list.append(li);
    }
    box.hidden = !(tasks && tasks.length);
  }

  /** Show activity from scheduled runs that happened since we last looked. */
  function showNewActivity(activity) {
    const fresh = (activity || []).filter(a => a.at > seen).reverse();
    for (const a of fresh) if (seen) Infinitum.bubble(feed, "app", a.text);
    if (activity && activity.length) seen = Math.max(seen, activity[0].at);
  }

  async function refresh() {
    const s = await Infinitum.api("/api/state");
    user = s.user;
    Infinitum.renderWho(document.getElementById("who"), user);
    if (user) { showTasks(s.tasks); showNewActivity(s.activity); }
    return s;
  }

  async function run(text) {
    Infinitum.bubble(feed, "user", text);
    if (!user) {
      // Keep the command and run it as soon as sign-in finishes.
      try { sessionStorage.setItem("cndctr:pending", text); } catch { /* storage blocked */ }
      Infinitum.bubble(feed, "notice", "Sign in with Cumulus://ID to run this. It will run as soon as you're signed in.");
      return;
    }
    try {
      const r = await Infinitum.api("/api/command", { text, tz });
      Infinitum.bubble(feed, "app", r.reply);
      showTasks(r.tasks);
      if (r.activity && r.activity.length) seen = Math.max(seen, r.activity[0].at);
    } catch (err) {
      Infinitum.bubble(feed, "app error", err.message);
    }
  }

  Infinitum.composer(document.getElementById("cmd"), document.getElementById("q"), run);
  await refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 15000);   // pick up scheduled runs

  let pending = "";
  try {
    pending = sessionStorage.getItem("cndctr:pending") || "";
    if (user) sessionStorage.removeItem("cndctr:pending");    // keep it until signed in
  } catch { /* storage blocked */ }
  const prompt = Infinitum.takePrompt() || (user ? pending : "");   // from "@cndctr …", or held until sign-in
  if (prompt) run(prompt);
})();
