# veil-update — channels and signed release manifests

VEIL keeps Mozilla's updater (as Tor Browser does) and points it at VEIL's
own servers. Two separate signatures protect every update:

| What | Signed with | Checked by |
| --- | --- | --- |
| MAR update packages | Channel NSS certificate (`certs/`), via `signmar` | The browser's updater, before installing |
| Release manifest | Channel Ed25519 key (`keys/`), via `tools/release_manifest.py` | Independent builders and anyone, before rollout |

Each channel (release, alpha, nightly) has its own keys, so a key from one
channel can never sign another's updates. All private keys live in the HSM;
only public keys and certificates are committed.

## Release flow

1. Two builders run `veil-build/build.sh` and `compare_builds.py` confirms identical hashes.
2. `release_manifest.py create` records artifacts, sizes, hashes and the upstream pin.
3. The HSM signs the manifest; it is published.
4. After `rollout_hold_hours`, the update is served. Anyone can run `release_manifest.py verify` against their own build in the meantime.

## Security releases

An upstream Tor Browser security release has a 72-hour target to a VEIL
release. Missing it is handled as a security incident.

## Key compromise

Rotate the affected channel's keys from the offline backup, ship a browser
update that trusts only the new key, and publish an incident notice. The
procedure lives in `KEY-ROTATION.md` (to be written with the security engineer
before the first public release).
