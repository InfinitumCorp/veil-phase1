# Wiring VEIL into Tor Browser

The patches are generated, not hand-edited: `veil-browser/tools/cut_patches.py`
applies each change to a tor-browser tree at the pinned commit, commits it with
VEIL trailers and writes the series with `git format-patch`. Every edit to an
upstream file is anchored on exact text, so a rebase that moves something stops
with the file and anchor instead of guessing. Cutting is byte-reproducible, and
`veil-qa/tests/test_bootstrap_e2e.py` fails if the committed series is stale.

    make patches      # needs VEIL_UPSTREAM_SUBSET and VEIL_UPSTREAM_TBB (see below)

Cut against tor-browser `1f8c6d9758e139aee1da08d170fe59a5b4580e87`
(tag `tor-browser-153.6.0esr-16.0-1-build3`, Tor Browser 16.0 / Firefox ESR 153.6.0).

## Series (veil-browser/patches/pending, awaiting review)

| # | Tag | What it does | Upstream files touched |
| --- | --- | --- | --- |
| 0001 | branding | VEIL names, vendor, URLs and icons in `browser/branding/tb-release` (tor-browser-build builds `tb-<channel>`) | branding only; icons from `veil-browser/branding/make_branding.py` |
| 0002 | chrome | `browser/components/veil` (start page, sign-in, side panel); `about:veil-home` replaces `about:tor` as home/new tab | `browser/components/moz.build`, `about/AboutRedirector.cpp`, `about/components.conf`, `app/profile/000-tor-browser.js`, `DesktopActorRegistry.sys.mjs`, `toolkit/modules/RemotePageAccessManager.sys.mjs`, `BrowserGlue.sys.mjs`, `base/content/browser-init.js`, `navigator-toolbox.inc.xhtml`, `browser.xhtml` |
| 0003 | network | Anonymity guard, started first in `_beforeUIStartup` | `BrowserGlue.sys.mjs` |
| 0004 | network | `TOR_PROVIDER=none` no longer turns Tor off; mock provider only under test automation | `tor-launcher/TorProviderBuilder.sys.mjs`, `TorLauncherUtil.sys.mjs` |
| 0005 | update | VEIL's MAR certificates replace Tor's in `toolkit/mozapps/update/updater` | **not cut yet**: needs the certificates from VEIL's key ceremony |
| 0006 | chrome | `@scalvs` / `@cndctr` address-bar commands | `urlbar/UrlbarProvidersManager.sys.mjs` (`localProviderModules`) |
| 0007 | network | Optional VEIL VPN in front of Tor, off unless `veil.vpn.enabled` | `000-tor-browser.js` (one default pref), `browser/components/veil` modules. No chrome |

`veil-build/patches/pending/0001` makes tor-browser-build build the VEIL branch
(by commit, from `rbm.local.conf` written by bootstrap.sh) with VEIL's update URL
and MAR channel IDs; without it, the build would produce stock Tor Browser.

## Layout inside the tree

- Modules are `moz-src:///browser/components/veil/*.sys.mjs` (`MOZ_SRC_FILES`).
- Chrome content is `chrome://browser/content/veil/` (`jar.mn`): `home/`, `shared/`,
  `icons/`, `veil-browser.css`, and `generated/registry.{js,json}`, which bootstrap.sh
  writes from the signed registry and commits on the VEIL branch. The build fails
  without them, so an unsigned registry can't ship.
- `about:veil-home` uses the same flags as `about:tor` (unprivileged content
  process); its actor uses `RemotePageChild`, limited by `RemotePageAccessManager`
  to the messages in `veil-chrome/src/shared/bridge.js` (cut_patches.py reads the
  list from there, so they can't drift).

## Confirmed on ESR 153 (tor-browser 16.0)

- New Identity: `window.NewIdentityButton.onCommand()`; observers get `new-identity-requested`.
- Tor status: `TorConnect.stageName` with `TorConnectStage` names (`Bootstrapped`, `Offline`, `FinalError`, ...).
- New circuit: `TorDomainIsolator.newCircuitForBrowser(browser)` (moz-src module).
- Address bar: `async isActive`, sync `getPriority`, `new UrlbarResult({type, source, heuristic, payload})`,
  `getViewTemplate`/`getViewUpdate`, `onEngagement(queryContext, controller, details)`; providers are
  listed in `localProviderModules` with `supportedSAPs`.

## Getting the upstream trees

The full tor-browser clone needs gitlab.torproject.org. Without it, fetch only the
files the patches touch, by git blob id, and import them with
`veil-browser/tools/import_upstream_subset.py`, which rejects any file whose
hash doesn't match. Point `VEIL_UPSTREAM_SUBSET` at the result and
`VEIL_UPSTREAM_TBB` at a tor-browser-build clone with tag `tbb-16.0-build1`.

## Still to check on a full build

- Recut `patches/pending` with `cut_patches.py` once the upstream tree is
  available. 0007 matches that cutter's edit (modules, `veil.vpn.enabled`
  defaulting to false, no chrome), but its patch bytes were formatted
  without the upstream checkout, so `test_committed_patches_match_a_fresh_cut`
  will ask for a recut.

- `browser/components/urlbar/metrics.yaml` lists provider names for telemetry
  (Tor Browser disables telemetry, but a test may compare the lists).
- Places that hard-code `about:tor` besides the redirect (for example the
  update "what's new" override in `abouttor/HomepageOverride.sys.mjs`).
- The side panel's XUL layout next to Firefox's own sidebar in ESR 153.
