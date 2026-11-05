/* VEIL side panel: a docked web view for /CNDCTR/ and SCALVS.ai (patch 0002).
 *
 * Builds, per browser window, a resizable panel to the right of the page
 * area and gives VeilAppPanel the { show, hide, setWidth } object it drives.
 *
 * The panel is an ordinary remote content <browser>:
 *  - it loads over Tor like every tab, isolated by first-party domain;
 *  - it is excluded from global history (disableglobalhistory);
 *  - its page has no chrome privileges and can't reach VEIL internals;
 *  - links that try to open new windows open as normal tabs.
 */
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export function createSidePanel(win, { onClose, onOpenInTab, onResize }) {
  const doc = win.document;
  const container = doc.getElementById("browser");          // hbox: sidebar | appcontent
  const make = (tag, attrs = {}) => {
    const el = doc.createElementNS(XUL_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  const splitter = make("splitter", { id: "veil-panel-splitter", resizebefore: "flex", resizeafter: "none", hidden: "true" });
  const box = make("vbox", { id: "veil-panel", hidden: "true" });
  const bar = make("hbox", { id: "veil-panel-bar", align: "center", pack: "end" });
  const openInTab = make("toolbarbutton", { id: "veil-panel-open", class: "toolbarbutton-1", tooltiptext: "Open in a new tab" });
  const close = make("toolbarbutton", { id: "veil-panel-close", class: "toolbarbutton-1 close-icon", tooltiptext: "Close panel" });
  const browser = make("browser", {
    id: "veil-panel-browser", type: "content", remote: "true", maychangeremoteness: "true",
    disableglobalhistory: "true", messagemanagergroup: "veil-panel", flex: "1", autocompletepopup: "PopupAutoComplete",
  });
  bar.append(openInTab, close);
  box.append(bar, browser);
  container.append(splitter, box);

  close.addEventListener("command", () => onClose());
  openInTab.addEventListener("command", () => onOpenInTab(browser.currentURI?.spec));
  splitter.addEventListener("mouseup", () => onResize(box.getBoundingClientRect().width));

  return {
    show({ url }) {
      box.hidden = false;
      splitter.hidden = false;
      browser.fixupAndLoadURIString(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        // No referrer: the app learns nothing about the page beside it.
        referrerInfo: null,
      });
    },
    hide() {
      browser.loadURI(Services.io.newURI("about:blank"), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      box.hidden = true;
      splitter.hidden = true;
    },
    setWidth(px) {
      box.style.width = `${px}px`;
    },
    browser,
  };
}
