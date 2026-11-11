#!/bin/bash
# Run the Foundation-only Tor gate tests. Does not compile the Apple app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PACKAGE="$ROOT/apps/apple/VeilLogic"

run_tests() {
  local tool="$1"
  if ! "$tool" --version >/dev/null 2>&1; then
    echo "swift could not start. On Ubuntu install libncurses6, libcurl4, and libxml2." >&2
    "$tool" --version || true
    exit 1
  fi
  "$tool" test --package-path "$PACKAGE"
}

if command -v swift >/dev/null 2>&1; then
  run_tests swift
  exit 0
fi

if [[ -x /opt/swift-6.4.2/usr/bin/swift ]]; then
  run_tests /opt/swift-6.4.2/usr/bin/swift
  exit 0
fi

VERSION="6.4.2"
CACHE="${HOME}/.cache/veil-swift-${VERSION}"
SWIFT="${CACHE}/usr/bin/swift"
if [[ ! -x "$SWIFT" ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)
      URL="https://download.swift.org/swift-${VERSION}-release/ubuntu2404/swift-${VERSION}-RELEASE/swift-${VERSION}-RELEASE-ubuntu24.04.tar.gz"
      ;;
    aarch64)
      URL="https://download.swift.org/swift-${VERSION}-release/ubuntu2404-aarch64/swift-${VERSION}-RELEASE/swift-${VERSION}-RELEASE-ubuntu24.04-aarch64.tar.gz"
      ;;
    *)
      echo "No swift on PATH, and there is no Swift ${VERSION} build for ${ARCH}." >&2
      exit 1
      ;;
  esac
  mkdir -p "$CACHE" "$(dirname "$CACHE")"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading Swift ${VERSION} for the logic tests"
  curl -fL --retry 3 -o "$TMP/swift.tar.gz" "$URL"
  tar -xzf "$TMP/swift.tar.gz" -C "$CACHE" --strip-components=1
fi

"$SWIFT" test --package-path "$PACKAGE"
