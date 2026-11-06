/* about:veil-home, parent side (patch 0002).
 *
 * Answers the start page's bridge messages. The page can only send the
 * messages listed in RemotePageAccessManager for about:veil-home (see
 * PATCH-NOTES.md), and every handler takes addresses from VEIL's own
 * registry, never from the page.
 */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  TorConnect: "moz-src:///toolkit/modules/TorConnect.sys.mjs",
  TorDomainIsolator: "moz-src:///toolkit/components/tor-launcher/TorDomainIsolator.sys.mjs",
  VeilBrowser: "moz-src:///browser/components/veil/VeilBrowser.sys.mjs",
  VeilSignIn: "moz-src:///browser/components/veil/VeilSignIn.sys.mjs",
});

// TorConnectStage names (toolkit/modules/TorConnect.sys.mjs, ESR 153) -> the
// three states the start page shows. Anything else is still connecting.
const TOR_STATES = {
  Bootstrapped: "connected",
  Offline: "error",
  FinalError: "error",
  ProviderStopped: "error",
  RegionNotFound: "error",
};

export class AboutVeilHomeParent extends JSWindowActorParent {
  #unsubscribe = null;

  actorCreated() {
    this.#unsubscribe = lazy.VeilSignIn.subscribe(account => this.#send("VEIL:Account", account));
  }

  didDestroy() {
    this.#unsubscribe?.();
  }

  #send(name, data) {
    try { this.sendAsyncMessage(name, data); } catch { /* page already gone */ }
  }

  get #window() {
    return this.browsingContext.topChromeWindow;
  }

  async receiveMessage({ name, data }) {
    switch (name) {
      case "VEIL:GetTorStatus": {
        const state = TOR_STATES[lazy.TorConnect.stageName] || "connecting";
        this.#send("VEIL:TorStatus", { state });
        break;
      }
      case "VEIL:GetBookmarks": {
        const tree = await lazy.PlacesUtils.promiseBookmarksTree(lazy.PlacesUtils.bookmarks.toolbarGuid);
        const items = (tree.children || []).filter(c => c.uri && /^https?:/.test(c.uri)).slice(0, 12)
          .map(c => ({ title: c.title || "", url: c.uri }));
        this.#send("VEIL:Bookmarks", { items });
        break;
      }
      case "VEIL:GetAccount":
        this.#send("VEIL:Account", lazy.VeilSignIn.account());
        break;
      case "VEIL:OpenSignIn":
        await lazy.VeilSignIn.open({
          registry: lazy.VeilBrowser.registry,
          cumulusId: lazy.VeilBrowser.cumulusId(),
          openTab: url => {
            const gBrowser = this.#window.gBrowser;
            gBrowser.selectedTab = gBrowser.addTrustedTab(url);
          },
        });
        break;
      case "VEIL:OpenAppPanel":
        // Only the id is used; VeilAppPanel looks the address up in the registry.
        lazy.VeilBrowser.appPanelFor(this.#window)?.handle({ name, data: { id: data?.id } });
        break;
      case "VEIL:NewIdentity":
        this.#window.NewIdentityButton?.onCommand();      // Tor Browser's own New Identity
        break;
      case "VEIL:NewCircuit":
        lazy.TorDomainIsolator.newCircuitForBrowser(this.#window.gBrowser.selectedBrowser);
        break;
    }
  }
}
