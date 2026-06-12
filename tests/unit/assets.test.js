// The asset library: aired cards captured for reuse, deduped by markup,
// star-rated 0–3, favorites-first ordering, capped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASSETS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "hl-assets-")), "assets.json");
process.env.ASSETS_SEED = "/nonexistent-no-seed-in-tests.json"; // start empty, not from the shipped examples
const { loadAssets, captureAsset, listAssets, getAsset, setStars, removeAsset, markUsed } =
  await import("../../packages/ingest/src/assets.js");

await loadAssets();

test("capture stores an asset and derives a label from the markup", async () => {
  const a = await captureAsset({ kind: "card", html: "<div>Welcome back, legends!</div>", who: "mod" });
  assert.equal(a.kind, "card");
  assert.equal(a.stars, 0);
  assert.equal(a.usedCount, 1);
  assert.equal(a.label, "Welcome back, legends!");
  assert.ok(getAsset(a.id));
  await removeAsset(a.id);
});

test("airing the same markup again dedups → bumps usedCount, no duplicate", async () => {
  const first = await captureAsset({ kind: "card", html: "<b>same</b>", who: "a" });
  const again = await captureAsset({ kind: "card", html: "<b>same</b>", who: "b" });
  assert.equal(again.id, first.id);
  assert.equal(again.usedCount, 2);
  assert.equal(listAssets().filter((x) => x.id === first.id).length, 1);
  await removeAsset(first.id);
});

test("stars clamp to 0–3 and sort favorites first", async () => {
  const a = await captureAsset({ kind: "card", html: "<p>one</p>" });
  const b = await captureAsset({ kind: "card", html: "<p>two</p>" });
  await setStars(a.id, 9);       // clamps to 3
  assert.equal(getAsset(a.id).stars, 3);
  await setStars(b.id, 1);
  const order = listAssets().map((x) => x.id);
  assert.ok(order.indexOf(a.id) < order.indexOf(b.id), "3-star sorts before 1-star");
  assert.equal((await setStars("nope", 2)).ok, false);
  await removeAsset(a.id); await removeAsset(b.id);
});

test("markUsed bumps usage + recency", async () => {
  const a = await captureAsset({ kind: "takeover", html: "<section>x</section>" });
  await markUsed(a.id);
  assert.equal(getAsset(a.id).usedCount, 2);
  await removeAsset(a.id);
});

test("capture ignores empty markup", async () => {
  assert.equal(await captureAsset({ kind: "card", html: "" }), null);
});

test("the shipped starter-example seed file is valid", async () => {
  const { readFile } = await import("node:fs/promises");
  const seed = JSON.parse(await readFile("packages/ingest/examples/assets.seed.json", "utf8"));
  assert.ok(Array.isArray(seed.assets) && seed.assets.length >= 5, "has example assets");
  for (const a of seed.assets) {
    assert.ok(a.html && a.kind && a.label, "each example has html/kind/label");
    assert.ok(["card", "takeover"].includes(a.kind));
  }
});
