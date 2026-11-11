#!/usr/bin/env python3
"""First import: extract the delivery ZIPs, verify every PNG, make thumbnails and measure each ID.

Run: python3 -I tools/build.py            (rerun at any time, finished work is skipped)
     python3 -I tools/build.py --export   then write site/items.json for tools/upload.sh
Input: zips/ (tools/download.sh) and index/ (the release's index ZIP, extracted)
Output: Images/, thumbs/, analysis.csv, build_report.json
"""
import csv, hashlib, importlib.util, json, os, re, shutil, sys, zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parent.parent
ZIPS, IMAGES, THUMBS = ROOT / "zips", ROOT / "Images", ROOT / "thumbs"
MEMBER = re.compile(r"^Images/ID\d{5}/\d{5}__(character|background|combined)\.png$")
THUMB_PX = 360


def extract(zip_path):
    """Copy only members with the expected shape. Anything else is reported, not written."""
    unexpected, written = [], 0
    with zipfile.ZipFile(zip_path) as z:
        for m in z.infolist():
            if m.is_dir():
                continue
            if not MEMBER.match(m.filename):
                unexpected.append(m.filename)
                continue
            out = ROOT / m.filename
            if out.exists() and out.stat().st_size == m.file_size:
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            written += 1
    return zip_path.name, written, unexpected


def measure(row):
    id_ = row["ID"]
    out = {"ID": id_, "errors": []}
    imgs = {}
    for kind in ("character", "background", "combined"):
        path = IMAGES / row[f"{kind}_relative_path"]
        try:
            data = path.read_bytes()
        except OSError as e:
            out["errors"].append(f"{kind}: missing ({e})")
            continue
        if hashlib.sha256(data).hexdigest() != row[f"{kind}_sha256"]:
            out["errors"].append(f"{kind}: sha256 mismatch")
        img = Image.open(path)
        img.load()
        imgs[kind] = img
        out[f"{kind}_size"] = f"{img.width}x{img.height}"
        out[f"{kind}_mode"] = img.mode
        thumb = THUMBS / f"{id_}_{kind}.webp"
        if not thumb.exists():
            t = img.copy()
            t.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
            t.save(thumb, "WEBP", quality=82, method=4)
    if len(imgs) < 3:
        return out

    char = imgs["character"].convert("RGBA")
    bg = imgs["background"].convert("RGBA")
    comb = imgs["combined"].convert("RGBA")
    alpha = char.getchannel("A")
    box = alpha.point(lambda a: 255 if a > 16 else 0).getbbox()
    out["has_alpha"] = alpha.getextrema()[0] < 255
    out["bbox"] = ",".join(map(str, box)) if box else ""
    if box:
        out["touch_left"] = box[0] <= 1
        out["touch_top"] = box[1] <= 1
        out["touch_right"] = box[2] >= char.width - 1
        out["touch_bottom"] = box[3] >= char.height - 1
    S = (256, 256)
    small_a = alpha.resize(S, Image.BILINEAR)
    out["coverage"] = round(ImageStat.Stat(small_a).mean[0] / 255, 4)

    # Does combined equal background + character? High value = wrong pairing or a stale file.
    if char.size == bg.size == comb.size:
        rebuilt = Image.alpha_composite(bg, char).convert("RGB")
        diff = ImageChops.difference(rebuilt.resize(S), comb.convert("RGB").resize(S)).convert("L")
        out["composite_diff"] = round(ImageStat.Stat(diff).mean[0], 3)
    else:
        out["composite_diff"] = ""

    # Contrast: how far the character differs from the background behind it. Low = hard to read.
    d = ImageChops.difference(comb.convert("RGB").resize(S), bg.convert("RGB").resize(S)).convert("L")
    stat = ImageStat.Stat(d, small_a.point(lambda a: 255 if a > 200 else 0))
    out["contrast"] = round(stat.mean[0], 2) if stat.count[0] else 0

    return out


