#!/usr/bin/env python3
"""Publish only what changed in the artist's newest release to the review site.

  python3 -I tools/pull_update.py                  Check the artist's latest release. Changes nothing.
  python3 -I tools/pull_update.py --apply          Publish its changes to the live site.
  python3 -I tools/pull_update.py <tag> [--apply]  Use a named release instead of the latest.

The site's R2 bucket holds all state, so no local art is needed and the daily GitHub job
(.github/workflows/pull-art.yml) runs this with an empty disk.

Nothing in the bucket is ever overwritten. A run uploads the changed images and their thumbnails
to new keys under r/<run key>/, then writes meta/items.json, which names the release, its
manifest and where each item's files are. That one write switches the site to the new release.
A run that stops before it leaves the site on the old release, whole. Rerun to continue: the
uploads are the same for the same release on the same site, and meta/progress.txt counts them.

Settings come from the environment, or from a .env file in the repo root that is never committed:
DELIVERY_REPO (the artist's GitHub repo, owner/name), R2_BUCKET, and optionally WRANGLER (its command).
An optional tools/site_fields.py (or SITE_FIELDS) with refresh(item, manifest_row) copies project columns onto items.

The release needs one SHA256SUMS*.txt, an index ZIP with a complete manifest, and image ZIPs.
Nothing is uploaded until every changed file passed its checksum and was measured.
"""
import argparse, csv, functools, hashlib, importlib.util, json, os, re, shutil, subprocess, sys, tempfile, time, zipfile
from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).resolve().parent
TAG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
REL = re.compile(r"^ID(\d{5})/\1__(character|background|combined)\.png$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ASSET_FILES, ID_MANIFEST = "ASSET_FILES*.csv", "ID_DELIVERY_MANIFEST*.csv"
KINDS = ("character", "background", "combined")
BATCH_PATH = re.compile(r"(Batch_\d+_(\d{5})-(\d{5}))/(Backgrounds|Characters|Combined)/(\d{5})__(background|character|combined)\.png")
LAYER_DIRS = {"background": "Backgrounds", "character": "Characters", "combined": "Combined"}
STATE = "meta/items.json"
# The first upload (tools/upload.sh) writes meta/items.json as a bare list, the release to meta/current.txt and
# the manifest to meta/index/. The first publish reads that layout once and writes its own.
LEGACY_TAG, LEGACY_MANIFEST = "meta/current.txt", "meta/index/ASSET_FILES.csv"
PROGRESS = "meta/progress.txt"
# Free disk kept while unpacking. Tests raise it to force the out-of-disk refusal.
MIN_FREE = int(os.environ.get("GATEWAY_MIN_FREE", str(512 << 20)))
MISMATCH = 3  # the same limit as the gallery's "Combined differs from its layers" filter
UNMEASURED = 255.0  # the largest possible difference, so the gallery lists the item under that filter
TYPES = {".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain"}


class Refuse(Exception):
    """The delivery cannot be published safely. The message says why."""


class StoreError(Exception):
    """Cloudflare or GitHub failed. Rerunning is safe. detail holds the tool's own error text, which can name private
    accounts, so it is printed only outside GitHub Actions."""

    def __init__(self, message, detail=""):
        super().__init__(message)
        self.detail = detail


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def one(folder, pattern):
    hits = sorted(folder.glob(pattern))
    if len(hits) != 1:
        raise Refuse(f"expected one {pattern} in the index, found {len(hits)}")
    return hits[0]


def load_assets(folder):
    """Returns {relative path: sha256} after checking every row of a manifest from outside."""
    out = {}
    for row in read_csv(one(folder, ASSET_FILES)):
        rel, digest = row.get("relative_path", ""), row.get("sha256", "")
        if not REL.match(rel) or not HEX64.match(digest):
            mask(rel, digest)
            raise Refuse(f"bad manifest row: {rel!r} {digest!r}")
        if rel in out:
            raise Refuse(f"manifest lists {rel} twice")
        out[rel] = digest
    return out


def diff(old, new):
    """Returns (changed relative paths, removed relative paths). A new path counts as changed."""
    return sorted(k for k, v in new.items() if old.get(k) != v), sorted(set(old) - set(new))


def load_env():
    """Read .env in the repo root into the environment. A variable that is already set wins."""
    path = TOOLS.parent / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, sep, value = line.strip().partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if sep and not key.startswith("#"):
                os.environ.setdefault(key.strip(), value)


def mask(*values):
    """Hide release tags and file names in GitHub Actions logs, which are public for a public repo."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for value in values:
            if not value:
                continue
            # Messages print some values with repr(), which escapes backslashes and quotes, so mask those forms too.
            text = str(value)
            for form in dict.fromkeys((text, repr(text), repr(text)[1:-1])):
                # Workflow commands percent-decode their data, so encode it as GitHub requires. Unencoded, a value
                # with % would be masked wrongly, and one with a line break could start another command.
                data = form.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
                print(f"::add-mask::{data}", flush=True)


def setting(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise Refuse(f"set {name} in the environment or in .env")
    return value


class Bucket:
    """The live R2 bucket, through wrangler. Credentials come from wrangler's login or CLOUDFLARE_API_TOKEN."""
    # ponytail: one Cloudflare API call per 0.35 s keeps inside the 1,200 calls per 5 minutes limit. An update of a
    # few hundred items takes minutes; thousands take hours. An R2 S3 token and `aws s3 sync` is the upgrade path.
    GAP = 0.35

    def __init__(self, site):
        self.site, self.bin, self.bucket = site, os.environ.get("WRANGLER") or "wrangler", setting("R2_BUCKET")

    def _run(self, *args):
        time.sleep(self.GAP)
        return subprocess.run([self.bin, *args], cwd=self.site, capture_output=True, text=True)

    def get(self, key, dest):
        # wrangler runs in site/, so every local path must be absolute.
        r = self._run("r2", "object", "get", f"{self.bucket}/{key}", "--remote", "--file", str(Path(dest).resolve()))
        if r.returncode == 0:
            return True
        if "specified key does not exist" in r.stdout + r.stderr:
            return False
        raise StoreError(f"cannot read {key}", (r.stderr or r.stdout).strip()[-300:])

    def put(self, key, path):
        r = self._run("r2", "object", "put", f"{self.bucket}/{key}", "--remote", "--file", str(Path(path).resolve()), "--content-type", TYPES[Path(key).suffix])
        if r.returncode:
            raise StoreError(f"cannot write {key}", (r.stderr or r.stdout).strip()[-300:])

    def put_many(self, entries, work):
        """Acknowledge bounded bulk uploads before the caller writes a ZIP checkpoint."""
        for suffix in (".png", ".webp"):
            files = [{"key": key, "file": str(path.resolve())} for key, path in entries if Path(key).suffix == suffix]
            for start in range(0, len(files), 300):
                batch = files[start:start + 300]
                manifest = work / "bulk-upload.json"
                manifest.write_text(json.dumps(batch))
                began = time.monotonic()
                r = self._run("r2", "bulk", "put", self.bucket, "--remote", "--filename", str(manifest.resolve()),
                              "--concurrency", "5", "--content-type", TYPES[suffix])
                if r.returncode:
                    raise StoreError("cannot upload artwork batch", (r.stderr or r.stdout).strip()[-300:])
                # Keep the same conservative request budget across separate CLI invocations and MIME groups.
                time.sleep(max(0, len(batch) * self.GAP - (time.monotonic() - began)))


class Folder:
    """A folder that stands in for the bucket, for tests. GATEWAY_FAIL_AFTER=n makes the write after n writes fail."""

    def __init__(self, root):
        self.root, self.puts = Path(root), 0
        self.fail_after = int(os.environ.get("GATEWAY_FAIL_AFTER", "-1"))

    def get(self, key, dest):
        src = self.root / key
        if not src.is_file():
            return False
        shutil.copyfile(src, dest)
        return True

    def put(self, key, path):
        if self.puts == self.fail_after:
            raise StoreError(f"test failure before writing {key}")
        self.puts += 1
        (self.root / key).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, self.root / key)

    def put_many(self, entries, work):
        for key, path in entries:
            self.put(key, path)


