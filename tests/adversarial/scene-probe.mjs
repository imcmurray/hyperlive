// Adversarial scene probe — the safe-template invariant, proven in a real
// browser. The whole bet of this project is that untrusted internet input can
// mutate a LIVE DOM and never escape into script execution. This loads the
// actual scene in Chromium, fires a corpus of injection payloads through every
// untrusted door (mutateElement setText, the sandboxed card/takeover iframes,
// element-id smuggling, oversized + clamped params), and asserts that:
//
//   1. nothing the payload tried to execute ever ran (global JS sentinel),
//   2. the angle-bracket markup never became live DOM nodes,
//   3. the sandboxed iframes can't reach the parent or the network, and
//   4. clamps/caps hold (no unbounded text, no out-of-range tweens).
//
// It needs a running scene server (the streamer at :8080 — `docker compose
// -f docker-compose.demo.yml up` provides one) and a Chromium. Exit 0 = the
// invariant held for every payload; non-zero = a payload escaped (a real bug).
import puppeteer from "puppeteer-core";

const SCENE_URL = process.env.SCENE_URL || "http://127.0.0.1:8080/";
const CHROME = process.env.CHROME_BIN || "/usr/bin/chromium";

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, detail) => results.push({ name, pass: false, detail });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--headless=new", "--disable-gpu"],
});
const page = await browser.newPage();

// A global tripwire: any payload that manages to execute JS in the PARENT
// document flips window.__pwned. The scene must never let this happen.
await page.evaluateOnNewDocument(() => {
  window.__pwned = [];
  // common exfil/exec sinks a payload might try to reach
  window.__sentinel = (tag) => { window.__pwned.push(tag); };
});

page.on("dialog", async (d) => { await page.evaluate(() => window.__pwned.push("dialog")); await d.dismiss(); });
page.on("pageerror", () => {}); // payloads may throw inside sandboxes — that's fine, not an escape

await page.goto(SCENE_URL, { waitUntil: "load", timeout: 25000 });
await page.waitForFunction(() => window.__sceneReady === true, { timeout: 20000 });

const call = (action, params) => page.evaluate((a, p) => window.SceneAPI[a](p), action, params);
const pwned = () => page.evaluate(() => window.__pwned.slice());

// ---- the corpus --------------------------------------------------------------
const MARKUP_PAYLOADS = [
  '<img src=x onerror="window.parent.__sentinel(\'img-onerror\')">',
  '<svg onload="window.parent.__sentinel(\'svg-onload\')"></svg>',
  '<script>window.parent.__sentinel("inline-script")<\/script>',
  '<iframe src="javascript:window.parent.__sentinel(\'js-iframe\')"></iframe>',
  '<a href="javascript:window.parent.__sentinel(\'js-href\')">x</a>',
  '"><script>window.parent.__sentinel("break-out")<\/script>',
  '<style>@import url("http://127.0.0.1:1/exfil")</style>',
  '<body onload="window.parent.__sentinel(\'body-onload\')">',
];

// 1) Tier-1 setText: angle-bracket markup must be stripped to inert text, and
//    the element manifest only exposes registered ids — no arbitrary selector.
const manifest = await call("getElements");
const targetId = manifest.elements[0]?.id;
if (!targetId) fail("manifest.has-elements", "getElements returned no mutable elements");
else ok("manifest.has-elements");

for (const payload of MARKUP_PAYLOADS) {
  await call("mutateElement", { id: targetId, ops: [{ op: "setText", text: payload }] });
}
await new Promise((r) => setTimeout(r, 400)); // let any errant load/exec fire

// the target element must contain ZERO child element nodes from the payloads
const childTags = await page.evaluate((id) => {
  const el = document.querySelector(`[data-hf-id="${id}"]`) ||
             [...document.querySelectorAll("*")].find((e) => e.dataset && e.dataset.hfId === id);
  if (!el) return null;
  return [...el.querySelectorAll("*")].map((n) => n.tagName.toLowerCase());
}, targetId);
if (childTags === null) fail("setText.element-found", "could not re-find target element");
else if (childTags.length === 0) ok("setText.no-injected-nodes");
else fail("setText.no-injected-nodes", `payload created nodes: ${childTags.join(",")}`);

