# VEIL for Mac and iPhone

Native VEIL for macOS 14 and iOS 17. The window copies the browser VEIL already ships: the start page in `veil-chrome/src/home/`, and the tab strip and toolbar in `veil-prototype/static/` and `veil-browser/src/glue/veil-browser.css`. Colors, the wordmark `VEIL</>`, Helvetica Neue, and the page layout come from those files. A unit test reads them and fails if this app drifts.

The app list is `Veil/Resources/registry.json`, a copy of `veil-chrome/registry/registry.json`. Another test checks the two files match. Sign In, Mail, and the apps open those addresses. Nothing in the interface invents a new one.

## What works

- Tabs, the address bar, and the start page, including Mail, Apps, Sign In, bookmarks, `/CNDCTR/` and SCALVS.ai in the bottom row, and FABRIC in the footer.
- Address-bar commands `@scalvs`, `@scalus`, `@cndctr`, and `@conductor`. A command opens that app in the side panel. The prompt is placed in the URL fragment, so it is not sent to a server, a search engine, or history.
- Search uses the same DuckDuckGo onion address as the start page.
- `WKWebView` with a non-persistent data store. Bookmarks and history are kept in memory and discarded when VEIL closes, unless Wipe on close is turned off in Settings.
- Tracker and ad blocking through `WKContentRuleList`, third-party cookie blocking, and HTTPS-only. Onion addresses may stay on HTTP, because the onion address is the encryption. Local and private addresses are refused.
- WebKit privacy settings that do not pretend this is desktop Tor Browser: no custom user agent, no automatic popups, no camera or microphone, no autoplay, quirks mode off.
- Downloads into a temporary folder that is removed with the session.
- The anonymity guard. If the proxy settings would let traffic leave without Tor, VEIL goes offline.

## Tor

Browsing is paused until a local SOCKS5 proxy is up. There is no direct fallback.

When a client is running, WKWebView is pointed at it with `WKWebsiteDataStore.proxyConfigurations` (`ProxyConfiguration` SOCKS5, `allowFailover` off, no excluded domains). That API exists on macOS 14 and iOS 17 and covers the web view only. DNS is not resolved in the app before the request; names are left for the proxy.

This build does not contain an Arti or Tor executable, and it does not link Tor.framework. `EmbeddedTorClient` looks for `arti` or `tor` inside the app bundle and, on macOS, would launch it with the generated `arti.toml` or `torrc`. On iOS an app cannot spawn that executable. `InProcessTorDaemon` is the interface a statically linked Arti or Tor.framework would implement. `NotLinkedTorDaemon` is the implementation in this build, and it refuses to start.

`PacketTunnelPlan` describes a Network Extension packet tunnel. The extension target is not in the Xcode project. An appex needs the Network Extensions entitlement and a provisioning profile, and an unsigned build cannot embed it. A tunnel is what would also cover traffic that is not inside WKWebView.

VEIL does not change the system proxy. That would send every other app through Tor and needs a privileged helper. `SystemProxyPlan` records that the change is not applied.

Sign-in with Cumulus://ID is implemented for the day the registry gains a `cid` block: authorization-code flow with PKCE, tokens kept in memory, and the token request allowed only through the loopback SOCKS port. The shipped registry has no `cid` block, so Sign In opens the page from the registry. The token POST uses a URL session created for that proxy. It is not the process-wide shared session.

## App Store

App Store Review Guideline 2.5.6 requires iOS apps that browse the web to use WebKit. VEIL uses `WKWebView` on both platforms. Gecko and Chromium are not part of this app, so Tor Browser's fingerprinting patches cannot be copied here. A mismatched desktop user agent would make the app easier to single out. The user agent is left as WebKit's own.

`NSAllowsArbitraryLoads` stays off for the app's own requests. `NSAllowsArbitraryLoadsInWebContent` is on so an onion page can be judged by VEIL's HTTPS-only policy instead of being dropped by App Transport Security before that policy runs. Certificate checks are not disabled.

This repository does not sign, archive, or upload the app. There is no TestFlight or App Store step here.

## Build

The commands are in [TESTING.md](TESTING.md). They pass `CODE_SIGNING_ALLOWED=NO`. No team ID and no signing secret is required.