def get_text(store, key, work):
    tmp = work / "text.tmp"
    return tmp.read_text().strip() if store.get(key, tmp) else ""


def put_text(store, key, text, work):
    tmp = work / "text.tmp"
    tmp.write_text(text + "\n")
    store.put(key, tmp)


class Source:
    def __init__(self, repo, folder):
        self.repo, self.folder = (None if folder else repo or setting("DELIVERY_REPO")), folder
        if self.repo:
            mask(self.repo, *self.repo.split("/"))  # the owner alone can show up in GitHub's own errors

    def gh(self, *args):
        r = subprocess.run(["gh", *args, "-R", self.repo], capture_output=True, text=True)
        if r.returncode:
            raise StoreError("cannot read the artist's releases", r.stderr.strip()[-300:])
        return r.stdout

    def latest(self):
        if self.folder:
            raise Refuse("name the tag when --source is a folder")
        return self.gh("release", "view", "--json", "tagName", "--jq", ".tagName").strip()

    def assets(self, tag):
        if self.folder:
            return [p.name for p in Path(self.folder).iterdir() if p.is_file()]
        return self.gh("release", "view", tag, "--json", "assets", "--jq", ".assets[].name").splitlines()

    def fetch(self, tag, name, dest):
        if self.folder:
            shutil.copyfile(Path(self.folder) / name, dest / name)
        else:
            self.gh("release", "download", tag, "-p", name, "-D", str(dest), "--clobber")
        return dest / name


