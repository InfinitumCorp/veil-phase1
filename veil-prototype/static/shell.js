// VEIL prototype shell. Uses VEIL's real browser modules for the side panel,
// address-bar commands and Cumulus://ID sign-in.
import { AppPanel } from "/modules/VeilAppPanel.sys.mjs";
import { suggestion, run as runCommand, parse as parseCommand, COMMANDS } from "/modules/VeilAppCommands.sys.mjs";
import { CumulusID } from "/modules/VeilCumulusID.sys.mjs";
import { VeilSignIn } from "/modules/VeilSignIn.sys.mjs";
import { decide, parseGeoSite, readExtraBlocking, SETTING_KEY, EXTRA_BLOCK_CATEGORIES, LOCAL_GEOSITE_PATH } from "/modules/VeilGeoData.sys.mjs";

const registry = await (await fetch("/registry.json")).json();
const START = "/start/home/home.html";
const $ = id => document.getElementById(id);

// ---- toast ------------------------------------------------------------------
let toastTimer;
function toast(text, ms = 4500) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- titles -------------------------------------------------------------------
const origins = new Map(registry.apps.map(a => [new URL(a.url).origin, a.name]));
if (registry.signin?.cid) origins.set(new URL(registry.signin.cid.issuer).origin, "Cumulus://ID");
function titleFor(url) {
  if (url === START) return "New tab";
  try {
    const u = new URL(url, location.href);
    if (u.pathname === "/veil/callback" && u.origin === location.origin) return "Signing in…";
    return origins.get(u.origin) || u.hostname;
  } catch { return url; }
}
const favFor = title => title === "New tab" ? "</>" : (title.replace(/[^A-Za-z0-9]/g, "")[0] || "·").toUpperCase();

// ---- tabs ---------------------------------------------------------------------
const tabs = [];
let active = null;

function renderTabs() {
  const strip = $("tabs");
  strip.replaceChildren();
  for (const tab of tabs) {
    const b = document.createElement("div");
    b.className = "tab" + (tab === active ? " active" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(tab === active));
    b.tabIndex = 0;
    const fav = document.createElement("span"); fav.className = "fav"; fav.textContent = favFor(tab.title);
    const title = document.createElement("span"); title.className = "title"; title.textContent = tab.title;
    const x = document.createElement("span"); x.className = "x"; x.textContent = "×"; x.title = "Close tab";
    x.addEventListener("click", e => { e.stopPropagation(); closeTab(tab); });
    b.append(fav, title, x);
    b.addEventListener("click", () => activate(tab));
    b.addEventListener("keydown", e => { if (e.key === "Enter") activate(tab); });
    strip.append(b);
  }
}

function syncToolbar() {
  $("back").disabled = !active || active.index <= 0;
  $("forward").disabled = !active || active.index >= active.history.length - 1;
  const url = active ? active.history[active.index] : "";
  if (document.activeElement !== $("address")) $("address").value = url === START ? "" : url;
}

function newTab(url = START, { activate: focus = true } = {}) {
  const frame = document.createElement("iframe");
  frame.title = "Page";
  const tab = { frame, history: [url], index: 0, title: titleFor(url) };
  frame.src = url;
  frame.hidden = true;
  $("pages").append(frame);
  tabs.push(tab);
  if (focus) activate(tab); else renderTabs();
  return tab;
}

