import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./gallery.html", import.meta.url), "utf8");
const script = html.match(/<script(?: type="module")?>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*review-state.*;\s*$/m, "").replace(/\binit\(\);\s*$/, "");
let reviewState = {};
try { reviewState = await import("./review-state.mjs"); } catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}

function gallery({ failSave = false, data, settings = {}, search = "", backgroundResponse, animationResponse = async () => ({ ok: false }) } = {}) {
  const nodes = new Map(), writes = [];
  let saved = JSON.stringify(settings);
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: id === "filter" ? "all" : "", style: {}, dataset: {},
        setAttribute(name, value) { this[name] = value; },
        getAttribute(name) { return this[name] ?? null; },
        removeAttribute(name) { delete this[name]; },
        pause() {}, load() {},
        insertAdjacentHTML(_position, content) { this.innerHTML = (this.innerHTML ?? "") + content; },
        classList: { add: (...s) => s.forEach((x) => classes.add(x)), remove: (s) => classes.delete(s), contains: (s) => classes.has(s),
          toggle: (s, force) => force ? classes.add(s) : classes.delete(s) } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({ ...reviewState, URLSearchParams, location: { search, hash: "" },
    document: { getElementById: node, querySelector: () => null, body: node("body") },
    localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } },
    matchMedia: () => ({ matches: false }), scrollTo() {}, setTimeout() {},
    fetch: async (path, options) => {
      if (path === "/data") return { json: async () => ({ review_enabled: true, ...data }) };
      if (path.startsWith("/animation/")) return animationResponse(path, options);
      writes.push({ path, body: JSON.parse(options.body) });
      return { ok: !failSave, status: failSave ? 503 : 200, json: async () => backgroundResponse };
    } });
  vm.runInContext(script, context);
  vm.runInContext('if (typeof REVIEW_ENABLED !== "undefined") REVIEW_ENABLED = true;', context);
  vm.runInContext(`ME="Ada"; items=[{id:"00001"},{id:"00002"},{id:"00003"}];
    byId=Object.fromEntries(items.map(d=>[d.id,d])); list=items;
    ALL={"00001":{Ada:{by:"Ada",verdict:"flag",reasons:["Edge halo"],note:"Check the wing",at:1}},
      "00002":{Ada:{by:"Ada",verdict:"flag",reasons:["Cut off"],note:"Keep this",at:1}}};
    UPD={"00001":{tag:"new-delivery",kinds:["character"],at:10},"00003":{tag:"new-delivery",kinds:["background"],at:10}};
    TRIAGE={"00001":{status:"fixed",at:2}};`, context);
  return { run: (code) => vm.runInContext(code, context), node, writes, savedSettings: () => JSON.parse(saved) };
}

const deliveryData = {
  me: "Ada", verdicts: {}, triage: {}, updates: {},
  items: [
    { id: "00001", type: "Pirate", traits: { Hat: "Cap" }, upd: { tag: "delivery-2026-11-21", at: 20 } },
    { id: "00002", type: "Shark", traits: { Hat: "Crown" }, upd: { tag: "delivery-2026-11-21", at: 20 } },
    { id: "00003", type: "Pirate", upd: { tag: "delivery-2026-11-14", at: 10 } },
  ],
};

test("only an approved clip loads next to the still, and the next pirate clears the player", async () => {
  const calls = [];
  const g = gallery({
    data: { ...deliveryData, review_enabled: false },
    animationResponse: async (path, options) => {
      calls.push([path, options.method]);
      return { ok: path === "/animation/00001.mp4" };
    },
  });
  await g.run("init()");
  assert.deepEqual(calls, []);
  await g.run('openDetail("00001")');
  assert.equal(g.node("dimg").src, "/full/00001/combined.png");
  assert.equal(g.node("danimation").hidden, false);
  assert.equal(g.node("dvideo").src, "/animation/00001.mp4");
  assert.deepEqual(calls, [["/animation/00001.mp4", "HEAD"]]);
  await g.run('openDetail("00002")');
  assert.equal(g.node("danimation").hidden, true);
  assert.equal(g.node("dvideo").src, undefined);
  assert.equal(g.node("dimg").src, "/full/00002/combined.png");
});