def read_sums(path):
    sums = {}
    # "<sha256>  <name>", where the name can hold spaces and a leading * marks binary mode.
    for line in path.read_text().splitlines():
        digest, _, name = line.strip().partition(" ")
        name = name.strip().lstrip("*")
        if HEX64.match(digest.lower()) and name:
            sums[name] = digest.lower()
    return sums


def fetch_verified(source, tag, name, dest, sums):
    if name not in sums:
        raise Refuse(f"{name} is not in SHA256SUMS.txt")
    path = source.fetch(tag, name, dest)
    if sha(path) != sums[name]:
        raise Refuse(f"{name} does not match SHA256SUMS.txt")
    return path


def extract_index(zip_path, dest):
    """Extract only top-level files with safe names."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for m in z.infolist():
            if not m.is_dir() and re.fullmatch(r"[\w.-]+\.(csv|md|txt)", m.filename):
                (dest / m.filename).write_bytes(z.read(m))


def extract_batch_manifest(zip_path, dest, names, sums):
    """Normalize the replacement delivery into the existing, checked CSV publishing contract.

    Return its exact ZIP-entry to canonical-path mapping; no delivery path is used as a local path.
    """
    with zipfile.ZipFile(zip_path) as z:
        member = "Metadata/Final_Asset_Manifest.json"
        if z.namelist().count(member) != 1:
            raise Refuse("batch manifest is missing or duplicated")
        try:
            rows = json.loads(z.read(member))
        except (ValueError, UnicodeError):
            raise Refuse("batch manifest is not valid JSON")
    if not isinstance(rows, list) or not rows:
        raise Refuse("batch manifest must be a nonempty list")
    members, assets, items, archives = {}, {}, {}, {}
    for row in rows:
        if not isinstance(row, dict):
            raise Refuse("bad batch manifest row")
        id_, kind, path, digest = (row.get(k) for k in ("ID", "layer", "relative_path", "SHA256"))
        if (not isinstance(id_, str) or not re.fullmatch(r"\d{5}", id_) or kind not in KINDS
                or not isinstance(path, str) or not isinstance(digest, str) or not HEX64.fullmatch(digest)):
            raise Refuse("bad batch manifest identity or checksum")
        match = batch_path(path, id_, kind)
        if not match:
            raise Refuse("batch manifest path does not match its ID, layer or range")
        archive = f"{match[1]}.zip"
        if archive not in names or archive not in sums:
            raise Refuse("batch manifest names an unavailable or unchecked archive")
        rel = f"ID{id_}/{id_}__{kind}.png"
        if rel in assets:
            raise Refuse("batch manifest repeats an ID and layer")
        members[path], assets[rel] = rel, digest
        item = items.setdefault(id_, {"ID": id_})
        item[f"{kind}_relative_path"], item[f"{kind}_sha256"] = rel, digest
        archives[archive] = {"archive": archive, "first_ID": match[2], "last_ID": match[3]}
    if any(any(f"{kind}_relative_path" not in item for kind in KINDS) for item in items.values()):
        raise Refuse("batch manifest is missing an item's layer")
    dest.mkdir(parents=True, exist_ok=True)
    tables = [("ASSET_FILES.csv", ["relative_path", "sha256"],
               [{"relative_path": rel, "sha256": assets[rel]} for rel in sorted(assets)]),
              ("ID_DELIVERY_MANIFEST.csv", ["ID"] + [f"{k}_{field}" for k in KINDS for field in ("relative_path", "sha256")],
               [items[id_] for id_ in sorted(items)]),
              ("ARCHIVE_PLAN.csv", ["archive", "first_ID", "last_ID"], [archives[a] for a in sorted(archives)])]
    for name, fields, records in tables:
        with open(dest / name, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(records)
    return members


def batch_path(path, id_, kind):
    match = BATCH_PATH.fullmatch(path or "")
    if (match and match[5] == id_ and match[6] == kind and match[4] == LAYER_DIRS[kind]
            and match[2] <= id_ <= match[3]):
        return match
    return None


def correction_manifest(source, tag, archive, expected_ids, names, old, work, dest):
    index, checksum = "FILE_INDEX.csv", f"{archive}.sha256"
    if not {archive, index, checksum}.issubset(names):
        raise Refuse("the correction release needs the selected ZIP, its SHA256 file and FILE_INDEX.csv")
    sums = read_sums(source.fetch(tag, checksum, work))
    if set(sums) != {archive}:
        raise Refuse("the correction checksum file must name only the selected ZIP")

    assets, members, ids = dict(old), {}, {}
    for row in read_csv(source.fetch(tag, index, work)):
        id_, kind, path, digest = (row.get(k) for k in ("ID", "Layer", "Replacement path", "SHA256"))
        if kind not in KINDS or not batch_path(path, id_, kind) or not HEX64.fullmatch(digest or ""):
            raise Refuse("invalid identity, path or SHA256 in the correction index")
        rel = f"ID{id_}/{id_}__{kind}.png"
        if rel not in old:
            raise Refuse("a correction must replace a file in the existing manifest")
        layers = ids.setdefault(id_, set())
        if kind in layers:
            raise Refuse("a correction repeats an ID and layer")
        layers.add(kind)
        members[path], assets[rel] = rel, digest
    if len(ids) != expected_ids:
        raise Refuse(f"expected {expected_ids} correction IDs, found {len(ids)}")
    if any(layers != set(KINDS) for layers in ids.values()):
        raise Refuse("every correction must include all three layers")

    dest.mkdir()
    items = {}
    with (dest / "ASSET_FILES.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["relative_path", "sha256"])
        for rel, digest in sorted(assets.items()):
            id_, kind = REL.fullmatch(rel).groups()
            writer.writerow([rel, digest])
            item = items.setdefault(id_, {"ID": id_})
            item[f"{kind}_relative_path"], item[f"{kind}_sha256"] = rel, digest
    with (dest / "ID_DELIVERY_MANIFEST.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["ID"] + [f"{k}_{field}" for k in KINDS for field in ("relative_path", "sha256")])
        writer.writeheader()
        writer.writerows(items.values())
    return sums, members


def check_manifests_agree(new, new_index):
    """Both manifests must name the same files and checksums, or measuring would fail later."""
    listed = {}
    for row in read_csv(one(new_index, ID_MANIFEST)):
        for kind in KINDS:
            rel = row.get(f"{kind}_relative_path", "")
            # A row that names another item's file would build this item's thumbnail from it.
            m = REL.match(rel)
            if not m or m[1] != row.get("ID") or m[2] != kind:
                mask(row.get("ID"), rel)
                raise Refuse(f"ID {row.get('ID')!r} lists {rel!r} as its {kind}")
            listed[rel] = row.get(f"{kind}_sha256", "")
    bad = [rel for rel, digest in new.items() if listed.get(rel) != digest] + [rel for rel in listed if rel not in new]
    if bad:
        raise Refuse(f"the two manifests disagree on {len(bad)} files, first: {bad[:5]}")


def choose_zips(names, changed, index_dir):
    """Use his archive plan when it names a ZIP in this release, so that a rebuilt set downloads only what it must."""
    image_zips = sorted(n for n in names if n.endswith(".zip") and "index" not in n.lower())
    plan = sorted(index_dir.glob("ARCHIVE_PLAN*.csv"))
    if plan:
        ids = {REL.match(rel)[1] for rel in changed}
        rows = read_csv(plan[0])
        # A plan row without its ID range picks nothing, so the run falls back to every image ZIP.
        picked = sorted({r["archive"] for r in rows if r.get("archive") in image_zips and r.get("first_ID") and r.get("last_ID")
                         and any(r["first_ID"] <= i <= r["last_ID"] for i in ids)})
        if picked:
            return picked
    return image_zips


def check_staged(rels, staging, want):
    bad = [rel for rel in rels if sha(staging / rel) != want[rel]]
    if bad:
        raise Refuse(f"{len(bad)} changed files are missing or fail their checksum, first: {bad[:5]}")
    for rel in rels:
        try:
            with Image.open(staging / rel) as img:
                img.load()
        except Exception as e:
            raise Refuse(f"{rel} is not a readable image: {e}")


@functools.cache
def load_module(name, path=None):
    spec = importlib.util.spec_from_file_location(f"gateway_{name}", path or TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def image_key(item, kind):
    """Where an item's published file is. No prefix means the key from before versioned uploads."""
    id_ = item["id"]
    return f"{item.get('v', {}).get(kind, '')}Images/ID{id_}/{id_}__{kind}.png"


