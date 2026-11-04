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

  // App names in the top bar, styled like the Infinitum site navigation,
  // from the bundled, signed registry.
  const launcher = document.getElementById("launcher");
  const apps = (typeof VEIL_REGISTRY === "object" && Array.isArray(VEIL_REGISTRY.apps))
    ? VEIL_REGISTRY.apps : [];
  for (const app of apps) {
    if (typeof app.url !== "string" || !app.url.startsWith("https://")) continue;
    const a = document.createElement("a");
    a.className = "app-link";
    a.href = app.url;
    a.rel = "noreferrer";
    a.title = app.summary;
    a.textContent = app.name;
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

  VeilBridge.send("VEIL:GetTorStatus");
  VeilBridge.send("VEIL:GetBookmarks");
})();
