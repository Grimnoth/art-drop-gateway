#!/bin/bash
# Deploy the review site. Needs site/wrangler.toml: copy site/wrangler.example.toml and fill it in.
# The Worker refuses every request until the password is set, so the order below is safe.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/env.sh" && load_env "$ROOT/.env"
W="${WRANGLER:-wrangler}"
cd "$ROOT/site"
mkdir -p public && cp ../tools/gallery.html public/gallery.html
"$W" deploy

cd "$ROOT"
if [ ! -s REVIEW_PASSWORD.txt ]; then
  umask 077
  python3 -I -c "import secrets; print('-'.join(secrets.token_urlsafe(6).replace('-', 'x').replace('_', 'y') for _ in range(3)))" > REVIEW_PASSWORD.txt
fi
chmod 600 REVIEW_PASSWORD.txt
tr -d '\n' < REVIEW_PASSWORD.txt | "$W" secret put REVIEW_PASSWORD --config site/wrangler.toml
echo "Deployed. The password is in $ROOT/REVIEW_PASSWORD.txt"
