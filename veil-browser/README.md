# veil-browser — the VEIL patch series

VEIL's changes to Tor Browser live here as a small, ordered patch series,
applied by `veil-build/bootstrap.sh` on top of the pinned upstream tag. Keeping
the series small is what lets VEIL absorb an upstream security release within
the 72-hour target.

## Layout

```
patches/
  series            # apply order, one patch file per line, '#' comments
  0001-....patch    # git format-patch output with VEIL headers
tools/
  veil_patches.py   # lint / apply / new
```

## Required headers

Every patch's commit message carries these trailers:

```
VEIL-Tag: branding | chrome | workspace | update | network | fingerprint | content
VEIL-Reason: one line on why this change is needed
Reviewed-by: Name <email>
```

Tags `network`, `fingerprint` and `content` touch what websites or the Tor
network can observe, so they need **two** distinct `Reviewed-by:` trailers.
`workspace` patches also need two, since they guard isolation. The linter
enforces this and CI refuses a series that fails it.

## Hard rule

VEIL is always anonymous: no patch may add a way for traffic to leave
without Tor, and no patch may change anything web content can observe. If a
change would, it does not ship; raise it with the security engineer instead.

## Browser modules (`src/`)

| Module | Installed by | Does |
| --- | --- | --- |
| `VeilAnonymityGuard.sys.mjs` | 0003 | Checks Tor proxy settings at startup and on every change; goes offline if any would let traffic bypass Tor |
| `VeilSignIn.sys.mjs` | 0002 | Opens Cumulus://ID sign-in from the signed app list in a new tab; tracks signed-in state for the start page |

Both are tested under Node by `veil-qa/tests/js/`.

## Commands

```sh
python3 tools/veil_patches.py lint patches/
python3 tools/veil_patches.py new patches/ --tag chrome --subject "Add VEIL about:home"
python3 tools/veil_patches.py apply patches/ ../work/tor-browser
```
