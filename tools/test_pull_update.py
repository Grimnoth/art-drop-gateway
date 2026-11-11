#!/usr/bin/env python3
"""Tests pull_update.py against fake deliveries and a folder that stands in for the R2 bucket.
Touches no real art, no live site and no GitHub.

Run: python3 -I tools/test_pull_update.py
"""
import csv, hashlib, io, json, os, subprocess, sys, tempfile, zipfile
from pathlib import Path

from PIL import Image

TOOL = Path(__file__).resolve().parent / "pull_update.py"
IDS = ["00001", "00002", "00003"]
KINDS = ("character", "background", "combined")
failures = 0


def png(color, mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, (32, 32), color).save(buf, "PNG")
    return buf.getvalue()


def triplet(shade):
    """A character with a clear pixel area, its background, and the matching combined image."""
    char = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    char.paste((shade, 0, 0, 255), (8, 8, 24, 32))
    bg = Image.new("RGBA", (32, 32), (0, 0, shade, 255))
    comb = Image.alpha_composite(bg, char).convert("RGB")
    out = {}
    for k, img in zip(KINDS, (char, bg.convert("RGB"), comb)):
        b = io.BytesIO()
        img.save(b, "PNG")
        out[k] = b.getvalue()
    return out


def rel(id_, kind):
    return f"ID{id_}/{id_}__{kind}.png"


def manifests(art, qc="VISUAL_PASS"):
    """art maps ID to a triplet. Returns the two index files."""
    a = io.StringIO()
    w = csv.writer(a)
    w.writerow(["ID", "type", "relative_path", "size_bytes", "sha256"])
    m = io.StringIO()
    mw = csv.writer(m)
    mw.writerow(["ID"] + [f"{k}_{x}" for k in KINDS for x in ("relative_path", "sha256")] + ["character_QC_reason"])
    for id_, t in sorted(art.items()):
        row = [id_]
        for k in KINDS:
            d = hashlib.sha256(t[k]).hexdigest()
            w.writerow([id_, k, rel(id_, k), len(t[k]), d])
            row += [rel(id_, k), d]
        mw.writerow(row + [qc])
    return {"ASSET_FILES_9.csv": a.getvalue(), "ID_DELIVERY_MANIFEST.csv": m.getvalue()}


def make_store(base):
    """A bucket in the layout from before versioned uploads, showing release 'first'."""
    store = base / "store"
    art = {i: triplet(50 + n * 40) for n, i in enumerate(IDS)}
    idx = manifests(art)
    (store / "meta/index").mkdir(parents=True)
    (store / "meta/index/ASSET_FILES.csv").write_text(idx["ASSET_FILES_9.csv"])
    (store / "meta/current.txt").write_text("first\n")
    items = [{"id": i, "size": "old", "contrast": 0, "coverage": 0, "diff": 9, "clip": [], "errors": "", "qc": "old note"} for i in IDS]
    (store / "meta/items.json").write_text(json.dumps(items))
    for i, t in art.items():
        (store / f"Images/ID{i}").mkdir(parents=True)
        for k in KINDS:
            (store / "Images" / rel(i, k)).write_bytes(t[k])
    return store, art


def make_release(base, art, members, name="rel", extra_index=None, skip_sums=False, corrupt_sum=None, qc="VISUAL_PASS", sums_name="SHA256SUMS.txt", zip_of=None, extra_zips=None):
    """members maps a ZIP entry name to bytes. zip_of maps an entry name to its ZIP's name; the default is one ZIP.
    extra_zips maps more ZIP names to their members, for ZIPs that overlap."""
    d = base / name
    d.mkdir()
    zips = dict(extra_zips or {})
    for k, v in members.items():
        zips.setdefault((zip_of or (lambda _: "Delta_Images.zip"))(k), {})[k] = v
    for zname, entries in (zips or {"Delta_Images.zip": {}}).items():
        with zipfile.ZipFile(d / zname, "w") as z:
            for k, v in entries.items():
                z.writestr(k, v)
    with zipfile.ZipFile(d / "Delivery_Index.zip", "w") as z:
        for k, v in {**manifests(art, qc), **(extra_index or {})}.items():
            z.writestr(k, v)
    if not skip_sums:
        lines = [f"{'0' * 64 if p.name == corrupt_sum else hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\r\n" for p in d.iterdir()]
        (d / sums_name).write_text("".join(lines))
    return d


