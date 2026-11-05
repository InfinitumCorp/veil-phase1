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
  // Only https:// links. The one exception is the local prototype: when this
  // page itself is served from localhost (never true inside VEIL, where it is
  // a built-in page), http://localhost links are allowed too.
  const devLoopback = location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(location.hostname);
  const isHttps = url => typeof url === "string" &&
    (url.startsWith("https://") || (devLoopback && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)));

  // ---- Sign In (top right) ---------------------------------------------
  // Signing in uses Cumulus://ID. It still goes over Tor, so the user's IP
  // address and location stay hidden; only the Infinitum service they sign
  // in to learns who they are. New identity signs them out everywhere.
  const signin = document.getElementById("signin");
  const workspace = document.getElementById("workspace");
  if (registry.signin && isHttps(registry.signin.url)) {
    signin.href = registry.signin.url;
    signin.textContent = registry.signin.label || "Sign In";
    signin.title = "Sign in with Cumulus://ID";
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
      signin.title = "Sign in with Cumulus://ID";
      workspace.textContent = "Anonymous";
    }
  });

  // ---- Infinitum apps ----------------------------------------------------
  // From the bundled, signed registry, in alphabetical order: letters and
  // digits only, so + / ( ) and trademark signs are ignored and Æ sorts as
  // AE (the registry tool uses the same rule). Plain links: nothing is
  // fetched until the user clicks one, and then it loads over Tor.
  const sortKey = name => name.replace(/Æ/g, "AE").replace(/æ/g, "ae")
    .normalize("NFKD").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
  const apps = (Array.isArray(registry.apps) ? registry.apps : [])
    .filter(app => typeof app.name === "string" && isHttps(app.url))
    .slice()
    .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));

  // Apps marked "panel" open in VEIL's side panel, next to the current page,
  // like ChatGPT's sidebar; clicking again closes it. Only the app id is
  // sent: the browser takes the address from its own copy of the signed
  // registry. Other apps, and every app outside VEIL, open as links.
  function appLink(app, className) {
    const a = document.createElement("a");
    a.className = className;
    a.href = app.url;
    a.rel = "noreferrer";
    a.addEventListener("click", event => {
      if (app.panel === true && VeilBridge.native && typeof app.id === "string") {
        event.preventDefault();
        closeApps();
        VeilBridge.send("VEIL:OpenAppPanel", { id: app.id });
      }
    });
    return a;
  }

  // Bottom row: the apps that run in the side panel, plus any marked
  // "footer" (FABRIC), which open as links.
  const launcher = document.getElementById("launcher");
  for (const app of apps.filter(a => a.panel === true || a.footer === true)) {
    const a = appLink(app, "app-link");
    a.title = app.summary;
    a.textContent = app.name;
    launcher.append(a);
  }

  // Top right: "Mail", and "Apps" with every consumer app.
  const mail = document.getElementById("mail");
  if (registry.mail && isHttps(registry.mail.url)) {
    mail.href = registry.mail.url;
    mail.textContent = registry.mail.label || "Mail";
    mail.title = "Cumulus://Mail";
    mail.hidden = false;
  }

  const appsButton = document.getElementById("apps-button");
  const appsPanel = document.getElementById("apps-panel");
  for (const app of apps) {
    const a = appLink(app, "menu-app");
    a.setAttribute("role", "menuitem");
    const name = document.createElement("span");
    name.className = "menu-app-name";
    name.textContent = app.name;
    const summary = document.createElement("span");
    summary.className = "menu-app-summary";
    summary.textContent = app.panel === true ? `${app.summary} · opens beside the page` : app.summary;
    a.append(name, summary);
    appsPanel.append(a);
  }
  appsButton.hidden = !apps.length;

  function closeApps() {
    appsPanel.hidden = true;
    appsButton.setAttribute("aria-expanded", "false");
  }
  appsButton.addEventListener("click", event => {
    event.stopPropagation();
    const open = appsPanel.hidden;
    appsPanel.hidden = !open;
    appsButton.setAttribute("aria-expanded", String(open));
    if (open) appsPanel.querySelector("a")?.focus();
  });
  document.addEventListener("click", event => {
    if (!appsPanel.hidden && !appsPanel.contains(event.target)) closeApps();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !appsPanel.hidden) { closeApps(); appsButton.focus(); }
  });

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
