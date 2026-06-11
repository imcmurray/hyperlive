// The moderation gate: cheapest/hardest filters first. These tests pin the
// gate's contract — what gets through, what doesn't, and (deliberately) what
// is NOT its job: the gate passes markup through as text, because rendering
// safety belongs to the scene's clean()/sandbox layer, not here. The
// adversarial probe (tests/adversarial/) covers that second half.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createModerator } = await import("../../packages/ingest/src/moderation.js");

const mod = () => createModerator();
// unique author per call so the per-author rate limiter (which counts EVERY
// message, allowed or not) never conflates separate assertions in one test
let seq = 0;
const allow = async (m, text, author = `@u${seq++}`) => (await m.moderate({ author, text })).allowed;

test("profanity and slur stems are blocked", async () => {
  const m = mod();
  assert.equal(await allow(m, "fuck this"), false);
  assert.equal(await allow(m, "fuuuuck"), false); // stretched
  assert.equal(await allow(m, "n1gg..."), false); // leetspeak stem
  assert.equal(await allow(m, "kill yourself"), false);
});

test("scam patterns and non-suno links are blocked, suno links pass", async () => {
  const m = mod();
  assert.equal(await allow(m, "FREE V-BUCKS http://scam.example.com"), false);
  assert.equal(await allow(m, "join discord.gg/abc"), false);
  assert.equal(await allow(m, "check https://evil.example.com/x"), false);
  assert.equal(await allow(m, "https://suno.com/s/i6L6bOSa8hqcgJSq"), true);
  assert.equal(await allow(m, "https://www.suno.com/song/abc-def"), true);
  // a suno link can't smuggle a second, non-suno link past the allowlist
  assert.equal(await allow(m, "https://suno.com/s/ok https://evil.example.com"), false);
});

test("rate limiter trips after ratePerMin messages in the window", async () => {
  const m = mod();
  const now = 1_000_000;
  for (let i = 0; i < 4; i++) {
    assert.equal((await m.moderate({ author: "@flood", text: `hi ${i}` }, now + i)).allowed, true);
  }
  const fifth = await m.moderate({ author: "@flood", text: "hi 5" }, now + 10);
  assert.equal(fifth.allowed, false);
  assert.equal(fifth.reason, "rate limit");
  // other authors are unaffected
  assert.equal((await m.moderate({ author: "@calm", text: "hello" }, now + 11)).allowed, true);
});

test("spam heuristics: too long, sustained all-caps, char flooding, empty", async () => {
  const m = mod();
  assert.equal(await allow(m, "x".repeat(201)), false);
  assert.equal(await allow(m, "THIS IS ALL CAPS SHOUTING FOREVER AND EVER"), false);
  assert.equal(await allow(m, "LETS GOOOO"), true); // short hype is fine
  assert.equal(await allow(m, "aaaaaaaaaaaa so good"), false); // 8+ repeats
  assert.equal(await allow(m, ""), false);
  assert.equal(await allow(m, "   "), false);
});

test("markup passes the gate AS TEXT — rendering safety is the scene's job", async () => {
  const m = mod();
  const v = await m.moderate({ author: "@t", text: '<img src=x onerror="alert(1)">' });
  assert.equal(v.allowed, true);
  // the gate must not "helpfully" rewrite it either — the audit trail needs
  // the original, and the scene's clean() is the single sanitization point
  assert.equal(v.text, '<img src=x onerror="alert(1)">');
});