def tool(store, source, *args, tag="second", env=None):
    # The public example fields, so that a project's own tools/site_fields.py never changes the tests.
    fields = {"SITE_FIELDS": str(TOOL.parent / "site_fields.example.py")}
    return subprocess.run([sys.executable, "-I", str(TOOL), tag, "--store", str(store), "--source", str(source), *args],
                          capture_output=True, text=True, env={**os.environ, **fields, **(env or {})})


def state(store):
    s = json.loads((store / "meta/items.json").read_text())
    tag = store / "meta/current.txt"
    return {"tag": tag.read_text().strip() if tag.exists() else "", "items": s} if isinstance(s, list) else s


def items(store):
    return {d["id"]: d for d in state(store)["items"]}


def shown(store):
    """What the site shows: its release, and each item's image and thumbnail bytes, read the way the gallery reads them."""
    s = state(store)
    out = {"tag": s["tag"]}
    for d in s["items"]:
        for k in KINDS:
            out[d["id"], k] = (store / f"{d.get('v', {}).get(k, '')}Images" / rel(d["id"], k)).read_bytes()
            thumb = store / f"{d.get('tv', '')}thumbs/{d['id']}_{k}.webp"
            out[d["id"], k, "thumb"] = thumb.read_bytes() if thumb.exists() else None
        out[d["id"], "measured"] = {x: d.get(x) for x in ("size", "diff", "qc", "upd")}
        if out[d["id"], "measured"]["upd"]:
            out[d["id"], "measured"]["upd"] = {**d["upd"], "at": 0}
    return out


def files(store):
    return {str(p.relative_to(store)): p.read_bytes() for p in store.rglob("*") if p.is_file()}


def test(name):
    def wrap(fn):
        global failures
        with tempfile.TemporaryDirectory() as t:
            try:
                fn(Path(t))
                print("ok  ", name)
            except AssertionError as e:
                failures += 1
                print("FAIL", name, e)
    return wrap


def changed_art(art, id_="00002", shade=200):
    new = dict(art)
    new[id_] = triplet(shade)
    return new, {f"Images/{rel(id_, k)}": new[id_][k] for k in KINDS}


@test("dry run reports the delta and changes nothing")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    before = files(store)
    r = tool(store, make_release(t, new, members))
    assert r.returncode == 0, r.stderr
    assert "3 changed files in 1 IDs" in r.stdout and "00002" in r.stdout, r.stdout
    assert "Dry run" in r.stdout
    assert files(store) == before


@test("apply publishes only the delta to new keys, overwrites nothing, rebuilds thumbnails, measurements and notes")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    before = files(store)
    r = tool(store, make_release(t, new, members, qc="new note"), "--apply")
    assert r.returncode == 0, r.stderr + r.stdout
    after = files(store)
    changed = [k for k in before if k != "meta/items.json" and after.get(k) != before[k]]
    assert not changed, f"overwrote {changed}"
    s = shown(store)
    assert s["tag"] == "second"
    for k in KINDS:
        assert s["00002", k] == new["00002"][k] and s["00002", k, "thumb"]
        assert s["00001", k] == art["00001"][k] and s["00001", k, "thumb"] is None
    it = items(store)
    assert it["00002"]["size"] == "32x32" and it["00002"]["diff"] == 0.0, it["00002"]
    assert it["00002"]["upd"]["tag"] == "second" and it["00002"]["upd"]["kinds"] == sorted(KINDS), it["00002"]["upd"]
    assert it["00001"]["size"] == "old" and "upd" not in it["00001"], "an unchanged item was re-measured"
    assert it["00001"]["qc"] == "new note" and it["00002"]["qc"] == "new note", "delivery notes not refreshed"
    assert (store / f"meta/manifests/{state(store)['manifest']}.csv").exists()


