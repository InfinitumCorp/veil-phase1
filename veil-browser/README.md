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
| `VeilAnonymityGuard.sys.mjs` | 0003 | Checks Tor proxy settings at startup and on every change; goes offline if any would let traffic bypass Tor. Also goes offline when `veil.vpn.blocked` is true |
| `VeilVpn.sys.mjs` | 0007 | Optional VEIL VPN in front of Tor. Off unless `veil.vpn.enabled` is true. No browser chrome |
| `VeilSignIn.sys.mjs` | 0002 | Sign In: runs Cumulus://ID sign-in when configured, otherwise opens the Cumulus://ID page; tracks signed-in state for the start page |
| `VeilCumulusID.sys.mjs` | 0002 | Sign-in with Cumulus://ID: OpenID Connect code flow with PKCE, over Tor; checks state, nonce, issuer, audience and expiry; tokens kept in memory only |
| `VeilAppCommands.sys.mjs` | 0006 | Address-bar commands: `@scalvs …` or `@cndctr …` opens the app in the side panel with that request; never sent to the search engine or saved in history |
| `VeilAppPanel.sys.mjs` | 0002 | Opens /CNDCTR/ or SCALVS.ai in a side panel next to the current page, like ChatGPT's sidebar; the address comes from the signed app list |

All are tested under Node by `veil-qa/tests/js/`.

## VEIL VPN (optional, off)

Patch 0007 can send Tor's connection to the Tor network through one VEIL node.
It does not add a button or change the start page. Leave it off and the
browser is unchanged: every site still goes out through Tor, with no second
hop and no extra preference written.

Turn it on in `about:config`:

| Preference | Value |
| --- | --- |
| `veil.vpn.enabled` | `true` |
| `veil.vpn.server` | a `*.infinitumveilvpn.app` name, for example `vpn-use2.infinitumveilvpn.app` |
| `veil.vpn.address` | that node's public IPv4, so the browser does not use system DNS |
| `veil.vpn.transport` | `http-connect` (port 443) or `shadowsocks-2022` (port 16080) |
| `veil.vpn.username` | from the VEIL login, for `http-connect` |
| `veil.vpn.password` | from the VEIL login. For Shadowsocks 2022 this is the base64 key, not a sentence |
| `veil.vpn.directory` | optional `https://api.infinitumveilvpn.app/v1/servers` |

The directory published today lists cities and modes (`proxy`, `wireguard`,
`ikev2`, `openvpn`) and does not include a host or address, so it cannot
dial a node by itself. `wireguard`, `ikev2`, `openvpn`, and VLESS are not
used. With the tunnel on, Tor's upstream proxy is a loopback listener and
the browser proxy stays on Tor. WebRTC and DNS prefetch must stay at their
Tor Browser values. If the node is down, `veil.vpn.blocked` is set and the
anonymity guard takes the browser offline instead of connecting directly.

Set `veil.vpn.enabled` back to `false` to restore the previous Tor upstream
proxy. A credential passed in memory (rather than a preference) is dropped
on New Identity.

## Commands

```sh
python3 tools/veil_patches.py lint patches/
python3 tools/veil_patches.py new patches/ --tag chrome --subject "Add VEIL about:home"
python3 tools/veil_patches.py apply patches/ ../work/tor-browser
```
