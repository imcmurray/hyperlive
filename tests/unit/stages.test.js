// Stages are operator-defined presets for the main video. Like automations,
// they're data that compiles to vetted scene directives — these tests pin the
// validation (kind allowlist, youtube id / http url requirements), the
// builtins, the count cap, and that applying a stage yields the right
// setStageSource(+theme) directives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.STAGES_FILE = path.join(await mkdtemp(path.join(tmpdir(), "hl-stages-")), "stages.json");
const { loadStages, listStages, addStage, removeStage, getStage, buildApplyDirectives, STAGE_KINDS } =
  await import("../../packages/ingest/src/stages.js");

await loadStages();

test("builtins are always present; scene is the default active", () => {
  const l = listStages();
  assert.ok(l.builtins.find((b) => b.id === "scene"));
  assert.equal(l.active, "scene");
  assert.deepEqual(STAGE_KINDS, ["scene", "youtube", "video", "image"]);
});

test("addStage validates kind and source requirements", async () => {
  assert.equal((await addStage({ kind: "hologram" })).ok, false);
  assert.equal((await addStage({ kind: "youtube" })).ok, false); // no id/url
  assert.equal((await addStage({ kind: "video", source: "ftp://nope" })).ok, false);
  assert.equal((await addStage({ kind: "image" })).ok, false);
  const yt = await addStage({ kind: "youtube", source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", label: "rick" });
  assert.equal(yt.ok, true);
  assert.equal(yt.stage.videoId, "dQw4w9WgXcQ"); // extracted from the url
  assert.notEqual(yt.stage.id, "dQw4w9WgXcQ"); // the stage's own id is distinct
  assert.equal(yt.stage.muted, false); // a video stage defaults to SOUND ON
  await removeStage(yt.stage.id);
});

test("a video stage keeps an http(s) url and default sound-on", async () => {
  const v = await addStage({ kind: "video", source: "https://example.com/a.m3u8", muted: false });
  assert.equal(v.ok, true);
  const s = getStage(v.stage.id);
  assert.equal(s.url, "https://example.com/a.m3u8");
  assert.equal(s.muted, false);
  await removeStage(v.stage.id);
});

test("buildApplyDirectives compiles each kind to setStageSource (+ theme) and titles", () => {
  // every apply ends with a setTitles directive (the global default is slideL)
  assert.deepEqual(buildApplyDirectives({ kind: "scene" }), [
    { action: "setStageSource", params: { kind: "none" } },
    { action: "setTitles", params: { show: true, anim: "slideL" } },
  ]);
  assert.deepEqual(buildApplyDirectives({ kind: "scene", theme: "ocean" }), [
    { action: "setStageSource", params: { kind: "none" } },
    { action: "transitionTheme", params: { theme: "ocean", duration: 1.2 } },
    { action: "setTitles", params: { show: true, anim: "slideL" } },
  ]);
  assert.deepEqual(buildApplyDirectives({ kind: "youtube", videoId: "dQw4w9WgXcQ", muted: false }), [
    { action: "setStageSource", params: { kind: "youtube", id: "dQw4w9WgXcQ", muted: false } },
    { action: "setTitles", params: { show: true, anim: "slideL" } },
  ]);
  assert.deepEqual(buildApplyDirectives({ kind: "image", url: "https://x/y.png" }), [
    { action: "setStageSource", params: { kind: "image", url: "https://x/y.png" } },
    { action: "setTitles", params: { show: true, anim: "slideL" } },
  ]);
});

test("a stage's own title setting overrides the global default; hide flies them out", () => {
  // per-stage anim wins
  assert.deepEqual(buildApplyDirectives({ kind: "scene", titleAnim: "slideU" }).at(-1),
    { action: "setTitles", params: { show: true, anim: "slideU" } });
  // "hide" → titles fly OUT for a clean stage
  assert.deepEqual(buildApplyDirectives({ kind: "youtube", videoId: "dQw4w9WgXcQ", titleAnim: "hide" }).at(-1),
    { action: "setTitles", params: { show: false, anim: "fade" } });
});

test("setTitleDefault validates and changes the effective title anim", async () => {
  const { setTitleDefault, getTitleDefault } = await import("../../packages/ingest/src/stages.js");
  assert.equal((await setTitleDefault("backflip")).ok, false);
  assert.equal((await setTitleDefault("fade")).ok, true);
  assert.equal(getTitleDefault(), "fade");
  assert.deepEqual(buildApplyDirectives({ kind: "scene" }).at(-1),
    { action: "setTitles", params: { show: true, anim: "fade" } });
  await setTitleDefault("slideL"); // restore for other tests
});

test("custom stages are capped at 24", async () => {
  const ids = [];
  for (let i = 0; i < 24; i++) {
    const r = await addStage({ kind: "image", source: `https://x/${i}.png` });
    if (r.ok) ids.push(r.stage.id);
  }
  // some of the 24 slots may be used by earlier tests' leftovers; just assert
  // the cap rejects once full
  let rejected = false;
  for (let i = 0; i < 30; i++) { const r = await addStage({ kind: "image", source: `https://y/${i}.png` }); if (!r.ok) { rejected = true; break; } else ids.push(r.stage.id); }
  assert.equal(rejected, true, "the cap must reject eventually");
  for (const id of ids) await removeStage(id);
});

test("removing an unmodified builtin is a no-op (it's already at default)", async () => {
  assert.equal((await removeStage("scene")).ok, false);
});

test("a stage stores a full feature set; featuresOf defaults builtins to all-on", async () => {
  const { featuresOf } = await import("../../packages/ingest/src/stages.js");
  const add = await addStage({ kind: "youtube", source: "dQw4w9WgXcQ", features: { effects: false, popups: false } });
  assert.equal(add.stage.features.effects, false);
  assert.equal(add.stage.features.popups, false);
  assert.equal(add.stage.features.votes, true); // unspecified → on
  assert.equal(featuresOf(getStage("scene")).votes, true); // builtin → all on
  await removeStage(add.stage.id);
});

test("updateStage edits a custom stage in place, keeping its id; rejects unknown", async () => {
  const { updateStage } = await import("../../packages/ingest/src/stages.js");
  const add = await addStage({ kind: "youtube", source: "dQw4w9WgXcQ", label: "before" });
  const id = add.stage.id;
  const up = await updateStage(id, { kind: "youtube", source: "https://youtu.be/aaaaaaaaaaa", label: "after", titles: "hide" });
  assert.equal(up.ok, true);
  assert.equal(up.stage.id, id);          // same identity
  assert.equal(up.stage.videoId, "aaaaaaaaaaa");
  assert.equal(up.stage.label, "after");
  assert.equal(up.stage.titleAnim, "hide");
  assert.equal(getStage(id).label, "after");
  assert.equal((await updateStage("nope", { kind: "scene" })).ok, false);
  await removeStage(id);
});

test("ANY stage is editable: a builtin edit is an override; remove resets it", async () => {
  const { updateStage } = await import("../../packages/ingest/src/stages.js");
  const def = getStage("scene-ocean").theme; // "ocean"
  // edit the builtin's features + label
  const up = await updateStage("scene-ocean", { kind: "scene", label: "My Ocean", theme: "ocean", features: { votes: false } });
  assert.equal(up.ok, true);
  assert.equal(up.stage.builtin, true);
  assert.equal(getStage("scene-ocean").label, "My Ocean");
  assert.equal(getStage("scene-ocean").features.votes, false);
  assert.equal(getStage("scene-ocean").customized, true);
  // remove() RESETS a builtin to its default (doesn't delete it)
  const rm = await removeStage("scene-ocean");
  assert.equal(rm.ok, true);
  assert.equal(rm.reset, true);
  assert.equal(getStage("scene-ocean").label, "Scene · Ocean"); // back to default
  assert.equal(getStage("scene-ocean").theme, def);
});

test("title text + ticker compile to setKicker/Headline/Subhead + setTicker", () => {
  const stage = {
    kind: "youtube", videoId: "dQw4w9WgXcQ",
    kicker: "live now", headline: "FROM THE FLOOR", subhead: "stay tuned",
    ticker: ["one", "two", "three"], titleAnim: "fade",
  };
  const d = buildApplyDirectives(stage);
  const byAction = Object.fromEntries(d.map((x) => [x.action, x.params]));
  assert.equal(byAction.setKicker.text, "live now");
  assert.equal(byAction.setHeadline.text, "FROM THE FLOOR");
  assert.equal(byAction.setSubhead.text, "stay tuned");
  assert.deepEqual(byAction.setTicker.items, ["one", "two", "three"]);
  // title text is set BEFORE the fly-in so the new text animates in
  assert.ok(d.findIndex((x) => x.action === "setHeadline") < d.findIndex((x) => x.action === "setTitles"));
});

test("ticker accepts a newline string, clamps to 8, strips blank lines", async () => {
  const add = await addStage({ kind: "scene", ticker: "alpha\n\nbeta\n  \ngamma" });
  assert.deepEqual(getStage(add.stage.id).ticker, ["alpha", "beta", "gamma"]);
  const big = await addStage({ kind: "scene", ticker: Array.from({ length: 12 }, (_, i) => `m${i}`).join("\n") });
  assert.equal(getStage(big.stage.id).ticker.length, 8); // capped
  await removeStage(add.stage.id);
  await removeStage(big.stage.id);
});
