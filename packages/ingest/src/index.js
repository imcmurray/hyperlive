// Phase 1 orchestrator:
//   comment source → moderation gate → director → POST /mutate
// Every comment's full journey (decision + directive + result) is audit-logged.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createModerator } from "./moderation.js";
import { createDirector } from "./director.js";
import { simulatorSource } from "./simulator.js";
import { youtubeSource } from "./youtube.js";

const moderator = createModerator();
const director = createDirector();

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

async function handle(comment) {
  processed += 1;

  const mod = await moderator.moderate(comment);
  if (!mod.allowed) {
    blocked += 1;
    console.log(`  ✗ BLOCK [${mod.reason}] ${comment.author}: ${comment.text}`);
    await audit({ stage: "blocked", comment, reason: mod.reason });
    return;
  }

  const dec = await director.decide(comment);
  if (dec.skip) {
    console.log(`  · skip  [${dec.skip}] ${comment.author}: ${comment.text}`);
    await audit({ stage: "skipped", comment, reason: dec.skip });
    return;
  }

  try {
    const out = await postMutate(dec.directive);
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

  const source = config.source === "youtube" ? youtubeSource() : simulatorSource();

  process.on("SIGINT", () => {
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
