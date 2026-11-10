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

Browsing is paused until the in-process Tor client has bootstrapped. There is no direct fallback. If the circuit drops, or the Tor thread exits, the web view is torn down and nothing loads.

The client is [Tor.framework](https://github.com/iCepa/Tor.framework) 409.16.1, linked with Swift Package Manager (product `CTor`). That release is tor 0.4.9.16, libevent 2.1.13, OpenSSL 3.6.5, and liblzma 5.8.4. Tor.framework is MIT. tor is BSD-3-Clause. OpenSSL 3 is Apache-2.0. libevent is BSD. Those licenses can sit next to this app. The same package has an older Arti build that its README calls unmaintained, so this app does not link it. `TORThread` runs tor inside the app process. It is not a separate executable, which is what iOS allows.

`FrameworkTorDaemon` writes the loopback `torrc` (SOCKS on 127.0.0.1, no DNS port, cookie authentication, safe logging) and starts that thread. Bootstrap progress comes from the control port (`STATUS_CLIENT BOOTSTRAP` and `CIRCUIT_ESTABLISHED`). The toolbar status line stays the existing sentence and, while Tor is still coming up, gains the percent (`Connecting to Tor… 40%`). New Identity sends `SIGNAL CLEARDNSCACHE` and `SIGNAL NEWNYM`, then drops the web view, history, and sign-in, the same as before.

When the circuit is up, WKWebView is pointed at the SOCKS port with `WKWebsiteDataStore.proxyConfigurations` (`ProxyConfiguration` SOCKS5, `allowFailover` off, no excluded domains). That API exists on macOS 14 and iOS 17 and covers the web view only. The app does not resolve the site name first. WebKit sends the hostname to the proxy, so DNS goes through Tor. A script injected at document start disables `RTCPeerConnection` (WebRTC can reveal a local address) and removes `dns-prefetch` and `preconnect` hints. The web data store is non-persistent unless `WebDataPolicy.persistentByDefault` is changed, and it is not.

Vanilla bridge lines are written into the torrc. obfs4, snowflake, and webtunnel need a transport program this app does not ship, so those bridges will not connect. A bridge line that tries to change the proxy is still refused.

`PacketTunnelPlan` describes a Network Extension packet tunnel. The extension target is not in the Xcode project. An appex needs the Network Extensions entitlement and a provisioning profile, and an unsigned build cannot embed it. A tunnel is what would also cover traffic that is not inside WKWebView.

VEIL does not change the system proxy. That would send every other app through Tor and needs a privileged helper. `SystemProxyPlan` records that the change is not applied.

Resolving the package needs an Xcode that accepts Swift tools version 6.3. Tor.framework 409.16.1 says it wants Xcode 27. The prebuilt `tor.xcframework` is downloaded from the Tor.framework release during the Xcode build. `ITSAppUsesNonExemptEncryption` is true because that binary contains Tor and OpenSSL. This repository does not answer Apple's export questions and does not upload the app.

Sign-in with Cumulus://ID is implemented for the day the registry gains a `cid` block: authorization-code flow with PKCE, tokens kept in memory, and the token request allowed only through the loopback SOCKS port. The shipped registry has no `cid` block, so Sign In opens the page from the registry. The token POST uses a URL session created for that proxy. It is not the process-wide shared session.

## App Store

App Store Review Guideline 2.5.6 requires iOS apps that browse the web to use WebKit. VEIL uses `WKWebView` on both platforms. Gecko and Chromium are not part of this app, so Tor Browser's fingerprinting patches cannot be copied here. A mismatched desktop user agent would make the app easier to single out. The user agent is left as WebKit's own.

`NSAllowsArbitraryLoads` stays off for the app's own requests. `NSAllowsArbitraryLoadsInWebContent` is on so an onion page can be judged by VEIL's HTTPS-only policy instead of being dropped by App Transport Security before that policy runs. Certificate checks are not disabled.

This repository does not sign, archive, or upload the app. There is no TestFlight or App Store step here.

## Build

The commands are in [TESTING.md](TESTING.md). They pass `CODE_SIGNING_ALLOWED=NO`. No team ID and no signing secret is required.
