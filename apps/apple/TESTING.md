# Testing the Apple app

Needs a Mac with Xcode 15 or newer, the macOS 14 SDK, and an iOS 17 simulator. The project is `apps/apple/Veil.xcodeproj`. Signing is off. Do not add a development team.

## Unit tests and the Mac app

```sh
xcodebuild \
  -project apps/apple/Veil.xcodeproj \
  -scheme Veil \
  -destination 'platform=macOS' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  test
```

## Unit tests and the iOS app

List simulators, then pick an iPhone:

```sh
xcodebuild -project apps/apple/Veil.xcodeproj -scheme Veil -showdestinations
```

```sh
xcodebuild \
  -project apps/apple/Veil.xcodeproj \
  -scheme Veil \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  test
```

If that simulator name is not installed, use the `id` from `-showdestinations`:

```sh
-destination 'platform=iOS Simulator,id=THE-SIMULATOR-ID'
```

## What the tests cover

`VeilTests` is XCTest, hosted in the app:

- Address handling: `@scalvs` / `@cndctr` commands, the fragment prompt, search on the DuckDuckGo onion, HTTPS upgrades, refused `javascript:`, `data:`, and `file:` URLs, and local-network addresses.
- The start-page words and colors against `veil-chrome` and the prototype shell.
- The bundled app list against `veil-chrome/registry/registry.json`.
- Content-rule JSON, tracker matches, and the referrer script.
- Settings defaults, the wipe-on-close store, download filenames, and the refusal to delete a directory that is not VEIL's.
- Tor configuration: SOCKS5 on 127.0.0.1, no direct fallback, `torrc` and Arti config, bridge lines that cannot rewrite the proxy, the WebKit proxy plan, and the clients that are not bundled. A stand-in in-process daemon is used to prove a loopback port can be accepted and a public address cannot.

`VeilUITests` launches the app and checks the start page (`VEIL</>`, search, Anonymous, Sign In, the footer), that Tor stays paused, and that Settings shows Wipe on close and HTTPS-only.

GitHub Actions runs the same two `xcodebuild test` commands on a macOS runner. See `.github/workflows/apple.yml`.

## Icons

`apps/apple/scripts/render_icon.py` redraws the app icon from the mark in `veil-browser/branding/src`. It needs Pillow (`pip install pillow`). The PNGs in the asset catalog are already rendered; the script is how to regenerate them.
