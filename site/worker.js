// Art drop gateway: a private review site for an artist's deliveries. Every request needs the shared password over HTTPS.
// The browser's login box asks for a name and the password. The name labels that person's review.
// ponytail: one shared password and self-declared names, because this tool is temporary.
// To restrict by person, put Cloudflare Access in front and read its verified email.

const THUMB = /^\/thumbs\/(\d{5})_(character|background|combined)\.webp$/;
const FULL = /^\/full\/(\d{5})\/(character|background|combined)\.png$/;
// Files that pull_update.py uploaded for one release. They are never overwritten.
const VERSIONED = /^\/o\/(r\/[0-9a-f]{16}\/(?:Images\/ID(\d{5})\/\2__(?:character|background|combined)\.png|thumbs\/\d{5}_(?:character|background|combined)\.webp))$/;
const ID = /^\d{5}$/;
const MAX_BATCH = 200;

const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Returns the reviewer's name, or null if the password is wrong or not configured. */
export async function reviewerName(header, env) {
  if (!env.REVIEW_PASSWORD || !header?.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return null;
  const [given, want] = await Promise.all([digest(decoded.slice(split + 1)), digest(env.REVIEW_PASSWORD)]);
  if (!crypto.subtle.timingSafeEqual(given, want)) return null;
  const name = decoded.slice(0, split).trim().slice(0, 60);
  return name ? name[0].toUpperCase() + name.slice(1) : null;
}

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers } });

const json = (body, status = 200) => text(body, status, { "Content-Type": "application/json" });

// no-cache makes the browser come back through the login check on each view.
// An unchanged image costs a 304, so the grid stays fast and a wrong password never sees art.
async function object(req, env, key, type) {
  const obj = await env.ART.get(key, { onlyIf: req.headers });
  if (!obj) return text("not found", 404);
  const headers = { "Content-Type": type, "Cache-Control": "private, no-cache", ETag: obj.httpEtag, "X-Robots-Tag": "noindex" };
  return new Response(obj.body ?? null, { status: obj.body ? 200 : 304, headers });
}

const VERDICTS_SQL = `SELECT COALESCE(json_group_object(id, json(people)), '{}') AS j FROM (
  SELECT id, json_group_object(by_name, json_object('id', id, 'by', by_name, 'verdict', verdict, 'reasons', json(reasons), 'note', note, 'at', at)) AS people
  FROM reviews GROUP BY id)`;
const TRIAGE_SQL = `SELECT COALESCE(json_group_object(id, json_object('id', id, 'status', status, 'by', by_name, 'at', at)), '{}') AS j FROM triage`;

const UPDATES_SQL = `SELECT COALESCE(json_group_object(id, json_object('tag', tag, 'kinds', json(kinds), 'at', at)), '{}') AS j FROM updates`;

// Display words from wrangler.toml [vars]. The gallery has a default for each.
const config = (env) => Object.fromEntries(
  [["title", "SITE_TITLE"], ["noun", "ITEM_NOUN"], ["nouns", "ITEM_NOUNS"], ["artist", "ARTIST_NAME"], ["chosen", "CHOSEN_LABEL"], ["others", "OTHERS_LABEL"], ["othersTag", "OTHERS_TAG"]]
    .filter(([, v]) => env[v]).map(([k, v]) => [k, String(env[v])]),
);

async function data(env, name) {
  // In R2, not in the Worker's assets, so that a delivery update needs no redeploy.
  const obj = await env.ART.get("meta/items.json");
  if (!obj) throw new Error("meta/items.json is missing");
  const items = await obj.text();
  const [v, t, u] = await env.DB.batch([env.DB.prepare(VERDICTS_SQL), env.DB.prepare(TRIAGE_SQL), env.DB.prepare(UPDATES_SQL)]);
  // Joined as text so that the Worker does not parse 5 MB of JSON on each load.
  return json(`{"me":${JSON.stringify(name)},"config":${JSON.stringify(config(env))},"items":${items},"verdicts":${v.results[0].j},"triage":${t.results[0].j},"updates":${u.results[0].j}}`);
}

