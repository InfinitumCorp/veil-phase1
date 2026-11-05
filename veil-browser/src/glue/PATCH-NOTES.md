# Wiring VEIL into Tor Browser

The modules in `src/` and `src/glue/` are complete JavaScript and CSS. Turning
them into patches 0001–0006 on the build machine needs these small
registrations in the Tor Browser tree (they reference Firefox internals, so
they are written against the real source there, then committed with
`git format-patch` and the VEIL trailers).

## Files to install

| Source | Installed as | By patch |
| --- | --- | --- |
| `src/*.sys.mjs` | `resource:///modules/veil/*.sys.mjs` (browser/modules/veil/, moz.build `EXTRA_JS_MODULES.veil`) | 0002, 0003, 0006 |
| `src/glue/VeilBrowser.sys.mjs`, `VeilSidePanel.sys.mjs`, `VeilUrlbarProvider.sys.mjs` | same folder | 0002, 0006 |
| `src/glue/AboutVeilHome{Parent,Child}.sys.mjs` | `browser/actors/` (moz.build `FINAL_TARGET_FILES.actors`) | 0002 |
| `veil-chrome/src/**` | `chrome://browser/content/veil/` (jar.mn) | 0002 |
| verified `registry.json` (from `registry_tool.py build`) | `chrome://browser/content/veil/registry.json` | 0002 |
| `src/glue/veil-browser.css` | `chrome://browser/skin/veil-browser.css`, loaded from browser.xhtml | 0001 |

## Registrations

1. **about:veil-home** — `browser/components/about/AboutRedirector.cpp`:
   `{"veil-home", "chrome://browser/content/veil/home/home.html", nsIAboutModule::ALLOW_SCRIPT | nsIAboutModule::URI_MUST_LOAD_IN_CHILD | nsIAboutModule::URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS}`
   plus the `veil-home` entry in `components.conf`. Set `browser.startup.homepage` and
   `browser.newtab.url` to `about:veil-home`.
2. **Actor** — `BrowserGlue.sys.mjs` `JSWINDOWACTORS`:
   `AboutVeilHome: { parent: { esModuleURI: "resource:///actors/AboutVeilHomeParent.sys.mjs" }, child: { esModuleURI: "resource:///actors/AboutVeilHomeChild.sys.mjs", events: { DOMDocElementInserted: { capture: true } } }, matches: ["about:veil-home"] }`
3. **Bridge allow-list** — `toolkit/modules/RemotePageAccessManager.sys.mjs`, `accessMap`:
   `"about:veil-home": { RPMSendAsyncMessage: ["VEIL:GetTorStatus", "VEIL:NewIdentity", "VEIL:NewCircuit", "VEIL:GetBookmarks", "VEIL:OpenSignIn", "VEIL:GetAccount", "VEIL:OpenAppPanel"], RPMAddMessageListener: ["VEIL:TorStatus", "VEIL:Bookmarks", "VEIL:Account"] }`
   This must match `OUTGOING`/`INCOMING` in `veil-chrome/src/shared/bridge.js` (veil-qa checks they agree).
4. **Startup** — `BrowserGlue.sys.mjs`: call `VeilBrowser.init()` in `_beforeUIStartup`, and
   `VeilBrowser.onWindowLoaded(window)` from `browser-init.js` `onLoad`.
5. **Address-bar chip** — `browser.xhtml`: add `<box id="veil-anonymous-chip" role="status">Anonymous</box>`
   as the first child of `#urlbar-input-container`; `VeilBrowser` updates its text from `VeilSignIn.subscribe`.

## Things to confirm on ESR 153

- The New Identity observer topic (`new-identity-requested`) and `NewIdentityButton.onCommand`.
- `TorDomainIsolator.newCircuitForBrowser` and `TorConnect.state` values.
- UrlbarProvider engagement API (`onEngagement` vs. `pickResult`).

Each has a single call site, marked in the code.
