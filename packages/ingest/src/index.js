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
import { authorCard, parseCardCommand } from "./card-author.js";
import { isBanned, isMuted, loadBans } from "./bans.js";
import { automation, loadAutomations, setAutomationPoster, emitAutomation, superchatDirective } from "./automations.js";
import { loadStages, listStages, getStage, featuresOf } from "./stages.js";
import { getFeature, setActiveFeatures } from "./features.js";
import { startAdmin, publishFeed, enqueuePending, previewMarkup, setVitalsProvider, setReplayHandler } from "./admin.js";
import { unitsSpent } from "./quota.js";
import { simulatorSource, liveSimulatorSource } from "./simulator.js";
import { youtubeSource } from "./youtube.js";
import { createStreamLikes } from "./stream-likes.js";

const moderator = createModerator();
const director = createDirector();
const moodState = createMoodState({ windowMs: config.moodWindowMs });
const reactions = createReactions({ postMutate, log: console.log, welcome: () => automation("welcome") });
const votes = createVotes({ postMutate, log: console.log });
const music = createMusic({ baseUrl: config.musicUrl });

let processed = 0;
let applied = 0;
let blocked = 0;

async function audit(entry) {
  // the dashboard's live feed rides the same call (in-process bus); the file
  // is durable history, the bus is the moderator's live view
  if (config.dashboard) publishFeed(entry);
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
    signal: AbortSignal.timeout(5000), // local control plane — fail fast, don't stall the pipeline
    headers: { "content-type": "application/json" },
    body: JSON.stringify(directive),
  });
  if (!res.ok) throw new Error(`mutate http ${res.status}`);
  return res.json();
}

// superchat → recognition tier: explicit tier strings (simulator) or
// amount/ytTier (real YouTube)
function superchatTier(sc) {
  if (sc.tier === "large" || sc.tier === "medium") return sc.tier;
  const amt = parseFloat(String(sc.amount || "").replace(/[^0-9.]/g, "")) || 0;
  const yt = Number(sc.ytTier) || 0;
  if (amt >= 20 || yt >= 5) return "large";
  if (amt >= 5 || yt >= 3) return "medium";
  return "small";
}

// throttled "typed → on-scene" latency readout (excludes YouTube's broadcast buffer)
let lastDelayAt = 0;
// one viewer card at a time, with a global cooldown (the slot shows one card)
let lastCardAt = 0;
function reportDelay(comment) {
  if (!config.showDelay || !comment.ts) return;
  const now = Date.now();
  if (now - lastDelayAt < 900) return; // it's a readout, not every event
  lastDelayAt = now;
  postMutate({ action: "setDelay", params: { ms: Math.max(0, now - comment.ts) } }).catch(() => {});
}

