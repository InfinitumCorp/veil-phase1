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
| `VeilGeoData.sys.mjs` | 0007 (next cut) | Local geo lists. Extra ad and tracker blocking stays off until the user turns it on. It does not resolve names or choose a route |
| `VeilSignIn.sys.mjs` | 0002 | Sign In: runs Cumulus://ID sign-in when configured, otherwise opens the Cumulus://ID page; tracks signed-in state for the start page |
| `VeilCumulusID.sys.mjs` | 0002 | Sign-in with Cumulus://ID: OpenID Connect code flow with PKCE, over Tor; checks state, nonce, issuer, audience and expiry; tokens kept in memory only |
| `VeilAppCommands.sys.mjs` | 0006 | Address-bar commands: `@scalvs …` or `@cndctr …` opens the app in the side panel with that request; never sent to the search engine or saved in history |
| `VeilAppPanel.sys.mjs` | 0002 | Opens /CNDCTR/ or SCALVS.ai in a side panel next to the current page, like ChatGPT's sidebar; the address comes from the signed app list |

All are tested under Node by `veil-qa/tests/js/`.

## Commands

```sh
python3 tools/veil_patches.py lint patches/
python3 tools/veil_patches.py new patches/ --tag chrome --subject "Add VEIL about:home"
python3 tools/veil_patches.py apply patches/ ../work/tor-browser
```
