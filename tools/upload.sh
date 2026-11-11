#!/bin/bash
# First upload of a whole delivery to the private R2 bucket, after tools/build.py --export.
# Usage: tools/upload.sh <release tag>. Rerun at any time: finished batches are skipped.
# The site's state goes up in the last batch, so the site shows nothing until all art is up.
# ponytail: the Cloudflare API allows about 1,200 requests in 5 minutes, so this holds 3 per second, which is
# hours for tens of thousands of files. An R2 S3 token with `aws s3 sync` has no such limit.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/env.sh" && load_env "$ROOT/.env"
W="${WRANGLER:-wrangler}"
BUCKET=${R2_BUCKET:?set R2_BUCKET in .env}
TAG=${1:?usage: tools/upload.sh <release tag>}
BATCH="$ROOT/upload_batches"
SIZE=300
MIN_SECONDS=100
mkdir -p "$BATCH"
cd "$ROOT/site" || exit 1

if ! ls "$BATCH"/*.json >/dev/null 2>&1; then
  python3 -I - "$ROOT" "$BATCH" "$SIZE" "$TAG" <<'E' || exit 1
import json, sys
from pathlib import Path
root, batch, size, tag = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
items = json.loads((root / "site/items.json").read_text())
chosen = {d["id"] for d in items if d.get("mint")}
files = [{"key": f"Images/{p.relative_to(root / 'Images')}", "file": str(p)} for p in (root / "Images").rglob("*.png")]
files += [{"key": f"thumbs/{p.name}", "file": str(p)} for p in (root / "thumbs").glob("*.webp")]
def rank(x):
    k = x["key"]
    id_ = k.split("/")[-1][:5]
    thumb, combined = k.startswith("thumbs/"), "combined" in k
    # The chosen set's grid first, then its full size, then the other layers, then the rest.
    return (id_ not in chosen, not (thumb and combined), not combined, not thumb, k)
files.sort(key=rank)
n = 0
for n, i in enumerate(range(0, len(files), size)):
    (batch / f"{n:04d}.json").write_text(json.dumps(files[i:i + size]))
# The site reads this layout and pull_update.py moves it to its own on the first publish.
(batch / "current.txt").write_text(tag + "\n")
asset = sorted((root / "index").glob("ASSET_FILES*.csv"))[0]
meta = [{"key": "meta/index/ASSET_FILES.csv", "file": str(asset)}, {"key": "meta/current.txt", "file": str(batch / "current.txt")},
        {"key": "meta/items.json", "file": str(root / "site/items.json")}]
(batch / f"{n + 1:04d}.json").write_text(json.dumps(meta))
E
fi

for f in "$BATCH"/[0-9]*.json; do
  [ -f "$f.done" ] && continue
  start=$SECONDS
  if "$W" r2 bulk put "$BUCKET" --remote -f "$f" --concurrency 5 >> "$ROOT/upload_wrangler.log" 2>&1; then
    touch "$f.done"; echo "OK $(basename "$f") $(date +%H:%M:%S)"
    left=$((MIN_SECONDS - (SECONDS - start)))
    [ "$left" -gt 0 ] && sleep "$left"
  else
    # Stop before the last batch, which switches the site on. A rerun skips the finished batches.
    echo "FAILED $(basename "$f") $(date +%H:%M:%S). Read $ROOT/upload_wrangler.log, then rerun."
    exit 1
  fi
done
echo "DONE"