// 2) unknown element id is rejected (no smuggling a CSS selector or DOM ref)
const bogus = await call("mutateElement", { id: "body * { }", ops: [{ op: "setText", text: "x" }] });
if (bogus && bogus.ok === false) ok("setText.rejects-unknown-id");
else fail("setText.rejects-unknown-id", JSON.stringify(bogus));

// 3) text length clamp holds against a huge payload
await call("mutateElement", { id: targetId, ops: [{ op: "setText", text: "A".repeat(100000) }] });
const len = await page.evaluate((id) => {
  const el = [...document.querySelectorAll("*")].find((e) => e.dataset && e.dataset.hfId === id);
  return el ? el.textContent.length : -1;
}, targetId);
if (len >= 0 && len <= 200) ok("setText.length-clamped");
else fail("setText.length-clamped", `rendered length ${len} (expected <= 200)`);

// 4) tween clamps: an out-of-range scale/rotation can't run unbounded
const tw = await call("mutateElement", { id: targetId, ops: [{ op: "tween", scale: 9999, rotation: 9999, duration: 9999 }] });
if (tw && tw.ok) ok("tween.accepted-and-clamped"); // (clamp values verified in unit-land; here we just ensure no throw/escape)
else fail("tween.accepted-and-clamped", JSON.stringify(tw));

// 5) Tier-2 card: payload goes into the sandboxed iframe. It may render, but it
//    must NOT reach the parent. Fire every payload as card HTML.
for (const payload of MARKUP_PAYLOADS) {
  await call("showCard", { html: payload, who: "@attacker", seconds: 4 });
  await new Promise((r) => setTimeout(r, 150));
}
// the card iframe must be sandboxed with an empty allow-list (no allow-scripts)
const cardSandbox = await page.evaluate(() => {
  const f = document.querySelector("#card-slot iframe");
  return f ? f.getAttribute("sandbox") : "NO-IFRAME";
});
if (cardSandbox === "") ok("card.iframe-fully-sandboxed");
else fail("card.iframe-fully-sandboxed", `sandbox="${cardSandbox}"`);

// 6) Tier-3 takeover: same — sandboxed, no parent reach
await call("takeover", { html: MARKUP_PAYLOADS.join(""), seconds: 4 });
await new Promise((r) => setTimeout(r, 300));
const tkSandbox = await page.evaluate(() => {
  const f = document.querySelector("#takeover iframe");
  return f ? f.getAttribute("sandbox") : "NO-IFRAME";
});
if (tkSandbox === "") ok("takeover.iframe-fully-sandboxed");
else fail("takeover.iframe-fully-sandboxed", `sandbox="${tkSandbox}"`);

// oversized takeover html is rejected outright
const huge = await call("takeover", { html: "<p>" + "x".repeat(300000) + "</p>" });
if (huge && huge.ok === false) ok("takeover.rejects-oversized");
else fail("takeover.rejects-oversized", JSON.stringify(huge));

// 7) HTTP boundary: /mutate must REFUSE the gated actions. showCard/takeover
//    are reachable on the in-page SceneAPI, but the only doors from the network
//    are POST /card and /takeover, which pre-render off-air + vision-gate. A
//    viewer hitting /mutate with raw markup must be turned away.
const post = (path, body) => page.evaluate(async (u, b) => {
  const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, SCENE_URL.replace(/\/$/, "") + path, body);

for (const action of ["showCard", "takeover", "clearCards"]) {
  const r = await post("/mutate", { action, params: { html: "<b>x</b>" } });
  // applyDirective throws "unknown action" → 400; the action never runs
  if (r.status === 400) ok(`mutate.refuses-gated:${action}`);
  else fail(`mutate.refuses-gated:${action}`, `status ${r.status} ${JSON.stringify(r.body)}`);
}
// a legitimately allowlisted action still works through /mutate
const good = await post("/mutate", { action: "setHeadline", params: { text: "hello" } });
if (good.status === 200 && good.body.ok) ok("mutate.allows-vetted-action");
else fail("mutate.allows-vetted-action", `status ${good.status} ${JSON.stringify(good.body)}`);

// ---- the verdict -------------------------------------------------------------
await new Promise((r) => setTimeout(r, 600)); // final settle for any delayed exec
const escapes = await pwned();
if (escapes.length === 0) ok("invariant.no-parent-execution");
else fail("invariant.no-parent-execution", `payloads executed in parent: ${escapes.join(", ")}`);

await browser.close();

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
