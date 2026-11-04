"use strict";

(() => {
  const statusBox = document.getElementById("tor-status");
  const statusText = document.getElementById("tor-status-text");

  const STATUS_TEXT = {
    connected: "Connected over Tor",
    connecting: "Connecting to Tor…",
    error: "Tor unavailable; only sites you switched to direct will load",
    preview: "Preview mode",
  };

  VeilBridge.on("VEIL:TorStatus", ({ state }) => {
    const known = Object.prototype.hasOwnProperty.call(STATUS_TEXT, state);
    statusBox.dataset.state = known ? state : "unknown";
    statusText.textContent = known ? STATUS_TEXT[state] : "Connection status unknown";
  });

  // App buttons in the top bar, from the bundled, signed registry.
  const launcher = document.getElementById("launcher");
  const apps = (typeof VEIL_REGISTRY === "object" && Array.isArray(VEIL_REGISTRY.apps))
    ? VEIL_REGISTRY.apps : [];
  for (const app of apps) {
    if (typeof app.url !== "string" || !app.url.startsWith("https://")) continue;
    const a = document.createElement("a");
    a.className = "app";
    a.href = app.url;
    a.rel = "noreferrer";
    a.title = `${app.name} · ${app.summary}`;
    a.setAttribute("aria-label", app.name);
    const icon = document.createElement("span");
    icon.className = "app-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = app.mark || app.name.replace(/[^A-Za-z0-9Æ]/g, "").slice(0, 2);
    a.append(icon);
    launcher.append(a);
  }

  VeilBridge.on("VEIL:Bookmarks", ({ items }) => {
    const box = document.getElementById("bookmarks");
    box.replaceChildren();
    if (!Array.isArray(items)) return;
    for (const item of items.slice(0, 12)) {
      const a = document.createElement("a");
      a.className = "bookmark";
      a.href = item.url;
      a.rel = "noreferrer";
      a.textContent = item.title || item.url;
      box.append(a);
    }
  });

  document.getElementById("switch-workspace").addEventListener("click", () =>
    VeilBridge.send("VEIL:SwitchWorkspace", { to: "anonymous" }));

  VeilBridge.send("VEIL:GetTorStatus");
  VeilBridge.send("VEIL:GetBookmarks");
})();
