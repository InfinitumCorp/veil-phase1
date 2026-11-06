# VEIL — Phase I: Browser Foundation

VEIL is Infinitum's Tor-first secure browser. This tree holds everything VEIL
owns for Phase I. The upstream code (Tor Browser and its build system) is
fetched and pinned by `veil-build/bootstrap.sh` on the build machines; it is
never vendored here.

| Directory | Becomes repository | Holds |
| --- | --- | --- |
| `veil-build/` | veil-build | Upstream pin, bootstrap, reproducibility check |
| `veil-browser/` | veil-browser | VEIL patches on top of tor-browser, the patch linter, and VEIL's browser modules (`src/`) |
| `veil-chrome/` | veil-chrome | The start page and the signed app list |
| `veil-update/` | veil-update | Update channels and signed release manifests |
| `veil-qa/` | veil-qa | Test suites run in CI and against built browsers |
| `veil-prototype/` | — | Clickable web version of the browser, for demos and testing |
| `cumulus-id/` | cumulus-id | Cumulus://ID: sign-in for VEIL and every Infinitum app |
| `apps/scalvs/`, `apps/cndctr/` | scalvs, cndctr | SCALVS.ai and /CNDCTR/, which run in VEIL's side panel |
| `infinitum-common/` | infinitum-common | Shared server toolkit and "Sign in with Cumulus://ID" for apps |

## The rule everything here enforces

VEIL is always anonymous. It has one workspace, every connection goes over
Tor with no direct fallback, and `veil-browser/src/VeilAnonymityGuard.sys.mjs`
takes the browser offline if any setting would let traffic bypass Tor.
Sign In (top right of the start page) signs in with Cumulus://ID. It also
goes over Tor, so it never reveals the user's IP address or location.

To websites, VEIL must look identical to stock Tor Browser. VEIL features
live in browser chrome, never in anything web content can observe.

## Try it

```sh
make demo          # Cumulus://ID, SCALVS.ai, /CNDCTR/ and the VEIL prototype
                   # then open http://localhost:8410
```

Needs Node 22 or newer and nothing else. In the prototype:

- **Start page:** Mail, Apps (the consumer apps) and Sign In at the top right;
  /CNDCTR/ and SCALVS.ai along the bottom open in the side panel.
- **Address bar:** `@scalvs` or `@scalus` followed by a question, `@cndctr` or
  `@conductor` followed by a command ("every weekday at 9 remind me to …").
  Commands are never sent to a search engine or saved.
- **Sign In:** creates or uses a Cumulus://ID; the apps then sign in with one click.
- **SCALVS.ai** needs a model to answer: set `ANTHROPIC_API_KEY` before `make demo`.
  Without one it says so instead of answering.

The prototype runs on this machine without Tor. In VEIL, every connection goes over Tor.

## Quick start

```sh
# Run every test that does not need a built browser (Python 3, Node 22, pytest, Chrome for the browser tests)
make test

# On a build machine (needs network, Docker/Podman, ~150 GB disk):
python3 veil-build/scripts/resolve_upstream.py   # find the signed 16.0 tags; review signers
python3 veil-build/scripts/resolve_upstream.py --write --trust <FPR>...
./veil-build/bootstrap.sh            # fork + pin upstream, apply VEIL patches
./veil-build/build.sh linux-x86_64   # reproducible build via tor-browser-build
```

## Phase I gates (from the build plan)

1. Fork and reproduce — `veil-build/scripts/compare_builds.py` must report identical hashes from two builders.
2. Always anonymous — the anonymity guard tests, plus `veil-qa/browser/` leak and fingerprint suites, pass.
3. Start page — `veil-qa/tests/test_chrome.py` proves zero remote requests from the start page.
4. Updates — `veil-qa/tests/test_update.py` tamper and downgrade tests pass.
5. External audit and public beta.

The Tor Browser integration (start page bridge, side panel, address-bar
commands, sign-in redirect handling, toolbar styles) is in
`veil-browser/src/glue/`; `PATCH-NOTES.md` there lists the registrations to
make in the Tor Browser tree when cutting the patches.

Base: **Tor Browser 16.0 series (Firefox ESR 153)**, released October 29, 2026.
