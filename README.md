# art-drop-gateway

A private review site for an artist's deliveries, built on Cloudflare's free tier and kept current by a
free GitHub Actions job.

An artist delivers layered art (a character, a background and the combined image for each item) as releases
of a private GitHub repo. This project puts that art behind one password, lets a team flag what needs work,
gives the artist a clean list of the flags, and publishes each new release by itself, overnight.

- **The gate:** a Cloudflare Worker (`site/worker.js`) serves the art from a private R2 bucket. Every request
  needs the shared password. The login's user name labels that person's flags.
- **The review:** `tools/gallery.html` is the whole front end, one file. Reviewers flag items with reasons and
  notes, filter by trait, and sort the flags in a fix list. Reviews live in D1.
- **The artist view:** when the artist signs in with their name, the site opens on their flags only.
- **The update:** `tools/pull_update.py` compares the artist's latest release with the site by checksum,
  downloads only the ZIPs that changed, and publishes only the changed items.

## How an update stays safe

The bucket is the only copy of the art, so the update never overwrites a file in it.

1. Changed images and new thumbnails go to new keys under `r/<run key>/`. The site does not use them yet.
2. The work goes one ZIP at a time and one item at a time, so disk use stays near one ZIP. A full re-render of
   tens of gigabytes fits on GitHub's free runner.
3. One last write of `meta/items.json` names the release and where each item's files are. That write switches
   the site, all at once.

A run that stops at any point leaves the site on the old release, whole. The next run continues from
`meta/progress.txt`. The tests stop a publish before each of its writes and check both promises.

## Set it up

You need a Cloudflare account, `wrangler`, Python 3.12 with Pillow, and the `gh` CLI.

1. Create an R2 bucket and a D1 database. Apply `site/schema.sql` to the database.
2. Copy `site/wrangler.example.toml` to `site/wrangler.toml`. Fill in your domain, bucket, database and display
   words. That file is never committed.
3. Create `.env` in the repo root, also never committed:

   ```bash
   DELIVERY_REPO=artist-account/private-delivery-repo
   R2_BUCKET=your-bucket
   ```

4. Import the first delivery. Download it, extract its index ZIP into `index/`, measure it, then upload it:

   ```bash
   tools/download.sh
   ```

   ```bash
   python3 -I tools/build.py && python3 -I tools/build.py --export
   ```

   ```bash
   tools/upload.sh <release tag>
   ```

5. Deploy the site. The script sets a generated password and prints where it is:

   ```bash
   tools/deploy.sh
   ```

6. For the daily job, add these repository secrets. Use secrets, not variables, because GitHub hides secret values
   in public logs: `DELIVERY_REPO`, `DELIVERY_REPO_TOKEN` (reads that repo's releases), `R2_BUCKET`,
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (R2 edit), and optionally `SITE_FIELDS_PY`.

## What a release must hold

- one `SHA256SUMS*.txt` with the checksum of every asset
- one index ZIP with `ASSET_FILES*.csv` (`relative_path`, `sha256`) and `ID_DELIVERY_MANIFEST*.csv` (`ID`, then
  `<kind>_relative_path` and `<kind>_sha256` for `character`, `background` and `combined`)
- image ZIPs with `Images/IDnnnnn/nnnnn__<kind>.png`

The update refuses, and the site does not change, when a manifest drops a file, the two manifests disagree, a
row names another item's file, a file fails its checksum, or an image cannot be read.

## Project fields

The gallery shows extra facts and filters when items carry them: a delivery note, a chosen set, a provisional
background and others. `tools/site_fields.example.py` shows how a project copies them from its manifest. Copy it
to `tools/site_fields.py`, which is never committed. For the daily job, put that file's contents in the
`SITE_FIELDS_PY` secret.

## Run the update by hand

```bash
python3 -I tools/pull_update.py
```

That reports what changed and changes nothing. Add `--apply` to publish, or name a tag to use another release.

## Tests

```bash
python3 -I tools/test_pull_update.py
```

```bash
cd site && node ../tools/site_test.mjs
```

The site test runs `wrangler dev` with `wrangler.example.toml` and made-up data.

## Limits

- One shared password and self-declared names. For per-person access, put Cloudflare Access in front.
- An item that is new to the site refuses. Import it with `tools/build.py --export` and `tools/upload.sh`.
- The Cloudflare API allows about 1,200 calls in 5 minutes, so a large update takes hours and spans several
  daily runs. An R2 S3 token with `aws s3 sync` is the way past that.
- GitHub pauses scheduled jobs in a repo with no commits for 60 days, and it emails a warning first.
