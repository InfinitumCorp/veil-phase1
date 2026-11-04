#!/usr/bin/env bash
# Build one VEIL target with tor-browser-build after bootstrap.sh has run.
#
#   ./veil-build/build.sh <target> [release|alpha|nightly]
#
# Targets follow tor-browser-build naming, e.g. linux-x86_64, linux-aarch64,
# windows-x86_64, macos. The heavy lifting (pinned toolchains, containers,
# no network after source fetch) is tor-browser-build's own; this wrapper
# only selects the channel and collects artifacts with their hashes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK_DIR="${WORK_DIR:-$ROOT/work}"
TARGET="${1:?usage: build.sh <target> [channel]}"
CHANNEL="${2:-release}"

case "$CHANNEL" in release|alpha|nightly) ;; *) echo "bad channel: $CHANNEL" >&2; exit 2 ;; esac
[[ -f "$WORK_DIR/pin.lock" ]] || { echo "run bootstrap.sh first" >&2; exit 1; }

TBB="$WORK_DIR/tor-browser-build"
OUT="$WORK_DIR/out/$CHANNEL/$TARGET"
mkdir -p "$OUT"

echo "==> building $TARGET on channel $CHANNEL"
# tor-browser-build exposes make targets per channel and platform; the exact
# target name is checked against `make help` so a renamed target fails loudly.
MAKE_TARGET="$CHANNEL-$TARGET"
if ! make -C "$TBB" help 2>/dev/null | grep -qw -- "$MAKE_TARGET"; then
  echo "tor-browser-build has no target '$MAKE_TARGET'; check 'make -C $TBB help'" >&2
  exit 1
fi
make -C "$TBB" "$MAKE_TARGET"

echo "==> collecting artifacts"
find "$TBB/$CHANNEL" -type f -newer "$WORK_DIR/pin.lock" -exec cp -t "$OUT" {} +
( cd "$OUT" && sha256sum -- * | grep -v ' sha256sums.txt$' > sha256sums.txt )
cp "$WORK_DIR/pin.lock" "$OUT/pin.lock"
echo "==> artifacts and hashes in $OUT"
