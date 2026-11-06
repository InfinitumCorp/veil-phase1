#!/usr/bin/env bash
# Fork and pin upstream Tor Browser sources, then apply the VEIL patch series.
#
# Run on a build machine with network access. Idempotent: re-running resets
# the VEIL branches to the verified tags and applies the series again.
#
#   ./veil-build/bootstrap.sh [--work-dir DIR] [--skip-verify] [--pending]
#
# --skip-verify and --pending are for local experiments only; release builds
# never use them. --pending applies the patch series still awaiting review
# (veil-browser/patches/pending, veil-build/patches/pending).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK_DIR="${WORK_DIR:-$ROOT/work}"
VERIFY=1
PENDING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --skip-verify) VERIFY=0; shift ;;
    --pending) PENDING=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# shellcheck source=veil.conf
source "$HERE/veil.conf"

die() { echo "bootstrap: $*" >&2; exit 1; }

[[ "$TOR_BROWSER_TAG" != CHANGE-ME* ]] \
  || die "TOR_BROWSER_TAG is not confirmed in veil.conf; run scripts/resolve_upstream.py"
[[ "$TOR_BROWSER_BUILD_TAG" != CHANGE-ME* ]] \
  || die "TOR_BROWSER_BUILD_TAG is not confirmed in veil.conf; run scripts/resolve_upstream.py"
if [[ $VERIFY -eq 1 && -z "${UPSTREAM_SIGNER_FPRS// }" ]]; then
  die "UPSTREAM_SIGNER_FPRS is empty in veil.conf; add the Tor Project signing key fingerprints"
fi

for tool in git python3; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done

mkdir -p "$WORK_DIR"