function activate(tab) {
  active = tab;
  for (const t of tabs) t.frame.hidden = t !== tab;
  renderTabs();
  syncToolbar();
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.frame.remove();
  if (!tabs.length) return newTab();
  if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

function navigate(tab, url) {
  tab.history = tab.history.slice(0, tab.index + 1);
  tab.history.push(url);
  tab.index++;
  tab.frame.src = url;
  tab.title = titleFor(url);
  renderTabs();
  syncToolbar();
}

$("new-tab").addEventListener("click", () => { newTab(); $("address").focus(); });
$("back").addEventListener("click", () => step(-1));
$("forward").addEventListener("click", () => step(1));
$("reload").addEventListener("click", () => { if (active) active.frame.src = active.history[active.index]; });
function step(d) {
  if (!active) return;
  const i = active.index + d;
  if (i < 0 || i >= active.history.length) return;
  active.index = i;
  active.frame.src = active.history[i];
  active.title = titleFor(active.history[i]);
  renderTabs();
  syncToolbar();
}

// ---- side panel (VeilAppPanel) --------------------------------------------------
const panelEl = $("panel"), panelFrame = $("panel-frame"), splitter = $("splitter");
const appPanel = new AppPanel({
  registry, allowLoopbackHttp: true,               // localhost only; the real browser never allows http
  panel: {
    show({ url, title }) {
      $("panel-title").textContent = title;
      panelFrame.src = url;
      panelEl.hidden = false;
      splitter.hidden = false;
    },
    hide() {
      panelFrame.src = "about:blank";
      panelEl.hidden = true;
      splitter.hidden = true;
    },
    setWidth(px) { panelEl.style.width = `${px}px`; },
  },
});
$("panel-close").addEventListener("click", () => appPanel.close());
$("panel-tab").addEventListener("click", () => {
  const app = registry.apps.find(a => a.id === appPanel.openId);
  if (app) { appPanel.close(); newTab(app.url); }
});
splitter.addEventListener("pointerdown", e => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  document.querySelector(".content").classList.add("resizing");
});
splitter.addEventListener("pointermove", e => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  appPanel.resize(window.innerWidth - e.clientX);
});
splitter.addEventListener("pointerup", e => {
  splitter.releasePointerCapture(e.pointerId);
  splitter.classList.remove("dragging");
  document.querySelector(".content").classList.remove("resizing");
});
splitter.addEventListener("keydown", e => {
  if (e.key === "ArrowLeft") appPanel.resize(appPanel.width + 20);
  if (e.key === "ArrowRight") appPanel.resize(appPanel.width - 20);
});

// ---- sign in with Cumulus://ID (VeilSignIn + VeilCumulusID) --------------------
const cumulusId = new CumulusID({ registry, openTab: url => newTab(url), fetch: (u, i) => fetch(u, i), allowLoopbackHttp: true });

function startPages() {
  return tabs.filter(t => t.history[t.index] === START).map(t => t.frame.contentWindow).filter(Boolean);
}
function reply(win, name, data) { win.postMessage({ veil: "rpm-reply", name, data }, location.origin); }

VeilSignIn.subscribe(account => {
  for (const win of startPages()) reply(win, "VEIL:Account", account);
  $("chip-text").textContent = account.signedIn ? "Signed in" : "Anonymous";
  $("chip").title = account.signedIn
    ? `Signed in to Cumulus://ID as ${account.name}. In VEIL your IP address stays hidden by Tor.`
    : "Every connection goes over Tor in VEIL. This prototype runs on your machine without Tor.";
});

