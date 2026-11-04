"use strict";

(() => {
  const statusBox = document.getElementById("tor-status");
  const statusText = document.getElementById("tor-status-text");

  // VEIL never falls back to a direct connection, so "not connected" means
  // nothing loads until Tor is back.
  const STATUS_TEXT = {
    connected: "Connected to Tor",
    connecting: "Connecting to Tor…",
    error: "Not connected to Tor; browsing is paused until Tor reconnects",
    blocked: "Tor settings were changed; VEIL is offline to protect you",
    preview: "Preview mode",
  };

  VeilBridge.on("VEIL:TorStatus", ({ state }) => {
    const known = Object.prototype.hasOwnProperty.call(STATUS_TEXT, state);
    statusBox.dataset.state = known ? state : "unknown";
    statusText.textContent = known ? STATUS_TEXT[state] : "Tor status unknown";
  });

  const registry = (typeof VEIL_REGISTRY === "object" && VEIL_REGISTRY) || {};
  const isHttps = url => typeof url === "string" && url.startsWith("https://");

  // ---- Sign In (top right) ---------------------------------------------
  // Signing in uses Cumulus://ID. It still goes over Tor, so the user's IP
  // address and location stay hidden; only the Infinitum service they sign
  // in to learns who they are. New identity signs them out everywhere.
  const signin = document.getElementById("signin");
  const workspace = document.getElementById("workspace");
  if (registry.signin && isHttps(registry.signin.url)) {
    signin.href = registry.signin.url;
    signin.textContent = registry.signin.label || "Sign In";
    signin.hidden = false;
    signin.addEventListener("click", event => {
      // Inside VEIL, the browser opens its own copy of the sign-in address
      // in a new tab. Outside VEIL (preview), the link works as a link.
      if (VeilBridge.native) {
        event.preventDefault();
        VeilBridge.send("VEIL:OpenSignIn");
      }
    });
  }

  VeilBridge.on("VEIL:Account", ({ signedIn, name }) => {
    if (signedIn) {
      signin.textContent = "Signed in";
      signin.title = typeof name === "string" && name ? `${name} · Cumulus://ID` : "Cumulus://ID";
      workspace.textContent = "Signed in · IP hidden by Tor";
    } else {
      signin.textContent = (registry.signin && registry.signin.label) || "Sign In";
      signin.removeAttribute("title");
      workspace.textContent = "Anonymous";
    }
  });

  // ---- Infinitum apps (bottom) ------------------------------------------
  // From the bundled, signed registry, in alphabetical order: letters and
  // digits only, so + / ( ) and trademark signs are ignored and Æ sorts as
  // AE (the registry tool uses the same rule). Plain links: nothing is
  // fetched until the user clicks one, and then it loads over Tor.
  const sortKey = name => name.replace(/Æ/g, "AE").replace(/æ/g, "ae")
    .normalize("NFKD").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
  const launcher = document.getElementById("launcher");
  const apps = (Array.isArray(registry.apps) ? registry.apps : [])
    .filter(app => typeof app.name === "string")
    .slice()
    .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  for (const app of apps) {
    if (!isHttps(app.url)) continue;
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
      // Text only: no favicons, which could trigger fetches or reveal
      // which sites are bookmarked.
      const a = document.createElement("a");
      a.className = "bookmark";
      a.href = item.url;
      a.rel = "noreferrer";
      a.textContent = item.title || item.url;
      box.append(a);
    }
  });

  document.getElementById("new-identity").addEventListener("click", () => VeilBridge.send("VEIL:NewIdentity"));
  document.getElementById("new-circuit").addEventListener("click", () => VeilBridge.send("VEIL:NewCircuit"));

  VeilBridge.send("VEIL:GetTorStatus");
  VeilBridge.send("VEIL:GetBookmarks");
  VeilBridge.send("VEIL:GetAccount");
})();