test("approved living photos request muted inline autoplay and keep controls", () => {
  const player = html.match(/<video id="dvideo"[^>]*>/)?.[0];
  for (const attribute of ["autoplay", "muted", "playsinline", "loop", "controls"])
    assert.match(player, new RegExp(`\\s${attribute}(?:\\s|>)`));
});

test("Animated is a direct counted trait backed by live videos and combines with other traits", async () => {
  const g = gallery({ data: {
    ...deliveryData, review_enabled: false, animated_ids: ["00002", "00003", "99999"],
    items: [
      { ...deliveryData.items[0], animated: true, traits: { Hat: "Cap", Animated: "Yes" } },
      deliveryData.items[1],
      { ...deliveryData.items[2], traits: { Hat: "Cap" } },
    ],
  } });
  await g.run("init()");
  const markup = () => g.node("trait-values-0").innerHTML;
  assert.match(markup(), /data-tk="Animated" data-tv="Yes"/);
  assert.match(markup(), /Animated<\/span><span[^>]*>2<\/span>/);
  function select(tk, tv) {
    g.node("trait-groups").onclick({ target: { closest: () => ({ dataset: { tk, tv } }) } });
  }
  select("Animated", "Yes");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00002,00003");
  select("Hat", "Cap");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00003");
  assert.match(markup(), /Animated<\/span><span[^>]*>1<\/span>/);
  select("Animated", "Yes");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00003");
  await g.run('openDetail("00003")');
  assert.match(g.node("dtraitchips").innerHTML, /data-tk="Animated" data-tv="Yes"/);
  await g.run('openDetail("00001")');
  assert.doesNotMatch(g.node("dtraitchips").innerHTML, /data-tk="Animated"/);
});

test("a late approval response cannot reopen a player after leaving a pirate", async () => {
  let showFirst;
  const g = gallery({
    data: { ...deliveryData, review_enabled: false },
    animationResponse: (path) => path === "/animation/00001.mp4"
      ? new Promise(resolve => { showFirst = resolve; }) : Promise.resolve({ ok: false }),
  });
  await g.run("init()");
  const first = g.run('openDetail("00001")');
  assert.equal(typeof showFirst, "function");
  g.run("close()");
  showFirst({ ok: true });
  await first;
  assert.equal(g.node("danimation").hidden, true);
  assert.equal(g.node("dvideo").src, undefined);
});

test("the delivery filter shows only the latest batch", async () => {
  const g = gallery({ data: deliveryData });
  await g.run("init()");
  assert.match(g.node("filter").innerHTML, /Delivery 2026-11-21 \(2\)/);
  g.node("filter").value = "delivery";
  g.run("compute()");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
});