// ---- messages from the start page and the sign-in callback -----------------------
window.addEventListener("message", async e => {
  if (e.origin !== location.origin) return;
  const tab = tabs.find(t => t.frame.contentWindow === e.source);
  if (!tab) return;
  const m = e.data || {};

  if (m.veil === "cid-callback") {
    if (!cumulusId.isRedirect(m.url)) return;
    closeTab(tab);
    try {
      const account = await VeilSignIn.finish({ cumulusId, address: m.url });
      toast(`Signed in with Cumulus://ID as ${account.name}.`);
    } catch (err) {
      toast(`Sign-in didn't finish: ${err.message}`);
    }
    return;
  }
  if (m.veil !== "rpm") return;
  try {
    switch (m.name) {
      case "VEIL:GetTorStatus": reply(e.source, "VEIL:TorStatus", { state: "preview" }); break;
      case "VEIL:GetBookmarks": reply(e.source, "VEIL:Bookmarks", { items: [] }); break;
      case "VEIL:GetAccount": reply(e.source, "VEIL:Account", VeilSignIn.account()); break;
      case "VEIL:OpenSignIn": await VeilSignIn.open({ registry, openTab: url => newTab(url), cumulusId }); break;
      case "VEIL:OpenAppPanel": appPanel.handle({ name: m.name, data: m.data }); break;
      case "VEIL:NewIdentity": newIdentity(); break;
      case "VEIL:NewCircuit": toast("This prototype doesn't use Tor, so there's no circuit to change. In VEIL this picks a new route for the site."); break;
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---- New identity ------------------------------------------------------------------
function newIdentity() {
  if (!confirm("New identity closes every tab and the app panel and signs you out. Continue?")) return;
  appPanel.onNewIdentity();
  VeilSignIn.onNewIdentity(cumulusId);
  for (const t of [...tabs]) { t.frame.remove(); }
  tabs.length = 0;
  newTab();
  toast("New identity: tabs closed, panel closed, signed out.");
}
$("new-identity").addEventListener("click", newIdentity);

// ---- menu ---------------------------------------------------------------------------
const menu = $("menu"), menuButton = $("menu-button");
const setMenu = open => { menu.hidden = !open; menuButton.setAttribute("aria-expanded", String(open)); };
menuButton.addEventListener("click", e => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
menu.addEventListener("click", e => {
  if (e.target.closest(".menu-setting")) return;
  const cmd = e.target.closest("button")?.dataset.cmd;
  setMenu(false);
  if (cmd === "scalvs" || cmd === "cndctr") appPanel.openWithPrompt(cmd, "");
  if (cmd === "circuit") toast("This prototype doesn't use Tor, so there's no circuit to change.");
  if (cmd === "about") toast("VEIL prototype: VEIL's real start page, side panel, @commands and Cumulus://ID sign-in, running on this machine. Pages here don't go over Tor; in VEIL every connection does.", 9000);
});

// ---- address bar: @commands (VeilAppCommands), addresses, search ----------------------
const address = $("address"), list = $("suggest");
let rows = [], selected = 0;

const ICON = { scalvs: "S", cndctr: "C" };
const NAMES = Object.fromEntries(registry.apps.map(a => [a.id, a.name]));
const VERB = { scalvs: "Ask", cndctr: "Run a command in" };

function looksLikeAddress(text) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || (/^[^\s]+\.[^\s]{2,}$/.test(text) && !text.startsWith("@"));
}
function toUrl(text) {
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;      // only http(s) pages open in tabs
  return `https://${text}`;
}

function buildRows(value) {
  const v = value.trim();
  if (!v) return [];
  const out = [];
  const s = suggestion(v, registry);
  if (s) {
    out.push({ icon: ICON[s.id], html: s.label, hint: "Opens in side panel", run: () => runCommand(v, appPanel), command: true });
  } else if (v.startsWith("@")) {
    const typed = v.slice(1).split(/\s/)[0].toLowerCase();
    for (const [id, words] of Object.entries(COMMANDS)) {
      if (!NAMES[id]) continue;
      const word = words.find(w => w.startsWith(typed));
      if (word) out.push({ icon: ICON[id], html: `@${word}`, hint: `${VERB[id]} ${NAMES[id]}`, complete: `@${word} `, command: true });
    }
  }
  if (!out.length || !out[0].command) {
    if (looksLikeAddress(v)) {
      const url = toUrl(v);
      if (url) out.push({ icon: "↗", html: url, hint: "Open", run: () => go(url) });
    }
    out.push({ icon: "⌕", html: `Search for “${v}”`, hint: "DuckDuckGo", run: () => go(`https://duckduckgo.com/?q=${encodeURIComponent(v)}`) });
  }
  return out;
}

function showRows() {
  list.replaceChildren();
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === selected));
    const fav = document.createElement("span"); fav.className = "fav"; fav.textContent = r.icon;
    const label = document.createElement("span"); label.textContent = r.html;
    const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = r.hint;
    li.append(fav, label, hint);
    li.addEventListener("mousedown", e => { e.preventDefault(); choose(i); });
    list.append(li);
  });
  if (rows.some(r => r.command)) {
    const foot = document.createElement("li");
    foot.className = "foot";
    foot.textContent = "Commands run in VEIL. They are never sent to a search engine or saved.";
    list.append(foot);
  }
  list.hidden = !rows.length;
}

