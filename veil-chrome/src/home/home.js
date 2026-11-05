"use strict";

(() => {
  const registry = (typeof VEIL_REGISTRY === "object" && VEIL_REGISTRY) || {};
  const isHttps = url => typeof url === "string" && url.startsWith("https://");

  // ---- Sign In (top right) ---------------------------------------------
  // Signing in uses Cumulus://ID. It still goes over Tor, so the user's IP
  // address and location stay hidden; only the Infinitum service they sign
  // in to learns who they are. New identity (in the browser toolbar) signs
  // them out everywhere. Tor status also lives in the browser toolbar.
  const signin = document.getElementById("signin");
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
    } else {
      signin.textContent = (registry.signin && registry.signin.label) || "Sign In";
      signin.removeAttribute("title");
    }
  });

  // ---- Cumulus://Mail and Cumulus://Cloud (top left) ---------------------
  const shortcuts = document.getElementById("shortcuts");
  for (const sc of Array.isArray(registry.shortcuts) ? registry.shortcuts : []) {
    if (!isHttps(sc.url) || typeof sc.label !== "string") continue;
    const a = document.createElement("a");
    a.className = "nav-link";
    a.href = sc.url;
    a.rel = "noreferrer";
    a.textContent = sc.label;
    shortcuts.append(a);
  }

  // ---- Infinitum products menu (top left corner) ------------------------
  // From the bundled, signed registry, in alphabetical order: letters and
  // digits only, so + / ( ) and trademark signs are ignored and Æ sorts as
  // AE (the registry tool uses the same rule). Plain links: nothing is
  // fetched until the user clicks one, and then it loads over Tor.
  const sortKey = name => name.replace(/Æ/g, "AE").replace(/æ/g, "ae")
    .normalize("NFKD").replace(/[^0-9A-Za-z]/g, "").toLowerCase();
  const launcher = document.getElementById("launcher");
  const appsButton = document.getElementById("apps-button");
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
    const name = document.createElement("span");
    name.className = "app-name";
    name.textContent = app.name;
    const summary = document.createElement("span");
    summary.className = "app-summary";
    summary.textContent = typeof app.summary === "string" ? app.summary : "";
    a.append(name, summary);
    launcher.append(a);
  }
  if (!launcher.childElementCount) appsButton.hidden = true;

  const setMenu = open => {
    launcher.hidden = !open;
    appsButton.setAttribute("aria-expanded", String(open));
  };
  appsButton.addEventListener("click", event => {
    event.stopPropagation();
    const open = launcher.hidden;
    setMenu(open);
    if (open) launcher.querySelector("a")?.focus();
  });
  document.addEventListener("click", event => {
    if (!launcher.hidden && !launcher.contains(event.target)) setMenu(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !launcher.hidden) {
      setMenu(false);
      appsButton.focus();
    }
  });
  VeilBridge.send("VEIL:GetAccount");
})();
