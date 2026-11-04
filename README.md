# VEIL — Phase I: Browser Foundation

VEIL is Infinitum's Tor-first secure browser. This tree holds everything VEIL
owns for Phase I. The upstream code (Tor Browser and its build system) is
fetched and pinned by `veil-build/bootstrap.sh` on the build machines; it is
never vendored here.

| Directory | Becomes repository | Holds |
| --- | --- | --- |
| `veil-build/` | veil-build | Upstream pin, bootstrap, reproducibility check |
| `veil-browser/` | veil-browser (patch series only) | VEIL patches on top of tor-browser, plus the patch linter |
| `veil-chrome/` | veil-chrome | Local dashboards and the launcher registry |
| `veil-update/` | veil-update | Update channels and signed release manifests |
| `veil-qa/` | veil-qa | Test suites run in CI and against built browsers |

## The rule everything here enforces

The anonymous workspace must look identical to stock Tor Browser to any
website. VEIL features live in browser chrome or in the authenticated
workspace, never in anything web content can observe.

## Quick start

```sh
# Run every test that does not need a built browser
make test

# On a build machine (needs network, Docker/Podman, ~150 GB disk):
./veil-build/bootstrap.sh            # fork + pin upstream, apply VEIL patches
./veil-build/build.sh linux-x86_64   # reproducible build via tor-browser-build
```

## Phase I gates (from the build plan)

1. Fork and reproduce — `veil-build/scripts/compare_builds.py` must report identical hashes from two builders.
2. Workspaces — `veil-qa/browser/` isolation, leak and fingerprint suites pass.
3. Dashboard — `veil-qa/tests/test_chrome.py` proves zero remote requests from the anonymous dashboard.
4. Updates — `veil-qa/tests/test_update.py` tamper and downgrade tests pass.
5. External audit and public beta.

Base: **Tor Browser 16.0 series (Firefox ESR 153)**, released October 29, 2026.
