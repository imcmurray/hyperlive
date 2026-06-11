// Per-stage interactive features: a stage carries which behaviours run, the
// active set is applied on GO LIVE, and the ingest gates on getFeature().
import { test } from "node:test";
import assert from "node:assert/strict";

const { FEATURE_KEYS, normalizeFeatures, setActiveFeatures, getFeature, activeFeatures } =
  await import("../../packages/ingest/src/features.js");

test("normalizeFeatures fills every key, defaulting ON unless explicitly false", () => {
  assert.deepEqual(normalizeFeatures(undefined), Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])));
  const n = normalizeFeatures({ effects: false, popups: false });
  assert.equal(n.effects, false);
  assert.equal(n.popups, false);
  assert.equal(n.votes, true); // unspecified → on
  assert.equal(n.superchats, true);
});

test("setActiveFeatures + getFeature gate behaviours; undefined resets to all-on", () => {
  setActiveFeatures({ votes: false, effects: false });
  assert.equal(getFeature("votes"), false);
  assert.equal(getFeature("effects"), false);
  assert.equal(getFeature("welcome"), true);
  setActiveFeatures(undefined); // a stage with no features block → everything on
  assert.deepEqual(activeFeatures(), Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])));
});