def load_state(store, work):
    """Returns (the site's state, {relative path: sha256} of what it shows)."""
    path, base = work / "state.json", work / "base"
    base.mkdir()
    if not store.get(STATE, path):
        raise Refuse(f"the site has no {STATE}")
    state = json.loads(path.read_text())
    if isinstance(state, list):
        tag = get_text(store, LEGACY_TAG, work)
        if not tag or not store.get(LEGACY_MANIFEST, base / "ASSET_FILES.csv"):
            raise Refuse(f"the site has no {LEGACY_TAG} or {LEGACY_MANIFEST}")
        state = {"tag": tag, "manifest": "", "items": state}
    elif not (TAG.match(state.get("tag", "")) and HEX64.match(state.get("manifest", ""))
              and store.get(f"meta/manifests/{state['manifest']}.csv", base / "ASSET_FILES.csv")):
        raise Refuse(f"{STATE} names no release or no stored manifest. Check the bucket by hand.")
    return state, load_assets(base)


def measure(store, ids, rows, staging, work, by_id, thumbs):
    """Measure each changed item from its new files plus its published files, and write its thumbnails. Any error refuses."""
    build = load_module("build")
    build.IMAGES, build.THUMBS = work / "measure", thumbs
    build.THUMBS.mkdir(exist_ok=True)
    results = {}
    for id_ in ids:
        row = rows[id_]
        for kind in KINDS:
            rel = row[f"{kind}_relative_path"]
            dest = build.IMAGES / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if (staging / rel).exists():
                shutil.copyfile(staging / rel, dest)
            elif not store.get(image_key(by_id[id_], kind), dest):
                raise Refuse(f"the site has no {image_key(by_id[id_], kind)}, so ID {id_} cannot be measured")
        result = build.measure(row)
        if result["errors"]:
            raise Refuse(f"ID {id_}: {result['errors']}")
        results[id_] = result
        shutil.rmtree(build.IMAGES / f"ID{id_}")
    return results


