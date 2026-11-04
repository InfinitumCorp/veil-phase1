# Browser suites (need a built VEIL and stock Tor Browser)

These run on the build machines against real binaries; CI runs them after
every build. They are the Gate 2 checks in the Phase I plan.

| Suite | File | Pass condition |
| --- | --- | --- |
| Fingerprint diff | `fingerprint_diff.py` + `collector.html` | Every collected signal identical to the same-version stock Tor Browser |
| Leak check | `leak_check.md` (procedure; automation to follow in stage 2) | No packet leaves the machine except to the Tor guard during a scripted browsing session |
| Workspace isolation | to be written in stage 2 alongside patch 0003 | A cookie, storage entry, cache entry or download set in one workspace is never visible in the other |

`collector.html` is also exercised in plain Chrome by
`tests/test_collector.py`, so a broken collector is caught without a VEIL
build.

## Running the fingerprint diff

```sh
pip install selenium            # plus geckodriver on PATH
python3 veil-qa/browser/fingerprint_diff.py \
  --veil work/out/release/linux-x86_64/veil/Browser/firefox \
  --upstream ~/tor-browser-16.0/Browser/firefox \
  --out fingerprint-report.json
```

Both binaries must be the same upstream version (Tor Browser 16.0.x) at the
same security level. Any entry added to `IGNORE` needs a security reviewer's
sign-off, because each one is a way to tell VEIL users apart.