@test("a second publish builds on the first, from the stored manifest")
def _(t):
    store, art = make_store(t)
    second, members = changed_art(art)
    assert tool(store, make_release(t, second, members), "--apply").returncode == 0
    third, members3 = changed_art(second, "00003", 230)
    third["00002"] = {**second["00002"], "character": triplet(90)["character"]}
    members3[f"Images/{rel('00002', 'character')}"] = third["00002"]["character"]
    r = tool(store, make_release(t, third, members3, name="rel3"), "--apply", tag="third")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "4 changed files in 2 IDs" in r.stdout, r.stdout
    s = shown(store)
    for k in KINDS:
        assert s["00002", k] == third["00002"][k] and s["00003", k] == third["00003"][k]
    assert items(store)["00002"]["upd"]["kinds"] == ["character"]


@test("a delivery with no changed files still records the new release and notes")
def _(t):
    store, art = make_store(t)
    r = tool(store, make_release(t, art, {}, qc="new note"), "--apply")
    assert r.returncode == 0, r.stderr
    assert "0 changed files" in r.stdout
    assert not (store / "r").exists()
    assert state(store)["tag"] == "second" and items(store)["00003"]["qc"] == "new note"


@test("the published tag is a no-op")
def _(t):
    store, art = make_store(t)
    r = tool(store, make_release(t, art, {}), "--apply", tag="first")
    assert r.returncode == 0 and "Nothing to do" in r.stdout, r.stdout


def refuses(store, source, needle, tag="second"):
    """A refused run can leave unused uploads under r/, but what the site shows must not change."""
    before, kept = shown(store), {k: v for k, v in files(store).items() if not k.startswith(("r/", "meta/manifests/", "meta/progress"))}
    r = tool(store, source, "--apply", tag=tag)
    assert r.returncode == 2, f"exit {r.returncode}: {r.stdout} {r.stderr}"
    assert needle in r.stderr, r.stderr
    assert shown(store) == before, "what the site shows changed"
    assert {k: v for k, v in files(store).items() if k in kept} == kept, "a published file changed"


@test("refuses when a changed file is missing from the ZIPs")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    members.pop(f"Images/{rel('00002', 'combined')}")
    refuses(store, make_release(t, new, members), "missing or fail")


@test("refuses when a file in the ZIP does not match the manifest")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    members[f"Images/{rel('00002', 'combined')}"] = png((1, 2, 3))
    refuses(store, make_release(t, new, members), "missing or fail")


@test("refuses when a ZIP does not match SHA256SUMS")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    refuses(store, make_release(t, new, members, corrupt_sum="Delta_Images.zip"), "does not match SHA256SUMS")


@test("refuses a release with no checksums")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    refuses(store, make_release(t, new, members, skip_sums=True), "needs one SHA256SUMS file, found none")


@test("accepts a renamed checksum file, such as SHA256SUMS_UPDATED.txt")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    r = tool(store, make_release(t, new, members, sums_name="SHA256SUMS_UPDATED.txt"), "--apply")
    assert r.returncode == 0, r.stderr + r.stdout
    assert state(store)["tag"] == "second"


@test("refuses a release with two checksum files")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    src = make_release(t, new, members)
    (src / "SHA256SUMS_UPDATED.txt").write_text((src / "SHA256SUMS.txt").read_text())
    refuses(store, src, "needs one SHA256SUMS file")


@test("refuses a partial manifest")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    del new["00003"]
    refuses(store, make_release(t, new, members), "drops 3 files")


@test("refuses a manifest with an unsafe path")
def _(t):
    store, art = make_store(t)
    bad = {"ASSET_FILES_9.csv": "ID,type,relative_path,size_bytes,sha256\n00001,character,../../evil.png,1," + "a" * 64 + "\n"}
    refuses(store, make_release(t, art, {}, extra_index=bad), "bad manifest row")


@test("a path-traversal ZIP entry is ignored and writes nothing outside")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    members["../../escaped.png"] = png((9, 9, 9))
    members["tools/evil.py"] = b"print(1)"
    r = tool(store, make_release(t, new, members), "--apply")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "Ignored 2 unexpected" in r.stdout, r.stdout
    assert not list(t.rglob("escaped.png")) and not list(t.rglob("evil.py"))


@test("a broken image with a correct checksum refuses before anything is uploaded")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    new["00002"] = {**new["00002"], "combined": b"not a png"}
    members[f"Images/{rel('00002', 'combined')}"] = b"not a png"
    refuses(store, make_release(t, new, members), "not a readable image")