async function handle(comment) {
  processed += 1;

  // banned viewers are dropped before ANY processing — they can't influence
  // the stage at all (local-only "kick"; we never touch YouTube's chat)
  if (isBanned(comment)) {
    blocked += 1;
    await audit({ stage: "banned", comment: { author: comment.author, channelId: comment.channelId, text: comment.text } });
    return;
  }
  // muted viewers stay VISIBLE to the moderator (feed shows the message) but
  // nothing they say can trigger directives, cards, music, or votes
  if (isMuted(comment)) {
    await audit({ stage: "muted", comment: { author: comment.author, channelId: comment.channelId, text: comment.text } });
    return;
  }

  const mod = await moderator.moderate(comment);
  if (!mod.allowed) {
    blocked += 1;
    console.log(`  ✗ BLOCK [${mod.reason}] ${comment.author}: ${comment.text}`);
    await audit({ stage: "blocked", comment, reason: mod.reason });
    return;
  }

  // feed the Collective Mood Engine (only moderated comments reach the aggregate)
  moodState.record(comment);

  // Superchat recognition (an automation): fired DETERMINISTICALLY before the
  // director — a paid message must never go unacknowledged. Style is
  // dashboard-configurable: golden card / classic shoutout / burst only.
  let scRecognized = false;
  if (comment.superchat) {
    const auto = automation("superchat");
    const tier = superchatTier(comment.superchat);
    if (auto.enabled && getFeature("superchats")) {
      scRecognized = true;
      const directive = superchatDirective(auto.style, { who: comment.author, text: comment.text, amount: comment.superchat.amount || "", tier });
      if (directive.action === "superchatCard" || directive.action === "addShoutout") directive.params.avatar = comment.avatar || "";
      await postMutate(directive).catch(() => {});
      reportDelay(comment);
      console.log(`  ★ SUPERCHAT ${comment.author} ${comment.superchat.amount || ""} (${tier}, ${auto.style})`);
      await audit({ stage: "superchat", comment, tier, style: auto.style });
    }
    // custom automations on this event fire regardless of the builtin
    emitAutomation("superchat", { who: comment.author, text: comment.text, amount: comment.superchat.amount || "" });
  }

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

  // Tier 2 viewer cards: "!card <description>" is CONSUMED — Claude authors a
  // small HTML card, the streamer pre-renders + vision-gates it, and only then
  // does it reach the sandboxed on-stage slot (platform-directions §7).
  if (config.cards) {
    const want = parseCardCommand(comment.text);
    if (want) {
      const now = Date.now();
      if (now - lastCardAt < config.cardCooldownMs) {
        console.log(`  ▦ card  (cooldown ${Math.ceil((config.cardCooldownMs - (now - lastCardAt)) / 1000)}s) ${comment.author}`);
        await audit({ stage: "card_cooldown", comment });
        return;
      }
      lastCardAt = now;
      console.log(`  ▦ card  ${comment.author} → "${want}" (authoring…)`);
      const html = await authorCard(want, comment.author);
      // HOLD mode: park it (with its off-air screenshot) for a moderator
      // instead of airing on vision-pass — the dashboard approves/rejects
      if (html && config.holdCards) {
        const pv = await previewMarkup("card", html, comment.author).catch((e) => ({ ok: false, error: e.message }));
        if (pv.ok) {
          enqueuePending({ kind: "card", who: comment.author, request: want, html, screenshot: pv.screenshot, vision: pv.vision });
          console.log(`  ▦ card  HELD for review ← ${comment.author}`);
          await audit({ stage: "card_held", comment, request: want });
        } else {
          console.log(`  ▦ card  rejected at preview [${pv.error || "?"}]`);
          await audit({ stage: "card", comment, request: want, ok: false, error: pv.error });
        }
        return;
      }
      let result = { ok: false, error: "authoring failed" };
      if (html) {
        try {
          const res = await fetch(config.cardUrl, {
            method: "POST",
            signal: AbortSignal.timeout(30000), // preview render + vision check take a while
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ html, who: comment.author, source: "viewer" }),
          });
          result = await res.json().catch(() => ({ ok: res.ok }));
        } catch (e) { result = { ok: false, error: e.message }; }
      }
      console.log(result.ok ? `  ▦ card  LIVE ← ${comment.author}` : `  ▦ card  rejected [${result.error || "?"}]`);
      await audit({ stage: "card", comment, request: want, ok: !!result.ok, error: result.error });
      return;
    }
  }

  // Vote ballots ("!theme:x") are CONSUMED here — they drive a vote round and
  // are never shown as a message or sent to the director.
  if (config.votes && getFeature("votes")) {
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

  // The main director turns a chat comment into a vetted scene directive — the
  // shoutout cards + chat-driven scene moves. A stage can switch this off so
  // regular chat doesn't steer the scene (superchats are recognized separately
  // and stay on their own toggle).
  if (!getFeature("directives")) {
    if (fired.length) reportDelay(comment); // a reaction may still have landed
    await audit({ stage: "skipped", comment, reason: "chat→scene off (stage)" });
    return;
  }

  const dec = await director.decide(comment);
  // a superchat already got its recognition card — don't double-shoutout
  if (!dec.skip && dec.directive.action === "addShoutout" && scRecognized) {
    await audit({ stage: "skipped", comment, reason: "superchat already recognized" });
    return;
  }
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
  await loadAutomations();
  setAutomationPoster(postMutate); // custom automations + previews fire through the normal bus
  await loadStages();
  // apply the persisted active stage's interactive features (votes/effects/…)
  setActiveFeatures(featuresOf(getStage(listStages().active)));
  const banCount = await loadBans();
  if (banCount) console.log(`[ingest] ban list: ${banCount} entr${banCount === 1 ? "y" : "ies"}`);
  setVitalsProvider(() => ({
    processed, applied, blocked,
    quotaUnits: unitsSpent(),
    quotaLimit: config.yt.quotaLimit,
    source: config.source,
  }));
  // dashboard replay: mod overrides a cooldown skip — intent re-runs and the
  // result lands in the feed through the normal audit path
  setReplayHandler(async (comment) => {
    const dec = await director.decide(comment, Date.now(), { ignoreCooldown: true });
    if (dec.skip) return { ok: false, error: dec.skip };
    if (dec.directive.action === "addShoutout" && comment.avatar) dec.directive.params.avatar = comment.avatar;
    try {
      const out = await postMutate(dec.directive);
      applied += 1;
      console.log(`  ✓ APPLY ${dec.directive.action} (mod replay) ← ${comment.author}`);
      await audit({ stage: "applied", comment, directive: dec.directive, out, replay: true });
      return { ok: true, action: dec.directive.action };
    } catch (e) {
      await audit({ stage: "error", comment, directive: dec.directive, error: e.message });
      return { ok: false, error: e.message };
    }
  });
  const admin = config.dashboard ? startAdmin({ log: console.log }) : null;
  if (config.holdCards) console.log("[ingest] HOLD_CARDS=on — viewer cards queue for moderator approval");
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

  const shutdown = (label) => {
    if (moodEngine) moodEngine.stop();
    if (streamLikes) streamLikes.stop();
    votes.stop();
    if (admin) admin.close();
    console.log(`\n[ingest] ${label}. processed=${processed} applied=${applied} blocked=${blocked}`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("stopping"));
  process.on("SIGTERM", () => shutdown("stopping")); // live.sh stop sends SIGTERM

  for await (const comment of source) {
    await handle(comment);
    if (config.maxEvents && processed >= config.maxEvents) break;
  }

  // the source ended (demo maxEvents or simulator drained) — stop the timers
  // too, or the process lingers as a zombie that looks alive to live.sh status
  shutdown("done");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
