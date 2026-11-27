// Tests the Worker's password gate and review API against `wrangler dev`.
// Run from site/: node ../tools/site_test.mjs   (WRANGLER names the wrangler command; default: wrangler)
// It uses wrangler.example.toml and made-up data, so it needs no deployment of its own.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

const W = process.env.WRANGLER || "wrangler";
const CONFIG = ["--config", "wrangler.example.toml"];
const ITEMS = 50;
const BASE = "http://127.0.0.1:8799";
const PW = "test-password:with-colon";
let catalogVersion = "";
const basic = (name, pw) => `Basic ${Buffer.from(`${name}:${pw}`).toString("base64")}`;
// Wrangler fixture commands can hold the test process long enough to expire an idle connection.
const get = (path, auth, init = {}) => fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init, headers: { Connection: "close", ...(auth ? { Authorization: auth } : {}), ...init.headers } });
const post = (path, auth, body, origin = BASE) => get(path, auth, { method: "POST", body: JSON.stringify(body.map(r=>({...r,catalog_version:catalogVersion}))), headers: { Origin: origin } });

const state = mkdtempSync(join(tmpdir(), "gateway-site-test-"));
writeFileSync(".dev.vars", `REVIEW_PASSWORD="${PW}"\nALLOW_HTTP="1"\n`);
const wr = (...a) => execFileSync(W, [...a, ...CONFIG, "--persist-to", state], { stdio: "pipe" });
mkdirSync("public", { recursive: true });
copyFileSync("../tools/gallery.html", "public/gallery.html");
copyFileSync("../tools/review-state.mjs", "public/review-state.mjs");
const items = join(state, "items.json");
writeFileSync(items, JSON.stringify(Array.from({ length: ITEMS }, (_, i) => ({ id: String(i + 1).padStart(5, "0") }))));
wr("d1", "execute", "art-drop-gateway", "--local", "--file", "schema.sql");
wr("d1", "migrations", "apply", "DB", "--local");
wr("r2", "object", "put", "art-drop-gateway/meta/items.json", "--local", "--file", items);
// Stand-in art, because the real art lives only in R2. The Worker serves bytes by path and never decodes them.
const fakeThumb = join(state, "thumb.webp"), fakeFull = join(state, "full.png");
const optionsPage = join(state, "options.html");
writeFileSync(optionsPage, "<!doctype html><title>Synthetic art options</title>");
writeFileSync(fakeThumb, randomBytes(4000));
writeFileSync(fakeFull, randomBytes(200000));
wr("r2", "object", "put", "art-drop-gateway/thumbs/00001_combined.webp", "--local", "--file", fakeThumb);
wr("r2", "object", "put", "art-drop-gateway/Images/ID00001/00001__combined.png", "--local", "--file", fakeFull);
const V = "r/0123456789abcdef";
wr("r2", "object", "put", "art-drop-gateway/meta/option-deliveries/synthetic-release.html", "--local", "--file", optionsPage);
wr("r2", "object", "put", `art-drop-gateway/${V}/Images/ID00001/00001__character.png`, "--local", "--file", fakeFull);
wr("r2", "object", "put", `art-drop-gateway/${V}/thumbs/00001_character.webp`, "--local", "--file", fakeThumb);
const dev = spawn(W, ["dev", ...CONFIG, "--port", "8799", "--ip", "127.0.0.1", "--persist-to", state], { stdio: "ignore" });

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, e.message); } };
try {
  for (let i = 0; i < 60; i++) { try { await get("/"); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  catalogVersion = (await (await get("/data", basic("Ada", PW))).json()).catalog_version;

  await test("the schema upgrade preserves existing reviews and is safe to repeat", async () => {
    const legacy = join(state, "legacy-upgrade");
    const run = (...args) => execFileSync(W, [...args, ...CONFIG, "--persist-to", legacy], { stdio: "pipe" });
    run("d1", "execute", "DB", "--local", "--command", "CREATE TABLE reviews (id TEXT NOT NULL,by_name TEXT NOT NULL,verdict TEXT NOT NULL,reasons TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL,PRIMARY KEY(id,by_name)); INSERT INTO reviews (id,by_name,verdict,note,at) VALUES ('00001','Ada','flag','Preserve my concern',7)");
    for (let i = 0; i < 2; i++) run("d1", "migrations", "apply", "DB", "--local");
    const records = JSON.parse(run("d1", "execute", "DB", "--local", "--json", "--command", "SELECT id,by_name,verdict,note,at,art_version FROM reviews").toString())[0].results;
    assert.deepEqual(records, [{ id: "00001", by_name: "Ada", verdict: "flag", note: "Preserve my concern", at: 7, art_version: "" }]);
  });

  const denied = [
    ["no login", undefined],
    ["wrong password", basic("Ada", "wrong")],
    ["empty password", basic("Ada", "")],
    ["password prefix", basic("Ada", PW.slice(0, -1))],
    ["blank name", basic("  ", PW)],
    ["not base64", "Basic %%%"],
    ["no colon", `Basic ${Buffer.from("Ada").toString("base64")}`],
    ["other scheme", `Bearer ${PW}`],
  ];
  for (const [why, auth] of denied) {
    for (const path of ["/", "/data", "/review-state.mjs", "/items.json", "/gallery.html", "/thumbs/00001_combined.webp", "/full/00001/combined.png", `/o/${V}/thumbs/00001_character.webp`, "/artist.csv"]) {
      await test(`401 ${why} ${path}`, async () => assert.equal((await get(path, auth)).status, 401));
    }
  }
  await test("a refused post saves nothing", async () => assert.equal((await post("/verdict", basic("Ada", "wrong"), [{ id: "00009", verdict: "ok" }])).status, 401));
  await test("the login box is requested", async () => assert.match((await get("/")).headers.get("www-authenticate"), /^Basic realm=/));

  const ada = basic("ada", PW), max = basic("Max", PW);
  await test("full-size originals download as PNG attachments behind the same password", async () => {
    for (const [path, filename] of [
      ["/full/00001/combined.png", "00001__combined.png"],
      [`/o/${V}/Images/ID00001/00001__character.png`, "00001__character.png"],
    ]) {
      assert.equal((await get(path + "?download=1")).status, 401);
      assert.equal((await get(path, ada)).headers.get("content-disposition"), null);
      const download = await get(path + "?download=1", ada);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-type"), "image/png");
      assert.equal(download.headers.get("content-disposition"), `attachment; filename="${filename}"`);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), readFileSync(fakeFull));
    }
  });
  await test("a release options page is available only behind the password gate", async () => {
    const path = "/options/synthetic-release";
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, basic("Ada", "wrong"))).status, 401);
    const page = await get(path, ada);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await page.text(), /Synthetic art options/);
    assert.equal((await get("/options/unknown", ada)).status, 404);
  });
  await test("page loads", async () => { const r = await get("/", ada); assert.equal(r.status, 200); assert.match(await r.text(), /Art Review/); });
  await test("the gallery's shared review-state module loads behind the same password gate", async () => {
    const r = await get("/review-state.mjs", ada);
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /javascript/);
    assert.equal(r.headers.get("cache-control"), "no-store"); assert.match(await r.text(), /export function reviewStatus/);
  });
  await test("art loads", async () => {
    const a = await get("/thumbs/00001_combined.webp", ada); assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), "image/webp");
    assert.ok((await a.arrayBuffer()).byteLength > 1000);
    const b = await get("/full/00001/combined.png", ada); assert.equal(b.status, 200); assert.ok((await b.arrayBuffer()).byteLength > 100000);
  });
  await test("a release's versioned files load with their type", async () => {
    const a = await get(`/o/${V}/Images/ID00001/00001__character.png`, ada); assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), "image/png");
    const b = await get(`/o/${V}/thumbs/00001_character.webp`, ada); assert.equal(b.status, 200); assert.equal(b.headers.get("content-type"), "image/webp");
  });
  await test("versioned paths outside the art pattern are 404", async () => {
    for (const p of [`/o/${V}/Images/ID00001/00002__character.png`, "/o/r/0123456789ABCDEF/thumbs/00001_character.webp", `/o/${V}/../meta/items.json`, `/o/${V}/thumbs/..%2f..%2fmeta%2fitems.json`, "/o/meta/items.json", `/o/${V}/Images/ID00001/00001__character.png.bak`]) {
      assert.equal((await get(p, ada)).status, 404, p);
    }
  });
  await test("art must revalidate, and an unchanged image is a 304", async () => {
    const a = await get("/thumbs/00001_combined.webp", ada); await a.arrayBuffer();
    assert.equal(a.headers.get("cache-control"), "private, no-cache");
    const b = await get("/thumbs/00001_combined.webp", ada, { headers: { "If-None-Match": a.headers.get("etag") } });
    assert.equal(b.status, 304);
    assert.equal((await get("/thumbs/00001_combined.webp", undefined, { headers: { "If-None-Match": a.headers.get("etag") } })).status, 401);
  });
  await test("path traversal is 404", async () => assert.equal((await get("/thumbs/..%2f..%2fx.webp", ada)).status, 404));
  await test("empty data, name from the login, first letter capitalized", async () => { const d = await (await get("/data", ada)).json(); assert.equal(d.items.length, ITEMS); assert.equal(d.config.title, "Art Review"); assert.equal(d.config.artist, "Artist"); assert.equal(d.me, "Ada"); assert.deepEqual(d.verdicts, {}); });
  await test("the login sets the name, not the body", async () => {
    assert.equal((await post("/verdict", max, [{ id: "00005", by: "Ada", verdict: "flag", reasons: ["Edge halo"], note: "=SUM(A1)" }])).status, 200);
    assert.equal((await post("/verdict", ada, [{ id: "00005", verdict: "ok" }])).status, 200);
    const d = await (await get("/data", ada)).json();
    assert.equal(d.verdicts["00005"].Max.verdict, "flag"); assert.deepEqual(d.verdicts["00005"].Max.reasons, ["Edge halo"]); assert.equal(d.verdicts["00005"].Ada.verdict, "ok");
  });
  await test("a later verdict replaces that person's earlier one", async () => {
    await post("/verdict", ada, [{ id: "00005", verdict: "flag", note: "changed" }]);
    const d = await (await get("/data", ada)).json(); assert.equal(d.verdicts["00005"].Ada.note, "changed");
    await post("/verdict", ada, [{ id: "00005", verdict: "ok" }]);
  });
  await test("bad input is 400", async () => {
    assert.equal((await post("/verdict", ada, [{ id: "../x", verdict: "ok" }])).status, 400);
    assert.equal((await post("/verdict", ada, [{ id: "00005", verdict: "nope" }])).status, 400);
    assert.equal((await post("/triage", ada, [{ id: "00005", status: "nope" }])).status, 400);
    assert.equal((await get("/verdict", ada, { method: "POST", body: "{", headers: { Origin: BASE } })).status, 400);
    assert.equal((await post("/verdict", ada, [{ id: "00005", verdict: "flag", art_version: {} }])).status, 400);
  });
  await test("a reason that starts with a space cannot run as a spreadsheet formula", async () => {
    await post("/verdict", ada, [{ id: "00009", verdict: "flag", reasons: [" =HYPERLINK(1)"] }]);
    assert.match(await (await get("/flagged.csv", ada)).text(), /00009,[^,]*,"' =HYPERLINK\(1\)"/);
  });
  await test("a post from another site is 403", async () => assert.equal((await post("/verdict", ada, [{ id: "00006", verdict: "ok" }], "https://evil.example")).status, 403));
  await test("verdicts carry a time, and updates reach the page and the export", async () => {
    await post("/verdict", ada, [{ id: "00008", verdict: "flag", reasons: ["Cut off"] }]);
    wr("d1", "execute", "art-drop-gateway", "--local", "--command", `INSERT INTO updates (id, tag, kinds, at) VALUES ('00008', 'round-2', '["combined"]', 1900000000)`);
    const d = await (await get("/data", ada)).json();
    assert.ok(d.verdicts["00008"].Ada.at > 1700000000);
    assert.deepEqual(d.updates["00008"], { tag: "round-2", kinds: ["combined"], at: 1900000000 });
    assert.match(await (await get("/flagged.csv", ada)).text(), /00008,.*,"round-2"/);
  });
  await test("artist list holds only 'send'", async () => {
    await post("/verdict", ada, [{ id: "00007", verdict: "flag", reasons: ["Cut off"], note: 'has "quotes", comma' }]);
    assert.equal((await post("/triage", ada, [{ id: "00007", status: "send" }])).status, 200);
    const a = await (await get("/artist.csv", ada)).text();
    assert.match(a, /^ID,file,what to fix/); assert.match(a, /00007/); assert.doesNotMatch(a, /00005/); assert.match(a, /""quotes""/);
    const f = await (await get("/flagged.csv", ada)).text(); assert.match(f, /00005/); assert.match(f, /Max: =SUM/);
    const d = await (await get("/data", ada)).json(); assert.equal(d.triage["00007"].status, "send");
  });
  await test("changed flagged art exports as needing re-review until its flag is updated or removed", async () => {
    await post("/verdict", ada, [{ id: "00010", verdict: "flag", reasons: ["Edge halo"], note: "Original concern" }]);
    wr("d1", "execute", "art-drop-gateway", "--local", "--command", "UPDATE reviews SET at=1 WHERE id='00010'; INSERT INTO updates (id,tag,kinds,at) VALUES ('00010','new-delivery','[\"character\"]',10); INSERT INTO triage (id,status,by_name,at) VALUES ('00010','send','Ada',2)");
    const before = await (await get("/flagged.csv", ada)).text();
    assert.match(before, /00010,.*Original concern.*needs re-review.*new-delivery/);
    assert.doesNotMatch(await (await get("/artist.csv", ada)).text(), /00010/);
    await post("/verdict", ada, [{ id: "00010", verdict: "flag", reasons: ["Edge halo"], note: "Old tab concern", art_version: "previous:1" }]);
    assert.match(await (await get("/flagged.csv", ada)).text(), /00010,.*needs re-review/);
    await post("/verdict", ada, [{ id: "00010", verdict: "flag", reasons: ["Edge halo"], note: "Updated concern", art_version: "new-delivery:10" }]);
    const saved = await (await get("/data", ada)).json();
    assert.equal(saved.verdicts["00010"].Ada.art_version, "new-delivery:10");
    const after = await (await get("/flagged.csv", ada)).text();
    assert.match(after, /00010,.*Updated concern.*,,"new-delivery"/);
    assert.doesNotMatch(after.split(/\r?\n/).find((s) => s.startsWith("00010,")), /needs re-review/);
    await post("/verdict", ada, [{ id: "00010", verdict: "clear" }]);
    assert.doesNotMatch(await (await get("/flagged.csv", ada)).text(), /00010/);
  });
  await test("a stale gallery cannot clear an existing flag or change triage after publication", async () => {
    await post("/verdict", ada, [{id:"00011",verdict:"flag",note:"Keep until re-reviewed"}]);
    const next = JSON.parse(readFileSync(items, "utf8"));
    next.find(d=>d.id==="00011").upd={tag:"after-tab",kinds:["character"],at:10};
    writeFileSync(items, JSON.stringify(next));
    wr("r2","object","put","art-drop-gateway/meta/items.json","--local","--file",items);
    const save = (path,body) => get(path,ada,{method:"POST",body:JSON.stringify(body),headers:{Origin:BASE}});
    assert.equal((await save("/verdict",[{id:"00011",verdict:"ok",catalog_version:catalogVersion,art_version:""}])).status,409);
    assert.equal((await save("/triage",[{id:"00011",status:"fixed",catalog_version:catalogVersion}])).status,409);
    assert.equal((await save("/verdict",[{id:"00011",verdict:"clear"}])).status,409);
    const current=await (await get("/data",ada)).json();
    assert.equal(current.verdicts["00011"].Ada.verdict,"flag");
    assert.equal(current.verdicts["00011"].Ada.note,"Keep until re-reviewed");
    assert.equal(current.triage["00011"],undefined);
    assert.notEqual(current.catalog_version,catalogVersion);
    catalogVersion=current.catalog_version;
    assert.equal((await post("/verdict",ada,[{id:"00011",verdict:"flag",note:"Checked current art",art_version:"after-tab:10"}])).status,200);
  });
  await test("the review API serves a complete collection larger than one D1 value", async () => {
    wr("d1","execute","DB","--local","--command", "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<4000) INSERT INTO reviews(id,by_name,verdict,reasons,note,at,art_version) SELECT printf('%05d',n),'LoadFixture','flag','[]',printf('%0500d',0),1,'delivery-fixture:1900000000' FROM ids");
    const r=await get("/data",ada);
    assert.equal(r.status,200);
    const data=await r.json();
    assert.ok(Buffer.byteLength(JSON.stringify(data.verdicts))>2*1024*1024);
    assert.equal(Object.values(data.verdicts).filter(v=>v.LoadFixture).length,4000);
    assert.equal(data.verdicts["04000"].LoadFixture.note.length,500);
  });
  await test("reviewers can choose either matched background and stale tabs cannot overwrite that choice", async () => {
    const catalog = JSON.parse(readFileSync(items, "utf8"));
    const oldArt = { v: { character: "", background: "", combined: "" }, tv: "" };
    const newArt = { v: { character: "", background: V + "/", combined: V + "/" }, tv: V + "/" };
    Object.assign(catalog[0], newArt, { upd: { tag: "night", at: 2 } });
    writeFileSync(items, JSON.stringify(catalog));
    wr("r2", "object", "put", "art-drop-gateway/meta/items.json", "--local", "--file", items);
    const options = join(state, "background-options.json");
    writeFileSync(options, JSON.stringify({
      tag: "night", ids: ["00001", "00002"],
      items: { "00001": { previous: oldArt, delivered: newArt } },
      previousReviews: { Ada: { "00002": { verdict: "flag", note: "Daylight", reasons: [] } } },
    }));
    wr("r2", "object", "put", "art-drop-gateway/meta/background-options.json", "--local", "--file", options);
    const read = async () => (await get("/data", ada)).json();
    const start = await read();
    catalogVersion = start.catalog_version;
    assert.deepEqual(start.background_options.ids, ["00001", "00002"]);
    assert.equal(start.background_options.previousReviews["00002"].note, "Daylight");
    assert.deepEqual((await (await get("/data", max)).json()).background_options.previousReviews, {});
    const select = (id, choice, auth = ada, origin = BASE, background_version = 0) =>
      post("/background", auth, [{ id, choice, background_version }], origin);
    assert.equal((await select("00001", "previous", undefined, "https://example.invalid")).status, 403);
    assert.equal((await select("00001", "previous", basic("Artist", PW))).status, 403);
    assert.equal((await select("00002", "previous")).status, 404);
    const chosen = await select("00001", "previous");
    assert.equal(chosen.status, 200);
    const first = await chosen.json();
    assert.equal(first.selection.choice, "previous");
    assert.equal((await read()).background_selections["00001"].choice, "previous");
    assert.equal((await post("/verdict", ada, [{ id: "00002", verdict: "ok" }])).status, 200);
    assert.equal((await select("00001", "delivered")).status, 409);
    assert.equal((await post("/verdict", ada, [{ id: "00001", verdict: "ok" }])).status, 409);
    assert.equal((await post("/verdict", ada, [{ id: "00003", verdict: "ok" }, { id: "00001", verdict: "ok" }])).status, 409);
    assert.deepEqual((await read()).verdicts["00003"], start.verdicts["00003"]);
    assert.equal(first.catalog_version, catalogVersion);
    assert.equal((await select("00001", "delivered", ada, BASE, first.selection.seq)).status, 200);
    const end = await read();
    assert.equal(end.background_selections["00001"].choice, "delivered");
    assert.deepEqual(end.verdicts["00001"], start.verdicts["00001"]);
    catalogVersion = end.catalog_version;
    catalog[0].v.character = V + "/";
    writeFileSync(items, JSON.stringify(catalog));
    wr("r2", "object", "put", "art-drop-gateway/meta/items.json", "--local", "--file", items);
    catalogVersion = (await read()).catalog_version;
    assert.equal((await select("00001", "previous", ada, BASE, end.background_selections["00001"].seq)).status, 404);
  });
} finally {
  dev.kill("SIGTERM"); rmSync(".dev.vars", { force: true }); rmSync(state, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