test("viewer mode shows art and IDs, keeps direct delivery and layer navigation, and ignores review preferences", async () => {
  const prefix = "r/0123456789abcdef/";
  const g = gallery({
    data: { ...deliveryData, review_enabled: false, me: "Luis", config: { artist: "Luis" },
      items: [{ ...deliveryData.items[0], mint: true, v: { character: prefix } }, ...deliveryData.items.slice(1)],
      verdicts: { "00001": { Luis: { verdict: "flag", note: "A private note" } } } },
    search: "?delivery=delivery-2026-11-21",
    settings: { f: "mine", ty: "Ghost", tr: { Hat: "None" }, page: 7 },
  });
  await g.run("init()");
  assert.equal(g.node("body").classList.contains("viewer"), true);
  assert.equal(g.node("body").classList.contains("artist"), false);
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
  assert.equal(g.run("page"), 0);
  assert.match(g.node("grid").innerHTML, /<img[^>]+><span class="id">00001<\/span>/);
  assert.doesNotMatch(g.node("grid").innerHTML, /class="tags"|class="fl|data-flags|A private note|tile cur/);
  g.node("view").value = "character";
  g.node("view").onchange();
  g.node("jump").onchange({ target: { value: "1" } });
  assert.equal(g.node("ddownload").href, "/o/r/0123456789abcdef/Images/ID00001/00001__character.png?download=1");
  assert.equal(g.node("artlist").classList.contains("open"), false);
  await g.run('setV("00001","flag")');
  assert.equal(g.writes.length, 0);
});

test("the trait sidebar opens Character Type and shows counts as filters combine", async () => {
  const g = gallery({
    data: { ...deliveryData, review_enabled: false,
      items: [
        { ...deliveryData.items[0], traits: { "Character Type": "Berserker Male", Eyes: "Red" } },
        { ...deliveryData.items[1], traits: { "Character Type": "Berserker Male", Eyes: "Gold" } },
        { ...deliveryData.items[2], traits: { "Character Type": "Druid Male", Eyes: "Red" } },
        { id: "00004", traits: { "Character Type": "Druid Male", Eyes: "Red" }, upd: deliveryData.items[0].upd },
      ] },
    search: "?delivery=delivery-2026-11-21",
  });
  await g.run("init()");
  assert.equal(g.node("trait-filters").hidden, false);
  assert.equal(g.node("trait-filters").open, true);
  const groups = () => g.node("trait-groups").innerHTML;
  const counts = category => g.node(category === "Character Type" ? "trait-values-0" : "trait-values-1").innerHTML;
  assert.match(groups(), /<details[^>]* open><summary>Character Type<\/summary>/);
  assert.match(groups(), /<summary>Eyes<\/summary>/);
  assert.match(counts("Character Type"), /Berserker Male<\/span><span[^>]*>2<\/span>/);
  assert.match(counts("Character Type"), /Druid Male<\/span><span[^>]*>1<\/span>/);

  const select = (tk, tv) => g.node("trait-groups").onclick({
    target: { closest: () => ({ dataset: { tk, tv } }) },
  });
  select("Character Type", "Berserker Male");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
  assert.match(counts("Character Type"), /data-tv="Berserker Male"[^>]*aria-pressed="true"/);
  assert.match(counts("Eyes"), /Red<\/span><span[^>]*>1<\/span>/);
  select("Eyes", "Gold");
  assert.match(counts("Character Type"), /Druid Male<\/span><span[^>]*>0<\/span>/);
  select("Eyes", "Red");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001");
  assert.match(g.node("tchips").innerHTML, /Character Type: Berserker Male/);
  assert.match(g.node("tchips").innerHTML, /Eyes: Red/);

  g.node("tchips").onclick({ target: { closest: () => ({ dataset: { k: "Character Type" } }) } });
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00004");
  assert.match(counts("Eyes"), /Red<\/span><span[^>]*>2<\/span>/);
  select("Eyes", "Red");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002,00004");
  assert.equal(g.writes.length, 0);
});

test("the detail names the still and living photo with matching headings", () => {
  assert.match(html, /<section id="dstill" aria-labelledby="dstill-title">\s*<h3 id="dstill-title">Still photo<\/h3>\s*<div id="stage">/);
  assert.match(html, /<section id="danimation" aria-labelledby="danimation-title" hidden>\s*<h3 id="danimation-title">Living photo<\/h3>/);
});

test("viewer details show every trait and tapping one filters the gallery", async () => {
  const g = gallery({
    data: { ...deliveryData, review_enabled: false,
      items: [
        { ...deliveryData.items[0], traits: { Hat: "Cap", Eyes: "Shark", Skin: "Gray" } },
        { ...deliveryData.items[1], traits: { Hat: "Crown", Eyes: "Shark", Skin: "Gold" } },
        { ...deliveryData.items[2], traits: { Hat: "Crown", Eyes: "Shark", Skin: "Gray" } },
        { id: "00004", upd: deliveryData.items[0].upd },
      ] },
    search: "?delivery=delivery-2026-11-21",
  });
  await g.run("init()");
  g.run('setTraits({Eyes:"Shark"});openDetail("00001")');
  assert.equal(g.node("dtraits").hidden, false);
  const chips = g.node("dtraitchips").innerHTML;
  assert.equal((chips.match(/<button/g) || []).length, 3);
  assert.match(chips, /data-tk="Hat" data-tv="Cap"[^>]*>Hat: Cap<i>1<\/i>/);
  assert.match(chips, /data-tk="Skin" data-tv="Gray"[^>]*>Skin: Gray<i>1<\/i>/);
  assert.match(chips, /data-tk="Eyes" data-tv="Shark"[^>]*aria-pressed="true"/);

  const cap = { target: { closest: () => ({ dataset: { tk: "Hat", tv: "Cap" } }) } };
  g.node("dtraitchips").onclick(cap);
  assert.equal(g.node("detail").classList.contains("open"), false);
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001");
  g.run('openDetail("00001")');
  assert.match(g.node("dtraitchips").innerHTML, /data-tk="Hat" data-tv="Cap"[^>]*aria-pressed="true"/);
  g.node("dtraitchips").onclick(cap);
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
  g.run('openDetail("00004")');
  assert.equal(g.node("dtraits").hidden, true);
  assert.equal(g.node("dtraitchips").innerHTML, "");
  assert.equal(g.writes.length, 0);
});

test("the download follows the full-size layer in the artwork detail", () => {
  const g = gallery();
  g.run('openDetail("00001")');
  assert.equal(g.node("ddownload").href, "/full/00001/combined.png?download=1");
  g.run('byId["00001"].v = { character: "r/0123456789abcdef/" }');
  g.node("layers").onclick({ target: { dataset: { l: "character" } } });
  assert.equal(g.node("ddownload").href, "/o/r/0123456789abcdef/Images/ID00001/00001__character.png?download=1");
});

test("the vampire review includes unchanged art and can choose the matched prior artwork in detail", async () => {
  const prefix = "r/0123456789abcdef/";
  const previous = { v: { character: "", background: "", combined: "" }, tv: "" };
  const delivered = { v: { character: "", background: prefix, combined: prefix }, tv: prefix };
  const selection = { choice: "previous", seq: 1, at: 25, source: prefix };
  const data = {
    ...deliveryData, catalog_version: "base",
    items: deliveryData.items.map((d, i) => i === 0 ? { ...d, ...delivered } : d),
    background_options: { tag: "delivery-2026-11-21", ids: ["00001", "00002"],
      items: { "00001": { previous, delivered } },
      previousReviews: { "00001": { verdict: "ok" }, "00002": { verdict: "flag", note: "Daylight", reasons: [] } } },
    background_selections: {},
  };
  const g = gallery({ data, search: "?backgrounds=all",
    backgroundResponse: { catalog_version: "base", selection } });
  await g.run("init()");
  assert.equal(g.node("filter").value, "backgroundVampires");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
  assert.match(g.node("filter").innerHTML, /Unchanged vampires \(1\)/);
  assert.match(g.node("filter").innerHTML, /Changed vampires I marked OK \(1\)/);
  const cards = g.node("grid").innerHTML;
  assert.match(cards, /Before.*00001_combined.webp.*After.*0123456789abcdef.*00001_combined.webp/);
  assert.match(cards, /I prefer the previous version/);
  assert.match(cards, /Unchanged in the night delivery/);
  const unchanged = cards.match(/<article[^>]+data-comparison-id="00002".*?<\/article>/s)[0];
  assert.match(unchanged, /Current.*00002_combined.webp.*After.*Unchanged in the night delivery/s);
  assert.equal(unchanged.match(/<img\b/g).length, 1);
  assert.match(unchanged, /Flag for change/);
  assert.doesNotMatch(cards.slice(0,cards.indexOf(unchanged)), /Flag for change/);
  assert.equal(g.node("detail").classList.contains("open"), false);
  const target = { dataset: { backgroundChoice: "previous" }, closest: () => ({ dataset: { comparisonId: "00001" } }) };
  await g.node("grid").onclick({ target });
  assert.equal(g.node("comparison-status-00001").textContent, "Showing previous version");
  assert.equal(g.node("comparison-choice-00001").dataset.backgroundChoice, "delivered");
  assert.equal(g.node("detail").classList.contains("open"), false);
  assert.deepEqual(g.writes.at(-1), { path: "/background", body: [
    { id: "00001", choice: "previous", catalog_version: "base", background_version: 0 },
  ] });
  const flag = { dataset: { flagChange: "" }, closest: () => ({ dataset: { comparisonId: "00002" } }) };
  await g.node("grid").onclick({ target: flag });
  assert.equal(g.writes.at(-1).path, "/verdict");
  assert.equal(g.writes.at(-1).body[0].id, "00002");
  assert.equal(g.writes.at(-1).body[0].verdict, "flag");
  assert.equal(g.node("comparison-flag-00002")["aria-pressed"], "true");
  assert.equal(g.node("detail").classList.contains("open"), false);
  await g.node("grid").onclick({ target: flag });
  assert.equal(g.writes.at(-1).body[0].verdict, "clear");
  assert.equal(g.node("comparison-flag-00002").textContent, "Flag for change");
  g.run('openDetail("00002")');
  assert.match(g.node("bmessage").textContent, /Unchanged/);
  assert.match(g.node("dmeta").innerHTML, /Before this delivery.*Flagged.*Daylight/);
  g.run('openDetail("00001")');
  assert.equal(g.node("bprevious").src, "/full/00001/background.png");
  assert.match(g.node("bdelivered").src, /0123456789abcdef.*00001__background/);
  assert.equal(g.node("dimg").src, "/full/00001/combined.png");
});

test("the inline review paginates and keeps the general gallery queue independently", async () => {
  const ids = Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(5, "0"));
  const data = { ...deliveryData, items: ids.map(id => ({ id })),
    background_options: { ids, items: {}, tag: "night" } };
  const g = gallery({ data, search: "?backgrounds=all", settings: { f: "all", page: 8 } });
  await g.run("init()");
  assert.match(g.node("pageinfo").textContent, /Page 1 of 2/);
  assert.doesNotMatch(g.node("grid").innerHTML, /00013/);
  g.node("next").onclick();
  assert.match(g.node("pageinfo").textContent, /Page 2 of 2/);
  assert.match(g.node("grid").innerHTML, /00013/);
  assert.equal(g.node("next").disabled, true);
  assert.equal(g.savedSettings().page, 8);
});