# Verify upstream tags against VEIL's own copy of the signers' public keys
# (veil-build/keys/*.gpg, taken from tor-browser-build's keyring/), in a
# keyring used for nothing else.
if [[ $VERIFY -eq 1 ]]; then
  command -v gpg >/dev/null || die "missing tool: gpg"
  export GNUPGHOME="$WORK_DIR/.gnupg-upstream"
  rm -rf "$GNUPGHOME"; mkdir -m 700 -p "$GNUPGHOME"
  shopt -s nullglob
  keys=("$HERE"/keys/*.gpg)
  shopt -u nullglob
  [[ ${#keys[@]} -gt 0 ]] || die "no upstream signer keys in veil-build/keys"
  gpg --batch --quiet --import "${keys[@]}" 2>/dev/null || die "could not import upstream signer keys"
fi

clone_pinned() {
  local url="$1" tag="$2" dir="$3" branch="$4"
  if [[ ! -d "$dir/.git" ]]; then
    echo "==> cloning $url"
    git clone --no-checkout "$url" "$dir"
  fi
  echo "==> fetching tag $tag"
  git -C "$dir" fetch --force origin "refs/tags/$tag:refs/tags/$tag"

  if [[ $VERIFY -eq 1 ]]; then
    echo "==> verifying signature on $tag"
    local status signer ok=0
    status="$(git -C "$dir" verify-tag --raw "$tag" 2>&1)" \
      || die "signature check failed for $tag"
    for signer in $UPSTREAM_SIGNER_FPRS; do
      # VALIDSIG lists the signing subkey first and the primary key last;
      # accept the tag if either matches an allowed fingerprint.
      if grep -Eq "VALIDSIG (.* )?${signer}( |\$)" <<<"$status"; then
        ok=1
      fi
    done
    [[ $ok -eq 1 ]] || die "$tag is not signed by an allowed upstream key"
  fi

  # Always start the VEIL branch from the verified tag, so re-running
  # bootstrap gives the same result instead of applying patches twice.
  git -C "$dir" checkout --quiet --force -B "$branch" "refs/tags/$tag"
  git -C "$dir" clean --quiet -fdx
}

clone_pinned "$TOR_BROWSER_BUILD_URL" "$TOR_BROWSER_BUILD_TAG" \
  "$WORK_DIR/tor-browser-build" "$VEIL_BUILD_BRANCH"
clone_pinned "$TOR_BROWSER_URL" "$TOR_BROWSER_TAG" \
  "$WORK_DIR/tor-browser" "$VEIL_BROWSER_BRANCH"

BROWSER_PATCHES="$ROOT/veil-browser/patches"
BUILD_PATCHES="$ROOT/veil-build/patches"
APPLY_FLAGS=()
if [[ $PENDING -eq 1 ]]; then
  echo "==> WARNING: applying patch series that are still awaiting review"
  BROWSER_PATCHES="$BROWSER_PATCHES/pending"
  BUILD_PATCHES="$BUILD_PATCHES/pending"
  APPLY_FLAGS=(--pending)
fi
GIT_ID=(-c user.name="VEIL bootstrap" -c user.email=bootstrap@veil.invalid -c commit.gpgSign=false)
# git am records a committer; don't depend on the build machine's git config.
export GIT_COMMITTER_NAME="VEIL bootstrap" GIT_COMMITTER_EMAIL="bootstrap@veil.invalid"

echo "==> applying VEIL patch series to tor-browser"
python3 "$ROOT/veil-browser/tools/veil_patches.py" apply "${APPLY_FLAGS[@]}" \
  "$BROWSER_PATCHES" "$WORK_DIR/tor-browser"

if [[ -d "$BUILD_PATCHES" ]]; then
  echo "==> applying VEIL patch series to tor-browser-build"
  python3 "$ROOT/veil-browser/tools/veil_patches.py" apply "${APPLY_FLAGS[@]}" \
    "$BUILD_PATCHES" "$WORK_DIR/tor-browser-build"
fi

# The app registry ships only if its signature verifies. tor-browser-build
# builds from git, so the generated files are committed on the VEIL branch.
GENERATED="$WORK_DIR/tor-browser/browser/components/veil/content/generated"
if [[ -d "$(dirname "$GENERATED")" ]]; then
  echo "==> verifying and bundling the signed app registry"
  python3 "$ROOT/veil-chrome/tools/registry_tool.py" build \
    "$ROOT/veil-chrome/registry/registry.json" "$ROOT/veil-chrome/registry/keys" \
    "$GENERATED/registry.js" || die "the app registry is not signed by a VEIL key; sign it first"
  git -C "$WORK_DIR/tor-browser" add -f "$GENERATED/registry.js" "$GENERATED/registry.json"
  git -C "$WORK_DIR/tor-browser" "${GIT_ID[@]}" commit -q -m "VEIL app registry (verified, generated by bootstrap.sh)"
fi

# Tell tor-browser-build which VEIL commit to build (patch 0001 in veil-build/patches).
VEIL_BROWSER_COMMIT="$(git -C "$WORK_DIR/tor-browser" rev-parse HEAD)"
cat > "$WORK_DIR/tor-browser-build/rbm.local.conf" <<CONF
# Written by veil-build/bootstrap.sh. Do not edit.
var:
  veil_browser_git_url: '$WORK_DIR/tor-browser'
  veil_browser_commit: '$VEIL_BROWSER_COMMIT'
CONF

# Record exactly what was checked out, for the release manifest.
{
  echo "tor_browser_version=$TOR_BROWSER_VERSION"
  echo "tor_browser_esr=$TOR_BROWSER_ESR"
  echo "tor_browser_build_tag=$TOR_BROWSER_BUILD_TAG"
  echo "tor_browser_build_commit=$(git -C "$WORK_DIR/tor-browser-build" rev-parse "refs/tags/$TOR_BROWSER_BUILD_TAG^{commit}")"
  echo "tor_browser_tag=$TOR_BROWSER_TAG"
  echo "tor_browser_commit=$(git -C "$WORK_DIR/tor-browser" rev-parse "refs/tags/$TOR_BROWSER_TAG^{commit}")"
  echo "veil_browser_head=$VEIL_BROWSER_COMMIT"
  echo "veil_build_head=$(git -C "$WORK_DIR/tor-browser-build" rev-parse HEAD)"
  echo "veil_patches=$([[ $PENDING -eq 1 ]] && echo pending-review || echo reviewed)"
} > "$WORK_DIR/pin.lock"

echo "==> done. Pin recorded in $WORK_DIR/pin.lock"