@test("a new character with an old combined image publishes and warns")
def _(t):
    store, art = make_store(t)
    new = dict(art)
    new["00002"] = {**art["00002"], "character": triplet(200)["character"]}
    r = tool(store, make_release(t, new, {f"Images/{rel('00002', 'character')}": new["00002"]["character"]}), "--apply")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "1 changed files" in r.stdout and "WARNING: 1 IDs" in r.stdout and "00002" in r.stdout, r.stdout
    s = shown(store)
    assert s["00002", "character"] == new["00002"]["character"] and s["00002", "combined"] == art["00002"]["combined"]
    assert items(store)["00002"]["v"] == {"character": items(store)["00002"]["tv"]}
    assert all(s["00002", k, "thumb"] for k in KINDS), "a thumbnail is missing under the new prefix"


@test("refuses when the two manifests disagree")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    without = manifests({i: x for i, x in new.items() if i != "00002"})["ID_DELIVERY_MANIFEST.csv"]
    refuses(store, make_release(t, new, members, extra_index={"ID_DELIVERY_MANIFEST.csv": without}), "manifests disagree")


@test("refuses an ID manifest that lists a file the checksum manifest does not")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    short = manifests(new)["ASSET_FILES_9.csv"].splitlines(keepends=True)
    # Drop 00003's combined image from ASSET_FILES only. The removal check would catch it first, so add it to the
    # site's view as unchanged by dropping it from the published manifest too.
    asset = "".join(l for l in short if "00003__combined" not in l)
    (store / "meta/index/ASSET_FILES.csv").write_text("".join(l for l in manifests(art)["ASSET_FILES_9.csv"].splitlines(keepends=True) if "00003__combined" not in l))
    refuses(store, make_release(t, new, members, extra_index={"ASSET_FILES_9.csv": asset}), "manifests disagree")


@test("a plan file without ID ranges falls back to every image ZIP")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    r = tool(store, make_release(t, new, members, extra_index={"ARCHIVE_PLAN.csv": "archive\nDelta_Images.zip\n"}), "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    assert shown(store)["00002", "combined"] == new["00002"]["combined"]


@test("refuses a manifest row that names another item's file")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    rows = list(csv.reader(io.StringIO(manifests(new)["ID_DELIVERY_MANIFEST.csv"])))
    # Swap the background path and checksum of 00001 and 00002, so that both still appear in ASSET_FILES.
    for c in (rows[0].index("background_relative_path"), rows[0].index("background_sha256")):
        rows[1][c], rows[2][c] = rows[2][c], rows[1][c]
    out = io.StringIO()
    csv.writer(out).writerows(rows)
    refuses(store, make_release(t, new, members, extra_index={"ID_DELIVERY_MANIFEST.csv": out.getvalue()}), "as its background")


@test("refuses an item that is not on the site")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art, "00004")
    refuses(store, make_release(t, new, members), "not on the site")


@test("refuses when the site does not record its release")
def _(t):
    store, art = make_store(t)
    (store / "meta/current.txt").unlink()
    new, members = changed_art(art)
    refuses(store, make_release(t, new, members), "meta/current.txt")


@test("refuses when the site's manifest is missing")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    assert tool(store, make_release(t, new, members), "--apply").returncode == 0
    for p in (store / "meta/manifests").iterdir():
        p.unlink()
    third, members3 = changed_art(new, "00003", 230)
    refuses(store, make_release(t, third, members3, name="rel3"), "no stored manifest", tag="third")


