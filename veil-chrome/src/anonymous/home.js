"use strict";

(() => {
  const statusBox = document.getElementById("tor-status");
  const statusText = document.getElementById("tor-status-text");
  const bookmarks = document.getElementById("bookmarks");

  const STATUS_TEXT = {
    connected: "Connected to Tor",
    connecting: "Connecting to Tor…",
    error: "Not connected to Tor; browsing is paused",
    preview: "Preview mode",
  };

  VeilBridge.on("VEIL:TorStatus", ({ state }) => {
    const known = Object.prototype.hasOwnProperty.call(STATUS_TEXT, state);
    statusBox.dataset.state = known ? state : "unknown";
    statusText.textContent = known ? STATUS_TEXT[state] : "Tor status unknown";
  });

  VeilBridge.on("VEIL:Bookmarks", ({ items }) => {
    bookmarks.replaceChildren();
    if (!Array.isArray(items)) return;
    for (const item of items.slice(0, 12)) {
      // Text only: no favicons, which could trigger fetches or reveal
      // which sites are bookmarked.
      const a = document.createElement("a");
      a.className = "bookmark";
      a.href = item.url;
      a.rel = "noreferrer";
      a.textContent = item.title || item.url;
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