def patch_items(by_id, rows, results, changed, prefix, tag, at, *, refresh_fields):
    """Point changed items at their new files, and refresh delivery notes for all and measurements for changed."""
    # Each project decides which manifest columns the gallery shows, in its own tools/site_fields.py
    # (or the file that SITE_FIELDS names). tools/site_fields.example.py shows the shape.
    fields = Path(os.environ.get("SITE_FIELDS") or TOOLS / "site_fields.py")
    if refresh_fields and os.environ.get("SITE_FIELDS") and not fields.is_file():
        raise Refuse(f"SITE_FIELDS names {fields}, which is not a file. Use an absolute path.")
    if refresh_fields and fields.exists():
        refresh = load_module("site_fields", fields).refresh
        for id_, row in rows.items():
            if id_ in by_id:
                try:
                    refresh(by_id[id_], row)
                except (Exception, SystemExit) as e:  # sys.exit("...") would print its message
                    # The hook's own error text can name private columns, so only its type is shown.
                    raise Refuse(f"{fields.name} failed on ID {id_} with {type(e).__name__}. Run it locally to see why.")
    for id_, r in results.items():
        kinds = sorted(REL.match(rel)[2] for rel in changed if REL.match(rel)[1] == id_)
        d = by_id[id_]
        d["v"] = {**d.get("v", {}), **{k: prefix for k in kinds}}
        # build.py leaves composite_diff empty when the layers cannot be compared with the combined image. Show
        # that as a file error and as a mismatch, not as a perfect match.
        measured = r.get("composite_diff") not in ("", None)
        d.update(tv=prefix, upd={"tag": tag, "kinds": kinds, "at": at},
                 size=r.get("combined_size", ""), contrast=float(r.get("contrast") or 0),
                 coverage=float(r.get("coverage") or 0), diff=float(r["composite_diff"]) if measured else UNMEASURED,
                 clip=[s for s in ("left", "top", "right") if r.get(f"touch_{s}")],
                 errors="" if measured else "the combined image cannot be compared with its layers (different sizes?)")