test("a delivery link opens exactly that batch without saved type or trait filters", async () => {
  const g = gallery({ data: deliveryData, search: "?delivery=delivery-2026-11-21",
    settings: { f: "all", ty: "Pirate", tr: { Hat: "Cap" }, page: 5 } });
  await g.run("init()");
  assert.equal(g.node("filter").value, "delivery");
  assert.equal(g.run('list.map(d=>d.id).join(",")'), "00001,00002");
  assert.equal(g.run("page"), 0);
  assert.match(g.node("stats").textContent, /You: 0 of 2 reviewed/);
});

test("a link to an older or missing delivery does not show a newer batch", async () => {
  for (const [tag, ids] of [["delivery-2026-11-14", "00003"], ["delivery-2026-11-07", ""]]) {
    const g = gallery({ data: deliveryData, search: "?delivery=" + tag });
    await g.run("init()");
    assert.equal(g.node("filter").value, "delivery");
    assert.equal(g.run('list.map(d=>d.id).join(",")'), ids);
  }
});

test("opening and paging through a delivery link preserves the regular gallery queue", async () => {
  const settings = { f: "all", ty: "Pirate", tr: { Hat: "Cap" }, page: 5 };
  const g = gallery({ data: deliveryData, search: "?delivery=delivery-2026-11-21", settings });
  await g.run("init()");
  g.run("goPage(0)");
  const { f, ty, tr, page } = g.savedSettings();
  assert.deepEqual({ f, ty, tr, page }, settings);
});

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

test("reapplying the same triage choice after an art change applies it on the first click", async () => {
  const g = gallery();
  await g.run('setV("00001","flag",[],"Still needs work")');
  assert.equal(g.run('stOf("00001")'), "");
  g.run('globalThis.triageEvent={target:{closest:()=>({dataset:{id:"00001"}}),dataset:{s:"fixed"}}}');
  await g.node("fixrows").onclick(g.run("triageEvent"));
  assert.equal(g.writes.at(-1).body[0].status,"fixed");
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

test("a failed flag removal preserves the original note and selected reasons for retry", async () => {
  const g = gallery({ failSave: true });
  g.run('openDetail("00001")');
  await g.node("dclear").onclick();
  assert.equal(g.node("note").value,"Check the wing");
  assert.equal(g.run('dReasons.has("Edge halo")'),true);
  assert.equal(g.run('mine("00001").verdict'),"flag");
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


test("opening the next artwork starts at its top after a long mobile review", () => {
  const g = gallery();
  g.run('openDetail("00001")');
  g.node("detail").scrollTop = 900;
  g.run('step(1)');
  assert.equal(g.node("detail").dataset.id,"00002");
  assert.equal(g.node("detail").scrollTop,0,"the next artwork is hidden above the previous item's scroll position");
});
