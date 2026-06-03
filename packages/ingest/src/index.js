// Phase 1 orchestrator:
//   comment source → moderation gate → director → POST /mutate
// Every comment's full journey (decision + directive + result) is audit-logged.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createModerator } from "./moderation.js";
import { createDirector } from "./director.js";
import { createMoodState } from "./mood-state.js";
import { createMoodEngine } from "./mood.js";
import { createReactions } from "./reactions.js";
import { simulatorSource, liveSimulatorSource } from "./simulator.js";
import { youtubeSource } from "./youtube.js";

const moderator = createModerator();
const director = createDirector();
const moodState = createMoodState({ windowMs: config.moodWindowMs });
const reactions = createReactions({ postMutate, log: console.log });

let processed = 0;
let applied = 0;
let blocked = 0;

async function audit(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  try {
    await mkdir(path.dirname(config.auditLog), { recursive: true });
    await appendFile(config.auditLog, line + "\n");
  } catch {
    /* non-fatal */
  }
}

async function postMutate(directive) {
  const res = await fetch(config.mutateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(directive),
  });
  if (!res.ok) throw new Error(`mutate http ${res.status}`);
  return res.json();
}

// throttled "typed → on-scene" latency readout (excludes YouTube's broadcast buffer)
let lastDelayAt = 0;
function reportDelay(comment) {
  if (!config.showDelay || !comment.ts) return;
  const now = Date.now();
  if (now - lastDelayAt < 900) return; // it's a readout, not every event
  lastDelayAt = now;
  postMutate({ action: "setDelay", params: { ms: Math.max(0, now - comment.ts) } }).catch(() => {});
}

async function handle(comment) {
  processed += 1;

  const mod = await moderator.moderate(comment);
  if (!mod.allowed) {
    blocked += 1;
    console.log(`  ✗ BLOCK [${mod.reason}] ${comment.author}: ${comment.text}`);
    await audit({ stage: "blocked", comment, reason: mod.reason });
    return;
  }

  // feed the Collective Mood Engine (only moderated comments reach the aggregate)
  moodState.record(comment);

  // Fun Layer: instant emoji reactions + first-time welcome (parallel to the
  // director, no cooldown — meant to feel immediate)
  const fired = config.reactions ? await reactions.handle(comment).catch(() => []) : [];

  const dec = await director.decide(comment);
  if (dec.skip) {
    console.log(`  · skip  [${dec.skip}] ${comment.author}: ${comment.text}`);
    if (fired.length) reportDelay(comment); // a reaction still landed on screen
    await audit({ stage: "skipped", comment, reason: dec.skip });
    return;
  }

  // attach the viewer's avatar to shoutout cards (works for rules + LLM director)
  if (dec.directive.action === "addShoutout" && comment.avatar) dec.directive.params.avatar = comment.avatar;

  try {
    const out = await postMutate(dec.directive);
    reportDelay(comment);
    applied += 1;
    const p = dec.directive.params || {};
    const detail = p.theme || p.text || (p.tier ? `${p.tier} shoutout` : "") || "";
    console.log(`  ✓ APPLY ${dec.directive.action}(${detail}) ← ${comment.author}`);
    await audit({ stage: "applied", comment, directive: dec.directive, out });
  } catch (e) {
    console.error(`  ! FAIL  ${dec.directive.action}: ${e.message}`);
    await audit({ stage: "error", comment, directive: dec.directive, error: e.message });
  }
}

async function main() {
  console.log(`[ingest] source=${config.source} → ${config.mutateUrl}`);
  console.log(`[ingest] director: ${director.engine}`);
  console.log(`[ingest] moderation: rate=${config.ratePerMin}/min, blocklist=on, llm=${config.moderationLLM}`);
  if (config.maxEvents) console.log(`[ingest] demo mode: stopping after ${config.maxEvents} events`);

  const source = config.source === "youtube" ? youtubeSource()
    : config.source === "live" ? liveSimulatorSource() // endless lifelike crowd
    : simulatorSource();

  // Collective Mood Engine: periodic aggregate loop alongside the per-comment loop
  const moodEngine = config.mood ? createMoodEngine({ state: moodState, postMutate, log: console.log }) : null;
  if (moodEngine) moodEngine.start();

  process.on("SIGINT", () => {
    if (moodEngine) moodEngine.stop();
    console.log(`\n[ingest] stopping. processed=${processed} applied=${applied} blocked=${blocked}`);
    process.exit(0);
  });

  for await (const comment of source) {
    await handle(comment);
    if (config.maxEvents && processed >= config.maxEvents) break;
  }

  console.log(`\n[ingest] done. processed=${processed} applied=${applied} blocked=${blocked}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
