/* VEIL browser hub: wires VEIL's modules into Tor Browser (patches 0002-0006).
 *
 * Called from BrowserGlue:
 *   VeilBrowser.init()               once, at startup (before any window loads pages)
 *   VeilBrowser.onWindowLoaded(win)  for each new browser window
 *
 * Responsibilities:
 *  - load the signed app registry bundled with the browser;
 *  - start the anonymity guard (fail closed if Tor settings are weakened);
 *  - give each window its side panel and a VeilAppPanel driving it;
 *  - register the address-bar provider for @scalvs / @cndctr;
 *  - run Cumulus://ID sign-in, catching the redirect before it is sent;
 *  - forget everything VEIL keeps (sign-in, panels) on New Identity.
 */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarProvidersManager: "resource:///modules/UrlbarProvidersManager.sys.mjs",
  VeilAnonymityGuard: "resource:///modules/veil/VeilAnonymityGuard.sys.mjs",
  AppPanel: "resource:///modules/veil/VeilAppPanel.sys.mjs",
  CumulusID: "resource:///modules/veil/VeilCumulusID.sys.mjs",
  VeilSignIn: "resource:///modules/veil/VeilSignIn.sys.mjs",
  createSidePanel: "resource:///modules/veil/VeilSidePanel.sys.mjs",
  registerVeilUrlbarProvider: "resource:///modules/veil/VeilUrlbarProvider.sys.mjs",
});

// Verified and bundled at build time by veil-chrome/tools/registry_tool.py.
const REGISTRY_URL = "chrome://browser/content/veil/registry.json";
// Tor Browser announces New Identity on this topic; confirm the name on ESR 153.
const NEW_IDENTITY_TOPIC = "new-identity-requested";

const panels = new WeakMap();      // window -> AppPanel
let registry = { apps: [] };
let cumulusId = null;

function loadRegistry() {
  const xhr = new XMLHttpRequest();          // chrome:// is local and synchronous-safe at startup
  xhr.open("GET", REGISTRY_URL, false);
  xhr.overrideMimeType("application/json");
  xhr.send();
  return JSON.parse(xhr.responseText);
}

/** Catch the Cumulus://ID redirect before the request leaves the browser. */
const redirectObserver = {
  observe(subject) {
    if (!cumulusId || !cumulusId.enabled) return;
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const url = channel.URI.spec;
    if (!cumulusId.isRedirect(url)) return;
    channel.cancel(Cr.NS_BINDING_ABORTED);    // the code never goes to any server
    const browser = channel.loadInfo?.browsingContext?.top?.embedderElement;
    const win = browser?.ownerGlobal;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    if (tab) win.gBrowser.removeTab(tab);
    lazy.VeilSignIn.finish({ cumulusId, address: url }).catch(err => {
      Services.obs.notifyObservers(null, "veil-sign-in-failed", err.message);
    });
  },
};

export const VeilBrowser = {
  get registry() {
    return registry;
  },

  init() {
    registry = loadRegistry();
    lazy.VeilAnonymityGuard.init();
    cumulusId = new lazy.CumulusID({
      registry,
      openTab: (url, opts) => {
        const win = Services.wm.getMostRecentBrowserWindow();
        win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(url, opts);
      },
      // The parent process's fetch goes through Tor like everything else.
      fetch: (url, init) => fetch(url, init),
    });
    lazy.registerVeilUrlbarProvider(lazy.UrlbarProvidersManager);
    Services.obs.addObserver(redirectObserver, "http-on-modify-request");
    Services.obs.addObserver(() => this.onNewIdentity(), NEW_IDENTITY_TOPIC);
  },

  onWindowLoaded(win) {
    let appPanel;
    const side = lazy.createSidePanel(win, {
      onClose: () => appPanel.close(),
      onOpenInTab: () => {
        const app = registry.apps.find(a => a.id === appPanel.openId);
        appPanel.close();
        if (app) win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(app.url);
      },
      onResize: px => appPanel.resize(px),
    });
    appPanel = new lazy.AppPanel({ registry, panel: side });
    panels.set(win, appPanel);
  },

  appPanelFor(win) {
    return panels.get(win);
  },

  cumulusId() {
    return cumulusId;
  },

  onNewIdentity() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) panels.get(win)?.onNewIdentity();
    lazy.VeilSignIn.onNewIdentity(cumulusId);
  },
};
