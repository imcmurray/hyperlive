// Custom automations are the most operator-shaped input surface: an event,
// ONE vetted action, and a params object with {who}-style placeholders. These
// tests pin the validation walls (event/action allowlists, size caps, count
// cap) and the substitution semantics — placeholders fill with event DATA,
// never interpretation, and a hostile params object can't pollute prototypes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AUTOMATIONS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "hl-auto-")), "automations.json");
const {
  loadAutomations, addCustom, updateCustom, setAutomation,
  setAutomationPoster, emitAutomation, listAutomations,
} = await import("../../packages/ingest/src/automations.js");

await loadAutomations();

test("addCustom rejects unknown events, unknown actions, bad params", async () => {
  assert.equal((await addCustom({ on: "stream_hacked", action: "burst" })).ok, false);
  assert.equal((await addCustom({ on: "superchat", action: "evalScene" })).ok, false);
  assert.equal((await addCustom({ on: "superchat", action: "showCard" })).ok, false); // gated action — never automatable
  assert.equal((await addCustom({ on: "superchat", action: "takeover" })).ok, false);
  assert.equal((await addCustom({ on: "superchat", action: "burst", params: "not-an-object" })).ok, false);
  assert.equal((await addCustom({ on: "superchat", action: "burst", params: [1, 2] })).ok, false);
  assert.equal((await addCustom({ on: "superchat", action: "burst", params: { x: "y".repeat(3000) } })).ok, false);
});

test("placeholders substitute event data; unknown braces are left alone", async () => {
  const fired = [];
  setAutomationPoster(async (d) => { fired.push(d); });
  const add = await addCustom({
    on: "superchat",
    action: "setTicker",
    params: { items: ["{who} sent {amount}", "{constructor} {nope}"] },
  });
  assert.equal(add.ok, true);
  emitAutomation("superchat", { who: "@whale", amount: "$50.00" });
  await new Promise((r) => setTimeout(r, 10)); // poster is fire-and-forget
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].params.items, ["@whale sent $50.00", "{constructor} {nope}"]);
  await updateCustom(add.automation.id, { remove: true });
});

test("hostile placeholder DATA stays inert string data", async () => {
  const fired = [];
  setAutomationPoster(async (d) => { fired.push(d); });
  const add = await addCustom({ on: "first_message", action: "addShoutout", params: { who: "{who}", text: "welcome {who}!" } });
  emitAutomation("first_message", { who: '<img src=x onerror="x()">' });
  await new Promise((r) => setTimeout(r, 10));
  // substitution is pure string interpolation — the markup arrives as data for
  // the scene's clean() to strip; nothing here ever evaluates it
  assert.equal(typeof fired[0].params.who, "string");
  assert.equal(fired[0].params.text, 'welcome <img src=x onerror="x()">!');
  await updateCustom(add.automation.id, { remove: true });
});

test("a JSON __proto__ key cannot pollute Object.prototype", async () => {
  const fired = [];
  setAutomationPoster(async (d) => { fired.push(d); });
  // exactly what a hostile POST body would produce after JSON.parse
  const params = JSON.parse('{"__proto__": {"polluted": true}, "kind": "welcome"}');
  const add = await addCustom({ on: "first_message", action: "react", params });
  assert.equal(add.ok, true);
  emitAutomation("first_message", { who: "@x" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
  assert.equal(fired[0].params.kind, "welcome");
  await updateCustom(add.automation.id, { remove: true });
});

test("custom automation count is capped at 24", async () => {
  const ids = [];
  for (let i = 0; i < 24; i++) {
    const r = await addCustom({ on: "milestone", action: "burst", params: {} });
    assert.equal(r.ok, true, `add #${i + 1} should fit under the cap`);
    ids.push(r.automation.id);
  }
  assert.equal((await addCustom({ on: "milestone", action: "burst" })).ok, false);
  for (const id of ids) await updateCustom(id, { remove: true });
});

test("builtin style changes are validated against the per-builtin style list", async () => {
  assert.equal((await setAutomation("superchat", { style: "evalScene" })).ok, false);
  assert.equal((await setAutomation("superchat", { style: "shoutout" })).ok, true);
  assert.equal((await setAutomation("nonsense", { enabled: false })).ok, false);
  const list = listAutomations();
  assert.equal(list.builtins.find((b) => b.key === "superchat").style, "shoutout");
  await setAutomation("superchat", { style: "golden-card" }); // restore
});