@test("a run stopped before any upload leaves the site whole, and a rerun ends like a clean run")
def _(t):
    clean, art = make_store(t / "clean")
    new, members = changed_art(art)
    new, members3 = changed_art(new, "00003", 230)
    # One ZIP per item, so that a rerun has finished ZIPs to skip.
    src = make_release(t, new, {**members, **members3}, zip_of=lambda k: f"Images_{k[9:14]}.zip")
    assert tool(clean, src, "--apply").returncode == 0
    expected = shown(clean)
    env, resumed = {}, 0
    # Stop before write 0, 1, 2 and so on, until a run has no write left to stop before.
    for n in range(40):
        store, _ = make_store(t / f"crash{n}")
        before = shown(store)
        r = tool(store, src, "--apply", env={**env, "GATEWAY_FAIL_AFTER": str(n)})
        if r.returncode == 0:
            assert n >= 15 and shown(store) == expected, f"run {n}: {r.stdout}"
            assert resumed, "no rerun skipped a finished ZIP"
            break
        assert r.returncode == 3, f"stop before write {n}: exit {r.returncode} {r.stderr}"
        assert shown(store) == before, f"stop before write {n} changed what the site shows"
        r = tool(store, src, "--apply", env=env)
        assert r.returncode == 0, f"rerun after stop {n}: {r.stdout} {r.stderr}"
        assert shown(store) == expected, f"rerun after stop {n} differs from a clean run"
        resumed += "Resuming after 1 of 2 ZIPs" in r.stdout
    else:
        assert False, "every run stopped"


