import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./gallery.html", import.meta.url), "utf8");
const script = html.match(/<script(?: type="module")?>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*review-state.*;\s*$/m, "").replace(/\binit\(\);\s*$/, "");
let reviewStatus, artVersion;
try { ({ reviewStatus, artVersion } = await import("./review-state.mjs")); } catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}

function gallery({ failSave = false } = {}) {
  const nodes = new Map(), writes = [];
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: id === "filter" ? "all" : "", style: {}, dataset: {},
        classList: { add: (...s) => s.forEach((x) => classes.add(x)), remove: (s) => classes.delete(s), contains: (s) => classes.has(s) } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({ reviewStatus, artVersion, document: { getElementById: node, querySelector: () => null },
    localStorage: { getItem: () => "{}", setItem() {} }, scrollTo() {}, setTimeout() {},
    fetch: async (path, options) => { writes.push({ path, body: JSON.parse(options.body) }); return { ok: !failSave, status: failSave ? 503 : 200 }; } });
  vm.runInContext(script, context);
  vm.runInContext(`ME="Ada"; items=[{id:"00001"},{id:"00002"},{id:"00003"}];
    byId=Object.fromEntries(items.map(d=>[d.id,d])); list=items;
    ALL={"00001":{Ada:{by:"Ada",verdict:"flag",reasons:["Edge halo"],note:"Check the wing",at:1}},
      "00002":{Ada:{by:"Ada",verdict:"flag",reasons:["Cut off"],note:"Keep this",at:1}}};
    UPD={"00001":{tag:"new-delivery",kinds:["character"],at:10},"00003":{tag:"new-delivery",kinds:["background"],at:10}};
    TRIAGE={"00001":{status:"fixed",at:2}};`, context);
  return { run: (code) => vm.runInContext(code, context), node, writes };
}

test("changed flagged art needs re-review while unchanged flags and unflagged art do not", () => {
  const g = gallery();
  assert.equal(g.run("typeof needsReReview"), "function", "gallery has no explicit re-review state");
  assert.equal(g.run('needsReReview("00001")'), true);
  assert.equal(g.run('needsReReview("00002")'), false);
  assert.equal(g.run('needsReReview("00003")'), false);
  assert.equal(g.run('stOf("00001")'), "rereview");
});

test("a fresh flag review keeps its reason and updated note and resolves the old re-review state", async () => {
  const g = gallery();
  await g.run('setV("00001","flag",["Edge halo"],"Wing still needs work")');
  assert.equal(g.run('needsReReview("00001")'), false);
  assert.equal(g.run('mine("00001").verdict'), "flag");
  assert.equal(g.run('mine("00001").note'), "Wing still needs work");
  assert.equal(g.run('stOf("00001")'), "", "old fixed status must not label a newly reaffirmed flag fixed");
  assert.equal(g.writes[0].body[0].note, "Wing still needs work");
});

test("removing my old flag resolves its re-review state", async () => {
  const g = gallery();
  await g.run('setV("00001","clear")');
  assert.equal(g.run('needsReReview("00001")'), false);
  assert.equal(g.run('flaggers("00001").length'), 0);
});

test("another reviewer's old flag remains pending until they update or remove it", async () => {
  const g = gallery();
  g.run('ALL["00001"].Max={by:"Max",verdict:"flag",reasons:[],note:"Old concern",at:1}');
  await g.run('setV("00001","clear")');
  assert.equal(g.run('needsReReview("00001")'), true);
  g.run('ME="Max"');
  await g.run('setV("00001","flag",[],"Still a problem")');
  assert.equal(g.run('needsReReview("00001")'), false);
  g.run('UPD["00001"].at=Date.now()/1000+10');
  assert.equal(g.run('needsReReview("00001")'), true, "a later art change must require another review");
});

test("a timestamp after publication cannot acknowledge art that was reviewed in an old tab", () => {
  const g = gallery();
  g.run('ALL["00001"].Ada.at=Math.floor(Date.now()/1000); ALL["00001"].Ada.art_version="previous-delivery:1"');
  assert.equal(g.run('needsReReview("00001")'), true);
  assert.equal(g.run('stale("00001")'), true);
});

test("bulk page approval preserves old flagged art and its note", async () => {
  const g = gallery();
  await g.run("pageGood()");
  assert.equal(g.run('mine("00001").verdict'), "flag");
  assert.equal(g.run('mine("00001").note'), "Check the wing");
  assert.equal(g.run('mine("00002").verdict'), "flag");
  assert.equal(g.run('mine("00003").verdict'), "ok");
});

test("saving a re-review removes the completed item from its queue and closes the last detail", async () => {
  const g = gallery();
  g.node("filter").value = "rereview";
  g.run('compute(); openDetail("00001")');
  assert.equal(g.run("list.length"), 1);
  await g.run('dSave("flag")');
  assert.equal(g.run("list.length"), 0);
  assert.equal(g.node("detail").classList.contains("open"), false);
  assert.match(g.node("pageinfo").textContent, /0 items/);
});

test("a failed flag update preserves the pending flag and does not advance to another item", async () => {
  const g = gallery({ failSave: true });
  g.node("filter").value = "rereview";
  g.run('UPD["00002"]={tag:"new-delivery",at:10}; compute(); openDetail("00001")');
  g.node("note").value = "Edited concern";
  await g.run('dSave("flag")');
  assert.equal(g.node("detail").dataset.id, "00001");
  assert.equal(g.run('mine("00001").note'), "Check the wing");
  assert.equal(g.run('needsReReview("00001")'), true);
});

test("the filter, tile, detail, fix list and artist view show pending re-review", () => {
  const g = gallery();
  assert.equal(g.run('!!FILTERS.rereview'), true);
  assert.equal(g.run('FILTERS.rereview[1](byId["00001"])'), true);
  assert.match(g.run('flagText("00001")'), /re-review/i);
  g.run('openDetail("00001")');
  assert.equal(g.node("note").value, "Check the wing");
  assert.match(g.node("dmeta").innerHTML, /re-review/i);
  assert.doesNotMatch(g.node("dmeta").innerHTML, /Fix list:<\/b> fixed/);
  g.run("paintFixes()");
  assert.match(g.node("fixsum").textContent, /1.*re-review/i);
  assert.match(g.node("fixrows").innerHTML, /Needs re-review/);
  assert.match(g.run('artRow(byId["00001"])'), /Awaiting re-review/);
});
