"use strict";

(() => {
  const statusBox = document.getElementById("tor-status");
  const statusText = document.getElementById("tor-status-text");
  const bookmarks = document.getElementById("bookmarks");

  const STATUS_TEXT = {
    connected: "Connected to Tor",
    connecting: "Connecting to Tor…",
    error: "Not connected to Tor. Browsing is paused until Tor reconnects.",
    preview: "Preview mode: Tor status appears in the VEIL browser",
  };

  VeilBridge.on("VEIL:TorStatus", ({ state }) => {
    const known = Object.prototype.hasOwnProperty.call(STATUS_TEXT, state);
    statusBox.dataset.state = known ? state : "unknown";
    statusText.textContent = known ? STATUS_TEXT[state] : "Tor status unknown";
  });

  VeilBridge.on("VEIL:Bookmarks", ({ items }) => {
    bookmarks.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No bookmarks yet.";
      bookmarks.append(p);
      return;
    }
    for (const item of items.slice(0, 24)) {
      // Only text and the URL are used: no favicons, which could trigger
      // network fetches or leak which sites are bookmarked.
      const a = document.createElement("a");
      a.className = "tile";
      a.href = item.url;
      a.rel = "noreferrer";
      const strong = document.createElement("strong");
      strong.textContent = item.title || item.url;
      const span = document.createElement("span");
      try { span.textContent = new URL(item.url).host; } catch { span.textContent = ""; }
      a.append(strong, span);
      bookmarks.append(a);
    }
  });

  document.getElementById("new-identity").addEventListener("click", () => VeilBridge.send("VEIL:NewIdentity"));
  document.getElementById("new-circuit").addEventListener("click", () => VeilBridge.send("VEIL:NewCircuit"));
  document.getElementById("switch-workspace").addEventListener("click", () =>
    VeilBridge.send("VEIL:SwitchWorkspace", { to: "authenticated" }));

  VeilBridge.send("VEIL:GetTorStatus");
  VeilBridge.send("VEIL:GetBookmarks");
})();