@test("an item whose changed files are in two ZIPs publishes whole")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    src = make_release(t, new, members, zip_of=lambda k: "A.zip" if "character" in k else "B.zip")
    r = tool(store, src, "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    s = shown(store)
    for k in KINDS:
        assert s["00002", k] == new["00002"][k] and s["00002", k, "thumb"]


@test("overlapping ZIPs publish each item once and leave nothing on disk")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    new, members3 = changed_art(new, "00003", 230)
    # A_All.zip sorts first and holds everything; B_00002.zip repeats 00002.
    src = make_release(t, new, {}, extra_zips={"A_All.zip": {**members, **members3}, "B_00002.zip": members})
    r = tool(store, src, "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    s = shown(store)
    for i in ("00002", "00003"):
        for k in KINDS:
            assert s[i, k] == new[i][k]
    assert (store / "meta/progress.txt").read_text().strip() == ""


@test("a combined image that cannot be compared publishes as a mismatch and a file error")
def _(t):
    store, art = make_store(t)
    small = io.BytesIO()
    Image.new("RGB", (16, 16), (5, 5, 5)).save(small, "PNG")
    new = {**art, "00002": {**art["00002"], "combined": small.getvalue()}}
    r = tool(store, make_release(t, new, {f"Images/{rel('00002', 'combined')}": small.getvalue()}), "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    d = items(store)["00002"]
    assert d["diff"] > 3 and "cannot be compared" in d["errors"], d


@test("a ZIP repaired under the same name is read again, not skipped")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    comb = f"Images/{rel('00002', 'combined')}"
    layers = {k: v for k, v in members.items() if k != comb}
    # A.zip holds nothing needed, so the first run saves progress after it. B.zip lacks the combined image.
    refuses(store, make_release(t, new, {}, extra_zips={"A.zip": {}, "B.zip": layers}), "missing or fail")
    r = tool(store, make_release(t, new, {}, name="fixed", extra_zips={"A.zip": {comb: members[comb]}, "B.zip": layers}), "--apply")
    assert r.returncode == 0, r.stdout + r.stderr
    assert shown(store)["00002", "combined"] == new["00002"]["combined"]


@test("too little free disk refuses with a clear reason")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    before = shown(store)
    r = tool(store, make_release(t, new, members), "--apply", env={"GATEWAY_MIN_FREE": str(10 ** 18)})
    assert r.returncode == 2 and "of disk is free" in r.stderr, r.stdout + r.stderr
    assert shown(store) == before


@test("in GitHub Actions, tags and file names are masked and unexpected entry names are not printed")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    members["notes/secret-project-name.txt"] = b"x"
    r = tool(store, make_release(t, new, members), "--apply", env={"GITHUB_ACTIONS": "true"})
    assert r.returncode == 0, r.stdout + r.stderr
    for value in ("second", "first", "Delta_Images.zip", "SHA256SUMS.txt"):
        assert f"::add-mask::{value}" in r.stdout, value
    assert "Ignored 1 unexpected" in r.stdout and "secret-project-name" not in r.stdout, r.stdout


@test("a ZIP name with a space and a percent sign publishes, and its mask is encoded")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    r = tool(store, make_release(t, new, members, zip_of=lambda k: "Images 100%.zip"), "--apply", env={"GITHUB_ACTIONS": "true"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "::add-mask::Images 100%25.zip" in r.stdout, r.stdout
    assert shown(store)["00002", "combined"] == new["00002"]["combined"]


@test("a refused manifest value is masked before it is printed")
def _(t):
    store, art = make_store(t)
    bad = {"ASSET_FILES_9.csv": "ID,type,relative_path,size_bytes,sha256\n00001,character,Client/notes.png,1," + "a" * 64 + "\n"}
    r = tool(store, make_release(t, art, {}, extra_index=bad), "--apply", env={"GITHUB_ACTIONS": "true"})
    assert r.returncode == 2 and "::add-mask::Client/notes.png" in r.stdout, r.stdout + r.stderr


@test("a failing site-fields hook refuses without its error text")
def _(t):
    store, art = make_store(t)
    hook = t / "hook.py"
    hook.write_text("def refresh(item, row):\n    row['private_column_name']\n")
    new, members = changed_art(art)
    r = tool(store, make_release(t, new, members), "--apply", env={"SITE_FIELDS": str(hook), "GITHUB_ACTIONS": "true"})
    assert r.returncode == 2 and "KeyError" in r.stderr, r.stdout + r.stderr
    assert "private_column_name" not in r.stdout + r.stderr


@test("a refused value with a backslash is masked in the form that is printed")
def _(t):
    store, art = make_store(t)
    bad = {"ASSET_FILES_9.csv": "ID,type,relative_path,size_bytes,sha256\n00001,character,Client\\notes.png,1," + "a" * 64 + "\n"}
    r = tool(store, make_release(t, art, {}, extra_index=bad), "--apply", env={"GITHUB_ACTIONS": "true"})
    assert r.returncode == 2, r.stdout + r.stderr
    assert "Client\\\\notes.png" in r.stderr, r.stderr
    assert "::add-mask::Client\\\\notes.png" in r.stdout, r.stdout


@test("a SITE_FIELDS path that is not a file refuses")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    r = tool(store, make_release(t, new, members), "--apply", env={"SITE_FIELDS": "relative/hook.py"})
    assert r.returncode == 2 and "is not a file" in r.stderr, r.stdout + r.stderr


@test("in GitHub Actions, a failed command's own error text is not printed")
def _(t):
    store, art = make_store(t)
    fake = t / "bin"
    fake.mkdir()
    (fake / "gh").write_text("#!/bin/sh\necho 'SSO required: https://github.com/orgs/private-org/sso' >&2\nexit 1\n")
    (fake / "gh").chmod(0o755)
    env = {"PATH": f"{fake}:{os.environ['PATH']}", "GITHUB_ACTIONS": "true", "DELIVERY_REPO": "private-org/repo"}
    r = subprocess.run([sys.executable, "-I", str(TOOL), "--store", str(store)], capture_output=True, text=True, env={**os.environ, **env})
    assert r.returncode == 3 and "cannot read the artist's releases" in r.stderr, r.stdout + r.stderr
    assert "private-org/sso" not in r.stderr and "::add-mask::private-org" in r.stdout, r.stdout + r.stderr
    r = subprocess.run([sys.executable, "-I", str(TOOL), "--store", str(store)], capture_output=True, text=True,
                       env={**os.environ, **env, "GITHUB_ACTIONS": ""})
    assert "SSO required" in r.stderr, "a local run lost the detail: " + r.stderr


@test("progress saved for another run is ignored")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    (store / "meta/progress.txt").write_text(f"{'0' * 16} 9\n")
    r = tool(store, make_release(t, new, members), "--apply")
    assert r.returncode == 0 and "Resuming" not in r.stdout, r.stdout + r.stderr
    assert shown(store)["00002", "combined"] == new["00002"]["combined"]


@test("a rerun after publishing does nothing")
def _(t):
    store, art = make_store(t)
    new, members = changed_art(art)
    src = make_release(t, new, members)
    assert tool(store, src, "--apply").returncode == 0
    before = files(store)
    r = tool(store, src, "--apply")
    assert r.returncode == 0 and "Nothing to do" in r.stdout, r.stdout + r.stderr
    assert files(store) == before


print(f"{failures} FAILED" if failures else "all passed")
sys.exit(1 if failures else 0)