def id_manifest():
    """The release's ID manifest. Its name can carry a suffix, as in ID_DELIVERY_MANIFEST_round2.csv."""
    hits = sorted((ROOT / "index").glob("ID_DELIVERY_MANIFEST*.csv"))
    if len(hits) != 1:
        sys.exit(f"expected one index/ID_DELIVERY_MANIFEST*.csv, found {len(hits)}")
    return list(csv.DictReader(open(hits[0], encoding="utf-8-sig")))


def load_env():
    """The same .env rules as pull_update.py, so that SITE_FIELDS set there applies here too."""
    spec = importlib.util.spec_from_file_location("pull_update", ROOT / "tools/pull_update.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.load_env()


def export():
    """Write site/items.json from analysis.csv, with the project's fields from tools/site_fields.py when present."""
    load_env()
    manifest = {r["ID"]: r for r in id_manifest()}
    fields = Path(os.environ.get("SITE_FIELDS") or ROOT / "tools/site_fields.py")
    if os.environ.get("SITE_FIELDS") and not fields.is_file():
        sys.exit(f"SITE_FIELDS names {fields}, which is not a file. Use an absolute path.")
    refresh = None
    if fields.exists():
        spec = importlib.util.spec_from_file_location("site_fields", fields)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        refresh = mod.refresh
    items = []
    for a in csv.DictReader(open(ROOT / "analysis.csv")):
        if not re.fullmatch(r"\d{5}", a["ID"]):
            print(f"skipped an ID that is not five digits: {a['ID']!r}")
            continue
        d = {"id": a["ID"], "size": a.get("combined_size", ""), "contrast": float(a.get("contrast") or 0),
             "coverage": float(a.get("coverage") or 0),
             "diff": float(a["composite_diff"]) if a.get("composite_diff") else 255.0,
             "clip": [s for s in ("left", "top", "right") if a.get(f"touch_{s}") == "True"],
             "errors": a.get("errors", ""), "traits": {}}
        if refresh and a["ID"] in manifest:
            refresh(d, manifest[a["ID"]])
        items.append(d)
    (ROOT / "site/items.json").write_text(json.dumps(items, separators=(",", ":")))
    print(f"wrote {len(items)} items to site/items.json")
    return 0


def main():
    if sys.argv[1:] == ["--export"]:
        return export()
    THUMBS.mkdir(exist_ok=True)
    # Optional arguments name ZIPs for a pilot run, for example: build.py Images_01.zip
    zips = [ZIPS / n for n in sys.argv[1:]] or sorted(p for p in ZIPS.glob("*.zip") if "index" not in p.name.lower())
    with ProcessPoolExecutor() as pool:
        unexpected = []
        for name, written, bad in pool.map(extract, zips):
            print(f"{name}: wrote {written}, unexpected {len(bad)}", flush=True)
            unexpected += bad
        manifest = id_manifest()
        present = [r for r in manifest if (IMAGES / r["combined_relative_path"]).exists()]
        print(f"measuring {len(present)} of {len(manifest)} IDs", flush=True)
        rows = []
        for i, r in enumerate(pool.map(measure, present, chunksize=20), 1):
            rows.append(r)
            if i % 1000 == 0:
                print(f"  {i}", flush=True)
    fields = sorted({k for r in rows for k in r})
    fields.remove("ID")
    with open(ROOT / "analysis.csv", "w", newline="") as f:
        w = csv.DictWriter(f, ["ID"] + fields)
        w.writeheader()
        for r in rows:
            w.writerow({**r, "errors": "; ".join(r["errors"])})
    errors = [r for r in rows if r["errors"]]
    report = {"zips": len(zips), "manifest_ids": len(manifest), "measured": len(rows),
              "unexpected_members": unexpected, "ids_with_errors": [(r["ID"], r["errors"]) for r in errors]}
    (ROOT / "build_report.json").write_text(json.dumps(report, indent=1))
    print(f"DONE measured={len(rows)} errors={len(errors)} unexpected={len(unexpected)}", flush=True)
    return 1 if errors or unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
