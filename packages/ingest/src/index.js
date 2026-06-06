// Phase 1 orchestrator:
//   comment source → moderation gate → director → POST /mutate
// Every comment's full journey (decision + directive + result) is audit-logged.

import "./load-env.js"; // must precede config.js so .env vars reach process.env
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createModerator } from "./moderation.js";
import { createDirector } from "./director.js";
import { createMoodState } from "./mood-state.js";
import { createMoodEngine } from "./mood.js";
import { createReactions } from "./reactions.js";
import { createVotes } from "./votes.js";
import { createMusic, parseSunoShare, isLikeCommand, hasHeart } from "./music.js";
import { simulatorSource, liveSimulatorSource } from "./simulator.js";
import { youtubeSource } from "./youtube.js";
import { createStreamLikes } from "./stream-likes.js";

const moderator = createModerator();
const director = createDirector();
const moodState = createMoodState({ windowMs: config.moodWindowMs });
const reactions = createReactions({ postMutate, log: console.log });
const votes = createVotes({ postMutate, log: console.log });
const music = createMusic({ baseUrl: config.musicUrl });

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

  // Music: a Suno share link is CONSUMED as a queue request; "!like" is CONSUMED
  // as a like for the current song; a heart/👍 in normal chat also likes the
  // song but falls through (so the heart reaction still fires).
  if (config.music) {
    const link = parseSunoShare(comment.text);
    if (link) {
      const r = await music.enqueue(link, comment.author).catch(() => ({ ok: false }));
      if (r.ok) {
        console.log(`  ♪ QUEUE ${comment.author} → ${r.title} — ${r.artist} [#${r.position}]`);
        postMutate({ action: "react", params: { kind: "sparkle", who: comment.author } }).catch(() => {});
      } else {
        console.log(`  ♪ queue rejected [${r.reason || "?"}] ${comment.author}`);
      }
      await audit({ stage: "music_request", comment, link, result: r });
      return;
    }
    if (isLikeCommand(comment.text)) {
      const r = await music.like(comment.author).catch(() => ({}));
      console.log(`  ♪ LIKE  ${comment.author} (${r.likes ?? 0})`);
      await audit({ stage: "music_like", comment });
      return;
    }
    if (hasHeart(comment.text)) music.like(comment.author).catch(() => {}); // side-effect, fall through
  }

  // Vote ballots ("!theme:x") are CONSUMED here — they drive a vote round and
  // are never shown as a message or sent to the director.
  if (config.votes) {
    const voted = votes.handle(comment);
    if (voted) {
      console.log(`  ⚑ VOTE  ${comment.author} → ${voted}`);
      await audit({ stage: "vote", comment, theme: voted });
      return;
    }
  }

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

  // Stream-like milestones: poll the YouTube video's like count and celebrate
  // milestones (youtube source only — the simulator has no real likes)
  const streamLikes = (config.source === "youtube" && config.streamLikes)
    ? createStreamLikes({ postMutate, log: console.log }) : null;
  if (streamLikes) streamLikes.start();

  process.on("SIGINT", () => {
    if (moodEngine) moodEngine.stop();
    if (streamLikes) streamLikes.stop();
    votes.stop();
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
