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

## Logic tests on Linux

The fail-closed gate, the SOCKS proxy decision, bootstrap parsing, New Identity's control commands, and the WebRTC script live in `apps/apple/VeilLogic`. They use only Foundation.

```sh
bash apps/apple/scripts/test_logic.sh
```

`make test` runs that script. It uses `swift` if it is already on `PATH`, otherwise it downloads Swift 6.4.2 for Ubuntu 24.04 into `~/.cache/veil-swift-6.4.2`. The Linux CI job uses the runner selected by `CI_RUNNER` and runs `make test`. It does not compile the app or start Tor.

## What the tests cover

`VeilTests` is XCTest, hosted in the app:

- Address handling: `@scalvs` / `@cndctr` commands, the fragment prompt, search on the DuckDuckGo onion, HTTPS upgrades, refused `javascript:`, `data:`, and `file:` URLs, and local-network addresses.
- The start-page words and colors against `veil-chrome` and the prototype shell.
- The bundled app list against `veil-chrome/registry/registry.json`.
- Content-rule JSON, tracker matches, and the referrer script.
- Settings defaults, the wipe-on-close store, download filenames, and the refusal to delete a directory that is not VEIL's.
- Tor configuration: SOCKS5 on 127.0.0.1, no direct fallback, `torrc` and Arti config, bridge lines that cannot rewrite the proxy, and the WebKit proxy plan. A stand-in daemon proves a loopback port is accepted only after bootstrap, a public address is refused, and a dropped circuit pauses browsing again. `VeilLogic` checks the same gate without starting Tor.
- The WebRTC and DNS-prefetch script stays inside the page and does not open its own connection.

`VeilUITests` launches the app and checks the start page (`VEIL</>`, search, Anonymous, Sign In, the footer), that the Tor status line is present, that no web view exists yet, and that Settings shows Wipe on close and HTTPS-only. It does not wait for a live circuit.

GitHub Actions runs `xcodebuild test` for macOS and an iPhone simulator. That job needs a Mac. It is not the Linux runner selected by `CI_RUNNER`. See `.github/workflows/apple.yml`. Resolving Tor.framework needs a network connection and an Xcode that can read Swift tools version 6.3.

## Icons

`apps/apple/scripts/render_icon.py` redraws the app icon from the mark in `veil-browser/branding/src`. It needs Pillow (`pip install pillow`). The PNGs in the asset catalog are already rendered; the script is how to regenerate them.