def run(a, store, work):
    source = Source(a.repo, a.source)
    tag = a.tag or source.latest()
    mask(tag)
    if not TAG.match(tag):
        raise Refuse(f"bad tag {tag!r}")
    state, old = load_state(store, work)
    current = state["tag"]
    mask(current)
    archive = getattr(a, "corrections", None)
    if archive and current != a.base_tag:
        raise Refuse("the live full-delivery baseline does not match the requested baseline")
    if not archive and tag == current:
        print(f"{tag} is the published delivery. Nothing to do.")
        return 0

    download, new_index, staging = work / "download", work / "index", work / "staging"
    for folder in (download, staging):
        folder.mkdir()
    names = source.assets(tag)
    mask(*names)
    batch_members = None
    if archive:
        sums, batch_members = correction_manifest(source, tag, archive, a.expected_ids, names, old, download, new_index)
    else:
        # Accept the delivery's project prefix as well as the original checksum names.
        sum_files = [n for n in names if re.fullmatch(r"(?:[\w.-]+_)?SHA256SUMS[\w.-]*\.txt", n)]
        if len(sum_files) != 1:
            raise Refuse(f"the release needs one SHA256SUMS file, found {sum_files or 'none'}")
        sums = read_sums(source.fetch(tag, sum_files[0], download))
        index_zip = [n for n in names if n.endswith(".zip") and ("index" in n.lower() or n == "Metadata.zip")]
        if len(index_zip) != 1:
            raise Refuse(f"expected one index ZIP, found {index_zip}")
        index_path = fetch_verified(source, tag, index_zip[0], download, sums)
        if index_zip[0] == "Metadata.zip":
            batch_members = extract_batch_manifest(index_path, new_index, names, sums)
        else:
            extract_index(index_path, new_index)

    new = load_assets(new_index)
    changed, removed = diff(old, new)
    if removed:
        raise Refuse(f"the new manifest drops {len(removed)} files, first: {removed[:5]}. Ask the artist for a complete manifest.")
    check_manifests_agree(new, new_index)
    manifest = sha(one(new_index, ASSET_FILES))
    ids = sorted({REL.match(rel)[1] for rel in changed})
    if archive:
        mask(*ids)
    zips = ([archive] if archive else choose_zips(names, changed, new_index)) if changed else []
    print(f"{tag}: {len(changed)} changed files in {len(ids)} IDs. {len(new) - len(changed)} unchanged. Published now: {current}.")
    if ids and os.environ.get("GITHUB_ACTIONS") != "true":  # public logs get the counts only
        print("IDs:", " ".join(ids[:50]) + (" ..." if len(ids) > 50 else ""))
        print("ZIPs needed:", " ".join(zips) or "none")
    if not a.apply:
        print("Dry run. Nothing changed. Add --apply to publish.")
        return 0
    if archive and not changed:
        return 0
    if changed and not zips:
        raise Refuse("files changed, but the release has no image ZIP")

    rows = {r["ID"]: r for r in read_csv(one(new_index, ID_MANIFEST))}
    by_id = {d["id"]: d for d in state["items"]}
    for id_ in ids:
        if id_ not in rows:
            raise Refuse(f"ID {id_} has changed files but is not in the ID manifest")
        if id_ not in by_id:
            raise Refuse(f"ID {id_} is not on the site. New items need a fresh import: see the README.")

    # Nothing uploaded under r/ shows until meta/items.json names it. Each ZIP's changed files and thumbnails
    # are uploaded in bounded batches before its checkpoint. Disk holds one ZIP plus its outgoing files and
    # any incomplete items waiting for a later ZIP.
    # The run key depends only on what the site shows, this release and its ZIP list, so every upload under it has
    # fixed content and a saved ZIP count always means the same ZIPs. Two runs never write different bytes to one key.
    zip_list = ",".join(f"{z}={sums[z]}" for z in zips)  # a repaired ZIP with the same name starts fresh
    run_key = hashlib.sha256(f"{current}:{state['manifest']}:{manifest}:{zip_list}".encode()).hexdigest()[:16]
    prefix = f"r/{run_key}/"
    progress = get_text(store, PROGRESS, work).split()
    done = int(progress[1]) if len(progress) == 2 and progress[0] == run_key and progress[1].isdigit() else 0
    if done:
        print(f"Resuming after {min(done, len(zips))} of {len(zips)} ZIPs.")
    store.put(f"meta/manifests/{manifest}.csv", one(new_index, ASSET_FILES))
    changed_ids = set(ids)
    wanted = ({path: rel for path, rel in batch_members.items() if REL.match(rel)[1] in changed_ids}
              if batch_members is not None else {f"Images/{rel}": rel for rel in changed})
    needs = {i: {rel for rel in changed if REL.match(rel)[1] == i} for i in ids}
    required = ({i: {f"ID{i}/{i}__{kind}.png" for kind in KINDS} for i in ids}
                if batch_members is not None else needs)
    results, staged, unexpected, batch_file = {}, set(), [], work / "batch.json"
    outgoing, uploads = work / "outgoing", []

    def queue_upload(key, path):
        dest = outgoing / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(path, dest)
        uploads.append((key, dest))

    def publish_item(id_):
        rels = sorted(needs[id_])
        check_staged(sorted(required[id_]), staging, new)
        thumbs = work / "thumbs"
        result = measure(store, [id_], rows, staging, work, by_id, thumbs)
        for rel in rels:
            queue_upload(f"{prefix}Images/{rel}", staging / rel)
        for p in sorted(thumbs.iterdir()):
            queue_upload(f"{prefix}thumbs/{p.name}", p)
        shutil.rmtree(thumbs)
        for rel in required[id_]:
            (staging / rel).unlink(missing_ok=True)
        staged.difference_update(required[id_])
        return result

    for n, name in enumerate(zips):
        if n < done:
            if not store.get(f"{prefix}results/{n}.json", batch_file):
                raise Refuse(f"{PROGRESS} says ZIP {n} is done, but {prefix}results/{n}.json is missing. Empty {PROGRESS} and rerun.")
            results.update(json.loads(batch_file.read_text()))
            continue
        path, batch = fetch_verified(source, tag, name, download, sums), {}
        with zipfile.ZipFile(path) as z:
            if archive:
                images = [m.filename for m in z.infolist() if not m.is_dir() and m.filename.lower().endswith(".png")]
                if len(images) != len(batch_members) or set(images) != set(batch_members):
                    raise Refuse("the correction ZIP does not contain exactly the indexed PNGs")
            for m in z.infolist():
                rel = None if m.is_dir() else wanted.get(m.filename)
                if rel is None:
                    if not m.is_dir() and not ((batch_members is not None and m.filename in batch_members)
                            or (m.filename.startswith("Images/") and REL.match(m.filename[7:]))):
                        unexpected.append(m.filename)
                    continue
                id_ = REL.match(rel)[1]
                if id_ in results or rel in staged:
                    continue  # another ZIP already held it
                free = shutil.disk_usage(staging).free
                if free < m.file_size + MIN_FREE:
                    raise Refuse(f"only {free >> 20} MB of disk is free, too little to unpack {m.filename}. Items whose files are "
                                 f"spread over several ZIPs stay on disk until complete. Run on a machine with more disk.")
                out = staging / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                staged.add(rel)
                # An item is ready when all its changed files are unpacked. One that spans two ZIPs waits.
                if required[id_] <= staged:
                    batch.update(publish_item(id_))
                    results.update(batch)
        path.unlink()
        store.put_many(uploads, work)
        uploads.clear()
        shutil.rmtree(outgoing, ignore_errors=True)
        batch_file.write_text(json.dumps(batch))
        store.put(f"{prefix}results/{n}.json", batch_file)
        # Save only when nothing waits on disk, so that a resumed run never needs files it deleted.
        if not staged:
            put_text(store, PROGRESS, f"{run_key} {n + 1}", work)
    if unexpected:
        # Entry names can name the project, so public Actions logs get the count only.
        shown = "" if os.environ.get("GITHUB_ACTIONS") == "true" else f", first: {unexpected[:5]}"
        print(f"Ignored {len(unexpected)} unexpected ZIP entries{shown}")
    missing = sorted(rel for i in ids if i not in results for rel in needs[i])
    if missing:
        raise Refuse(f"{len(missing)} changed files are missing or fail their checksum, first: {missing[:5]}")

    patch_items(by_id, rows, results, changed, prefix, tag, int(time.time()), refresh_fields=not archive)
    # Keep the upstream tag so the scheduled full-delivery pull does not undo these corrections.
    state.update(tag=current if archive else tag, manifest=manifest)
    path = work / "state.json"
    path.write_text(json.dumps(state, separators=(",", ":")))
    # This one write switches the site to the new release. Before it, the site shows the old release, whole.
    store.put(STATE, path)
    try:
        put_text(store, PROGRESS, "", work)
    except StoreError:
        pass  # Its run key names the old release, so no later run can match it.


    bad = [i for i, r in results.items() if r.get("composite_diff") in ("", None) or float(r["composite_diff"]) > MISMATCH]
    if bad:
        shown = "" if os.environ.get("GITHUB_ACTIONS") == "true" else f": {bad[:20]}"
        print(f"WARNING: {len(bad)} IDs have a combined image that differs from background + character{shown}")
    print(f"Published {tag}: {len(changed)} files in {len(ids)} items. The replaced files stay in the bucket.")
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("tag", nargs="?", help="a release tag. Default: the artist's latest release")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--repo", help="the artist's repo, owner/name. Default: DELIVERY_REPO")
    p.add_argument("--source", help="read the release from this folder, for tests")
    p.add_argument("--store", help="use this folder instead of the live bucket, for tests")
    p.add_argument("--corrections", metavar="ZIP", help="overlay this corrections-only release asset")
    p.add_argument("--base-tag", help="required live full-delivery tag for a corrections overlay")
    p.add_argument("--expected-ids", type=int, help="required number of correction IDs")
    a = p.parse_args()
    if a.corrections:
        if (not a.tag or not a.base_tag or not TAG.fullmatch(a.base_tag) or not a.expected_ids or a.expected_ids < 1
                or not re.fullmatch(r"[\w.-]+\.zip", a.corrections)):
            p.error("corrections require an explicit tag, a ZIP filename, --base-tag and a positive --expected-ids")
    elif a.base_tag is not None or a.expected_ids is not None:
        p.error("--base-tag and --expected-ids are used only with --corrections")
    work = Path(tempfile.mkdtemp(prefix="gateway-pull-"))
    try:
        load_env()
        store = Folder(a.store) if a.store else Bucket(TOOLS.parent / "site")
        return run(a, store, work)
    except Refuse as e:
        print(f"REFUSED: {e}\nThe site still shows the release it showed before.", file=sys.stderr)
        return 2
    except StoreError as e:
        detail = "" if os.environ.get("GITHUB_ACTIONS") == "true" or not e.detail else f": {e.detail}"
        print(f"FAILED: {e}{detail}\nThe site still shows the release it showed before. Rerun to continue.", file=sys.stderr)
        return 3
    except Exception as e:
        # A traceback can hold private names, and Actions logs are public, so they get the error type only.
        if os.environ.get("GITHUB_ACTIONS") != "true":
            raise
        print(f"FAILED: unexpected {type(e).__name__}. Run pull_update.py locally to see the details.", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
