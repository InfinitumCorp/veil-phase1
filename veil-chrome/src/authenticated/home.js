"use strict";

(() => {
  const statusBox = document.getElementById("tor-status");
  const statusText = document.getElementById("tor-status-text");

  const STATUS_TEXT = {
    connected: "Connected over Tor (signed in, so not anonymous)",
    connecting: "Connecting to Tor…",
    error: "Tor is unavailable. Sites you have switched to direct still load; others wait for Tor.",
    preview: "Preview mode: connection status appears in the VEIL browser",
  };

  VeilBridge.on("VEIL:TorStatus", ({ state }) => {
    const known = Object.prototype.hasOwnProperty.call(STATUS_TEXT, state);
    statusBox.dataset.state = known ? state : "unknown";
    statusText.textContent = known ? STATUS_TEXT[state] : "Connection status unknown";
  });

  function tile(href, title, sub) {
    const a = document.createElement("a");
    a.className = "tile";
    a.href = href;
    a.rel = "noreferrer";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = sub;
    a.append(strong, span);
    return a;
  }

  // Launcher: from the bundled registry (generated/registry.js).
  const launcher = document.getElementById("launcher");
  const apps = (typeof VEIL_REGISTRY === "object" && Array.isArray(VEIL_REGISTRY.apps))
    ? VEIL_REGISTRY.apps : [];
  if (apps.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "App list unavailable in this build.";
    launcher.append(p);
  }
  for (const app of apps) {
    if (typeof app.url === "string" && app.url.startsWith("https://")) {
      launcher.append(tile(app.url, app.name, app.summary));
    }
  }

  VeilBridge.on("VEIL:Bookmarks", ({ items }) => {
    const box = document.getElementById("bookmarks");
    box.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No bookmarks yet.";
      box.append(p);
      return;
    }
    for (const item of items.slice(0, 24)) {
      let host = "";
      try { host = new URL(item.url).host; } catch { /* keep empty */ }
      box.append(tile(item.url, item.title || item.url, host));
    }
  });

  document.getElementById("switch-workspace").addEventListener("click", () =>
    VeilBridge.send("VEIL:SwitchWorkspace", { to: "anonymous" }));

  VeilBridge.send("VEIL:GetTorStatus");
  VeilBridge.send("VEIL:GetBookmarks");
})();