function choose(i) {
  const r = rows[i];
  if (!r) return;
  if (r.complete) {
    address.value = r.complete;
    address.dispatchEvent(new Event("input"));
    return;
  }
  hideRows();
  address.blur();
  r.run();
  syncToolbar();
}
function hideRows() { rows = []; list.hidden = true; }

// Extra geosite blocking. Off unless the user turns it on. The list is a
// local file; a blocked address is never requested.
let geoLists = null;
let geoLoad = null;

function loadGeoLists() {
  if (!readExtraBlocking(localStorage)) return Promise.resolve(null);
  if (geoLists) return Promise.resolve(geoLists);
  if (!geoLoad) {
    geoLoad = (async () => {
      try {
        const res = await fetch(LOCAL_GEOSITE_PATH);
        if (!res.ok) {
          toast("Extra ad and tracker blocking is on, but the local geosite list is not installed. Nothing was contacted.");
          geoLoad = null;
          return null;
        }
        geoLists = parseGeoSite(new Uint8Array(await res.arrayBuffer()), { keep: EXTRA_BLOCK_CATEGORIES });
        return geoLists;
      } catch {
        geoLists = null;
        geoLoad = null;
        toast("The local geosite list could not be read. Extra blocking is staying inactive.");
        return null;
      }
    })();
  }
  return geoLoad;
}

function navigationBlocked(url) {
  if (!readExtraBlocking(localStorage)) return false;
  if (!geoLists) return false;
  let hostname = "";
  try { hostname = new URL(url, location.href).hostname; } catch { return false; }
  const decision = decide({ hostname, geosite: geoLists, extraBlocking: true });
  if (decision.block !== true) return false;
  toast(`Blocked ${hostname} (${decision.category}). The local list matched; nothing was looked up or contacted.`);
  return true;
}

const geoToggle = $("geosite-extra");
geoToggle.checked = readExtraBlocking(localStorage);
geoToggle.addEventListener("change", () => {
  try { localStorage.setItem(SETTING_KEY, geoToggle.checked ? "1" : "0"); }
  catch { /* storage unavailable: the switch stays off in readExtraBlocking */ }
  if (readExtraBlocking(localStorage)) loadGeoLists();
});
if (geoToggle.checked) loadGeoLists();

function go(url) {
  if (navigationBlocked(url)) return;
  if (!active) newTab(url); else navigate(active, url);
}

address.addEventListener("input", () => { rows = buildRows(address.value); selected = 0; showRows(); });
address.addEventListener("focus", () => address.select());
address.addEventListener("blur", () => setTimeout(() => { hideRows(); syncToolbar(); }, 120));
address.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); selected = (selected + 1) % rows.length; showRows(); }
  if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); selected = (selected - 1 + rows.length) % rows.length; showRows(); }
  if (e.key === "Escape") { hideRows(); address.blur(); }
});
$("omnibox").addEventListener("submit", e => {
  e.preventDefault();
  const v = address.value.trim();
  if (!v) return;
  if (parseCommand(v)) {                                   // @scalvs … / @cndctr …
    hideRows();
    address.value = "";
    address.blur();
    try { runCommand(v, appPanel); } catch (err) { toast(err.message); }
    return;
  }
  if (!rows.length) rows = buildRows(v);
  choose(selected);
});

// ---- keyboard shortcuts ---------------------------------------------------------------------
document.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "t") { e.preventDefault(); newTab(); address.focus(); }
  if (mod && e.key.toLowerCase() === "w") { e.preventDefault(); if (active) closeTab(active); }
  if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); address.focus(); }
});

newTab();
window.veilPrototype = { tabs, appPanel, cumulusId, VeilSignIn, geoReady: () => geoLists !== null };