async function save(req, env, path, name) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) return text("bad origin", 403);
  let batch;
  try {
    batch = JSON.parse(await req.text());
    if (!Array.isArray(batch) || batch.length > MAX_BATCH) throw new Error("bad batch");
  } catch (e) {
    return json(JSON.stringify({ error: e.message }), 400);
  }
  const at = Math.floor(Date.now() / 1000);
  const stmts = [];
  for (const r of batch) {
    if (!ID.test(r?.id ?? "")) return json('{"error":"bad id"}', 400);
    if (path === "/triage") {
      if (!["send", "keep", "fixed", ""].includes(r.status)) return json('{"error":"bad status"}', 400);
      stmts.push(env.DB.prepare("INSERT INTO triage (id, status, by_name, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET status=?2, by_name=?3, at=?4").bind(r.id, r.status, name, at));
    } else {
      if (!["ok", "flag", "clear"].includes(r.verdict)) return json('{"error":"bad verdict"}', 400);
      const reasons = JSON.stringify((Array.isArray(r.reasons) ? r.reasons : []).map((x) => String(x).slice(0, 60)));
      stmts.push(env.DB.prepare("INSERT INTO reviews (id, by_name, verdict, reasons, note, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id, by_name) DO UPDATE SET verdict=?3, reasons=?4, note=?5, at=?6").bind(r.id, name, r.verdict, reasons, String(r.note ?? "").slice(0, 500), at));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json('{"ok":true}');
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
// Stops a reviewer's note from running as a formula when the CSV opens in a spreadsheet.
// Leading whitespace counts too: a spreadsheet can skip it and still read the formula.
const cell = (s) => q(/^[\s=+\-@]/.test(s) ? `'${s}` : s);

async function exportCsv(env, artistOnly) {
  // Each item's last update is in meta/items.json. The D1 table holds updates from before that.
  const state = JSON.parse((await (await env.ART.get("meta/items.json"))?.text()) ?? "[]");
  const updatedIn = new Map((Array.isArray(state) ? state : state.items).filter((d) => d.upd).map((d) => [d.id, d.upd.tag]));
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.by_name, r.reasons, r.note, COALESCE(t.status, '') AS status, COALESCE(u.tag, '') AS updated FROM reviews r LEFT JOIN triage t ON t.id = r.id LEFT JOIN updates u ON u.id = r.id WHERE r.verdict = 'flag' ORDER BY r.id",
  ).all();
  const byId = new Map();
  for (const r of results) {
    if (artistOnly && r.status !== "send") continue;
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const rows = ["ID,file,what to fix,notes,flagged by,status,last updated in"];
  for (const [id, flags] of byId) {
    const reasons = [...new Set(flags.flatMap((f) => JSON.parse(f.reasons)))].sort().join("; ");
    const notes = flags.filter((f) => f.note).map((f) => `${f.by_name}: ${f.note}`).join(" | ");
    rows.push([id, `Images/ID${id}/${id}__combined.png`, cell(reasons), cell(notes), cell(flags.map((f) => f.by_name).join(", ")), flags[0].status, cell(updatedIn.get(id) ?? flags[0].updated)].join(","));
  }
  const file = artistOnly ? "artist-fixes.csv" : "flagged.csv";
  return text(rows.join("\r\n") + "\r\n", 200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=${file}` });
}

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      // ALLOW_HTTP is set only in the local test's .dev.vars. It skips this redirect and never the password.
      if (url.protocol === "http:" && !env.ALLOW_HTTP) {
        url.protocol = "https:";
        return Response.redirect(url, 301);
      }
      const name = await reviewerName(req.headers.get("Authorization"), env);
      if (!name) return text("Enter your name and the review password.", 401, { "WWW-Authenticate": `Basic realm="${String(env.SITE_TITLE || "Art review").replace(/[\x00-\x1f\x7f"\\]/g, "")}", charset="UTF-8"` });

      const path = url.pathname;
      if (req.method === "POST" && (path === "/verdict" || path === "/triage")) return await save(req, env, path, name);
      if (req.method !== "GET") return text("not found", 404);
      if (path === "/") {
        const page = await env.ASSETS.fetch(new URL("/gallery.html", url));
        return new Response(page.body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
      }
      if (path === "/data") return await data(env, name);
      if (path === "/flagged.csv") return await exportCsv(env, false);
      if (path === "/artist.csv") return await exportCsv(env, true);
      let m;
      if ((m = THUMB.exec(path))) return await object(req, env, `thumbs/${m[1]}_${m[2]}.webp`, "image/webp");
      if ((m = FULL.exec(path))) return await object(req, env, `Images/ID${m[1]}/${m[1]}__${m[2]}.png`, "image/png");
      if ((m = VERSIONED.exec(path))) return await object(req, env, m[1], m[1].endsWith(".png") ? "image/png" : "image/webp");
      return text("not found", 404);
    } catch (e) {
      console.error(e);
      return text("Server error.", 500);
    }
  },
};
