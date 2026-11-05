// Shared front-end helpers for Infinitum apps in VEIL's side panel.
"use strict";

const Infinitum = (() => {
  /** A request typed in VEIL's address bar arrives as #prompt=... (never sent to a server). */
  function takePrompt() {
    const m = /^#prompt=(.*)$/.exec(location.hash);
    if (!m) return "";
    history.replaceState(null, "", location.pathname + location.search);
    try { return decodeURIComponent(m[1]).slice(0, 2000); } catch { return ""; }
  }

  /** Sign in with Cumulus://ID in a popup, so it works inside the side panel. */
  function signIn() {
    const w = window.open("/auth/login?popup=1", "cumulus-id", "popup,width=460,height=640");
    if (!w) location.href = "/auth/login";       // popups blocked: sign in in place
  }
  window.addEventListener("message", e => {
    if (e.origin === location.origin && e.data && e.data.type === "infinitum:signed-in") location.reload();
  });
  try {
    new BroadcastChannel("infinitum-auth").onmessage = e => {
      if (e.data && e.data.type === "infinitum:signed-in") location.reload();
    };
  } catch { /* old browser: the message above still works */ }

  async function api(path, body) {
    const r = await fetch(path, body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  /** Header: "Sign in" button, or the user's name and "Sign out". */
  function renderWho(el, user) {
    el.replaceChildren();
    if (user) {
      const name = document.createElement("span");
      name.className = "who";
      name.textContent = user.name || user.email;
      const out = document.createElement("a");
      out.className = "link-button";
      out.href = "/auth/logout";
      out.textContent = "Sign out";
      el.append(name, out);
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link-button";
      b.textContent = "Sign in with Cumulus://ID";
      b.addEventListener("click", signIn);
      el.append(b);
    }
  }

  function bubble(feed, kind, text) {
    feed.querySelector(".empty")?.remove();
    const d = document.createElement("div");
    d.className = `msg ${kind}`;
    d.textContent = text;
    feed.append(d);
    feed.scrollTop = feed.scrollHeight;
    return d;
  }

  /** Enter sends, Shift+Enter adds a line; the box grows with its text. */
  function composer(form, textarea, onSend) {
    const button = form.querySelector(".send");
    const sync = () => {
      button.disabled = !textarea.value.trim();
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
    };
    textarea.addEventListener("input", sync);
    textarea.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", e => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      textarea.value = "";
      sync();
      onSend(text);
    });
    sync();
  }

  return { takePrompt, signIn, api, renderWho, bubble, composer };
})();
