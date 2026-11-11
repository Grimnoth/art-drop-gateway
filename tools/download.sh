#!/bin/bash
# Download and verify the artist's image ZIPs into zips/, for the first import with tools/build.py.
# The daily job does not need this. Usage: tools/download.sh [tag]   (default: the latest release)
# Rerun at any time: verified ZIPs are skipped. A full delivery can be tens of GB.
set -u -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/env.sh" && load_env "$ROOT/.env"
REPO=${DELIVERY_REPO:?set DELIVERY_REPO in .env}
Z="$ROOT/zips"
TAG=${1:-$(gh release view -R "$REPO" --json tagName --jq .tagName)} || exit 1
mkdir -p "$Z" && cd "$Z" || exit 1
# Releases have named the checksum file SHA256SUMS.txt and SHA256SUMS_UPDATED.txt.
rm -f SHA256SUMS*.txt
gh release download "$TAG" -R "$REPO" -p 'SHA256SUMS*.txt' || exit 1
sums=(SHA256SUMS*.txt)
[ "${#sums[@]}" -eq 1 ] && [ -f "${sums[0]}" ] || { echo "The release needs one SHA256SUMS file, found ${#sums[@]}."; exit 1; }
tr -d '\r' < "${sums[0]}" > sums.lf || exit 1

one() {
  f=$1
  # "<sha256>  <name>": the name is the rest of the line, so it can hold spaces.
  want=$(awk -v f="$f" '{h=tolower($1); sub(/^[^ ]+ +\*?/, ""); if ($0 == f) print h}' sums.lf)
  for attempt in 1 2 3; do
    if [ -f "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$want" ]; then
      echo "OK $f"; return 0
    fi
    gh release download "$TAG" -R "$REPO" -p "$f" --clobber || echo "RETRY $f attempt $attempt"
  done
  if [ -f "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$want" ]; then
    echo "OK $f"; return 0
  fi
  echo "FAILED $f"; return 1
}
export -f one
export TAG REPO

awk '{sub(/^[^ ]+ +\*?/, ""); print}' sums.lf | grep '\.zip$' | xargs -P 6 -I{} bash -c 'one "$1" || exit 255' _ {}
# xargs stops on exit 255 and then exits nonzero on both GNU and macOS. A rerun skips the verified ZIPs.
