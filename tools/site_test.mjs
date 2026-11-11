// Tests the Worker's password gate and review API against `wrangler dev`.
// Run from site/: node ../tools/site_test.mjs   (WRANGLER names the wrangler command; default: wrangler)
// It uses wrangler.example.toml and made-up data, so it needs no deployment of its own.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

const W = process.env.WRANGLER || "wrangler";
const CONFIG = ["--config", "wrangler.example.toml"];
const ITEMS = 50;
const BASE = "http://127.0.0.1:8799";
const PW = "test-password:with-colon";
const basic = (name, pw) => `Basic ${Buffer.from(`${name}:${pw}`).toString("base64")}`;
const get = (path, auth, init = {}) => fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init, headers: { ...(auth ? { Authorization: auth } : {}), ...init.headers } });
const post = (path, auth, body, origin = BASE) => get(path, auth, { method: "POST", body: JSON.stringify(body), headers: { Origin: origin } });

const state = mkdtempSync(join(tmpdir(), "gateway-site-test-"));
writeFileSync(".dev.vars", `REVIEW_PASSWORD="${PW}"\nALLOW_HTTP="1"\n`);
const wr = (...a) => execFileSync(W, [...a, ...CONFIG, "--persist-to", state], { stdio: "pipe" });
mkdirSync("public", { recursive: true });
copyFileSync("../tools/gallery.html", "public/gallery.html");
const items = join(state, "items.json");
writeFileSync(items, JSON.stringify(Array.from({ length: ITEMS }, (_, i) => ({ id: String(i + 1).padStart(5, "0") }))));
wr("d1", "execute", "art-drop-gateway", "--local", "--file", "schema.sql");
wr("r2", "object", "put", "art-drop-gateway/meta/items.json", "--local", "--file", items);
// Stand-in art, because the real art lives only in R2. The Worker serves bytes by path and never decodes them.
const fakeThumb = join(state, "thumb.webp"), fakeFull = join(state, "full.png");
writeFileSync(fakeThumb, randomBytes(4000));
writeFileSync(fakeFull, randomBytes(200000));
wr("r2", "object", "put", "art-drop-gateway/thumbs/00001_combined.webp", "--local", "--file", fakeThumb);
wr("r2", "object", "put", "art-drop-gateway/Images/ID00001/00001__combined.png", "--local", "--file", fakeFull);
const V = "r/0123456789abcdef";
wr("r2", "object", "put", `art-drop-gateway/${V}/Images/ID00001/00001__character.png`, "--local", "--file", fakeFull);
wr("r2", "object", "put", `art-drop-gateway/${V}/thumbs/00001_character.webp`, "--local", "--file", fakeThumb);
const dev = spawn(W, ["dev", ...CONFIG, "--port", "8799", "--ip", "127.0.0.1", "--persist-to", state], { stdio: "ignore" });

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, e.message); } };
try {
  for (let i = 0; i < 60; i++) { try { await get("/"); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

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
    for (const path of ["/", "/data", "/items.json", "/gallery.html", "/thumbs/00001_combined.webp", "/full/00001/combined.png", `/o/${V}/thumbs/00001_character.webp`, "/artist.csv"]) {
      await test(`401 ${why} ${path}`, async () => assert.equal((await get(path, auth)).status, 401));
    }
  }
  await test("a refused post saves nothing", async () => assert.equal((await post("/verdict", basic("Ada", "wrong"), [{ id: "00009", verdict: "ok" }])).status, 401));
  await test("the login box is requested", async () => assert.match((await get("/")).headers.get("www-authenticate"), /^Basic realm=/));

  const ada = basic("ada", PW), max = basic("Max", PW);
  await test("page loads", async () => { const r = await get("/", ada); assert.equal(r.status, 200); assert.match(await r.text(), /Art Review/); });
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
} finally {
  dev.kill("SIGTERM"); rmSync(".dev.vars", { force: true }); rmSync(state, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
