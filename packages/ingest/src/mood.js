// The Mood Conductor: a second, periodic, stateful loop that reads the rolling
// aggregate of the WHOLE room (mood-state.js) every few seconds and composes the
// scene's continuous atmosphere — intensity, effect emphasis, a poetic vibe line,
// ambient burst rate. Runs ALONGSIDE the per-comment director (which keeps owning
// momentary reactions). Rules-based by default; optional LLM Conductor when keyed.
//
// Phase A scope: drives intensity + effects + descriptor + burstRate. Theme is
// intentionally left to the per-comment director (the theme-arbitration decision
// is deferred), though setMood already supports it for a later phase.

import { config } from "./config.js";
import { getFeature } from "./features.js";
import { bumpAnthropic } from "./usage.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (a) => a[(Math.random() * a.length) | 0];

// warm, slightly witty, occasionally self-aware — the Mood Conductor has soul
const DESCRIPTORS = {
  dead: ["the room is dreaming", "quiet, for now", "anyone out there?", "soft and still", "stretching, half awake"],
  calm: ["cozy vibes only", "drifting, weightless", "easy like sunday", "settled in nicely", "breathing slow"],
  warm: ["feeling the love in here", "y'all are glowing", "warm and golden", "the room feels close", "soft hearts tonight"],
  hype: ["okay we're vibing", "the crowd is electric", "energy through the roof", "absolutely buzzing", "the room's lit up"],
  tense: ["ooh, getting spicy", "something's brewing", "the air just shifted", "plot-twist energy", "shadows lengthening"],
};
// rare "we did that together" lines on a real energy spike
const CELEBRATIONS = [
  "you all just lit the place up", "the whole room felt that", "look what we made together",
  "that energy? all of you.", "the crowd brought the heat",
];

// derive a structured mood from cheap aggregate signals — no LLM
function rulesMood(snap) {
  const rateEnergy = clamp(snap.rate / 1.5, 0, 1); // ~1.5 msg/s ≈ full
  const scEnergy = clamp(snap.scWeight * 0.05, 0, 0.4);
  const s = snap.sentiment;
  const total = s.hype + s.warm + s.calm + s.tense + 1;
  const hypeF = s.hype / total, warmF = s.warm / total, calmF = s.calm / total, tenseF = s.tense / total;

  const intensity = clamp(0.22 + rateEnergy * 0.6 + scEnergy + hypeF * 0.3 - calmF * 0.22, 0, 1);
  const effects = {
    particles: clamp(0.15 + warmF + rateEnergy * 0.5 - 0.25, -1, 1),
    sparks: clamp(hypeF * 1.6 + scEnergy - 0.35, -1, 1),
    datarain: clamp(tenseF * 1.6 - 0.5, -1, 1),
    bokeh: clamp(calmF * 1.6 + warmF - 0.35, -1, 1),
    fog: clamp(calmF * 1.6 - 0.35, -1, 1),
    lightning: clamp(tenseF * 1.2 + (snap.accel > 1.3 ? 0.4 : 0) - 0.6, -1, 1),
  };
  const burstRate = clamp(hypeF * 0.8 + scEnergy * 1.5 + (snap.accel > 1.4 ? 0.2 : 0), 0, 1);

  let descriptor;
  if (snap.n === 0) descriptor = pick(DESCRIPTORS.dead);
  else {
    const m = Math.max(hypeF, warmF, calmF, tenseF);
    if (m === hypeF && hypeF > 0.1) descriptor = pick(DESCRIPTORS.hype);
    else if (m === tenseF && tenseF > 0.1) descriptor = pick(DESCRIPTORS.tense);
    else if (m === warmF && warmF > 0.1) descriptor = pick(DESCRIPTORS.warm);
    else descriptor = pick(intensity > 0.55 ? DESCRIPTORS.hype : DESCRIPTORS.calm);
  }
  return { intensity, effects, burstRate, descriptor };
}

// clamp/sanitize any mood object — guards the LLM path before it can POST
const EFFECT_KEYS = ["particles", "sparks", "datarain", "bokeh", "fog", "lightning", "rays", "dust"];
const cleanStr = (s, n) => String(s).replace(/[\x00-\x1f<>]/g, " ").slice(0, n).trim();
export function validateMood(m) {
  if (!m || typeof m !== "object") return null;
  let intensity = Number(m.intensity);
  if (!Number.isFinite(intensity)) intensity = 0.4;
  const out = { intensity: clamp(intensity, 0, 1), effects: {} };
  if (m.effects && typeof m.effects === "object") {
    for (const k of EFFECT_KEYS) {
      const v = Number(m.effects[k]);
      if (Number.isFinite(v)) out.effects[k] = clamp(v, -1, 1);
    }
  }
  out.burstRate = Number.isFinite(Number(m.burstRate)) ? clamp(Number(m.burstRate), 0, 1) : 0;
  if (typeof m.descriptor === "string") out.descriptor = cleanStr(m.descriptor, 48);
  if (typeof m.headline === "string" && m.headline.trim()) out.headline = cleanStr(m.headline, 80);
  if (typeof m.subhead === "string" && m.subhead.trim()) out.subhead = cleanStr(m.subhead, 140);
  return out;
}

// optional LLM Mood Conductor (parallels llm-director / moderation fetch + caching)
const MOOD_SYSTEM = `You are the "Mood Conductor" of a live, cinematic, generative video.
Read a compact snapshot of the chat room's COLLECTIVE energy and emit ONLY compact JSON describing the
scene's atmosphere — NOT a reaction to any single comment. The crowd is conducting the visuals together.
Output exactly: {"descriptor":"<=48 chars poetic","intensity":0..1,"effects":{"particles":-1..1,"sparks":-1..1,"datarain":-1..1,"bokeh":-1..1,"fog":-1..1,"lightning":-1..1},"burstRate":0..1}.
Keep it tasteful and drifting — small moves from the current mood. Map hype→sparks+intensity, warm→particles+bokeh, calm→fog+bokeh+low intensity, tense→datarain+lightning.`;

async function llmMood(snap, last) {
  try {
    bumpAnthropic();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(8000), // a hung call would freeze the mood loop
      headers: { "content-type": "application/json", "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: config.anthropicModel, max_tokens: 160,
        system: [{ type: "text", text: MOOD_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content:
          `Room: msgs=${snap.n} rate=${snap.rate.toFixed(2)}/s accel=${snap.accel.toFixed(2)} ` +
          `sentiment(hype/warm/calm/tense)=${snap.sentiment.hype}/${snap.sentiment.warm}/${snap.sentiment.calm}/${snap.sentiment.tense} ` +
          `superchats=${snap.scCount}(w${snap.scWeight}) authors=${snap.uniqueAuthors}. ` +
          `Current: "${last.descriptor || ""}" intensity=${last.intensity.toFixed(2)}.` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const mm = (data?.content?.[0]?.text || "").trim().match(/\{[\s\S]*\}/);
    return mm ? validateMood(JSON.parse(mm[0])) : null;
  } catch { return null; }
}

export function createMoodEngine({ state, postMutate, log = () => {} }) {
  const tickMs = config.moodTickMs;
  const useLLM = config.moodLLM && !!config.anthropicKey;
  let last = { intensity: 0.4, descriptor: "", effects: {}, burstRate: 0 };
  let timer = null, stopping = false, idleTicks = 0, lastCelebrate = 0;

  function effectsChanged(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) if (Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) > 0.1) return true;
    return false;
  }

  async function tick() {
    if (stopping) return;
    const snap = state.snapshot();
    const active = snap.n > 0 || snap.scCount > 0;

    // activity gate: on a dead room, drift to baseline then go quiet (no LLM, no POST)
    if (!active) {
      idleTicks += 1;
      if (idleTicks > 2 && last.intensity <= 0.26) { schedule(); return; }
    } else idleTicks = 0;

    const target = (useLLM && active && (await llmMood(snap, last))) || rulesMood(snap);

    // slew-limit intensity so even a wild target ramps gently
    const ni = clamp(last.intensity + clamp(target.intensity - last.intensity, -0.18, 0.18), 0, 1);
    const mood = { intensity: ni, effects: target.effects || {}, burstRate: target.burstRate ?? 0, descriptor: target.descriptor };

    // rare collective "we did that" celebration on a genuine energy surge
    if (active && snap.accel > 1.6 && snap.rate > 0.5 && Date.now() - lastCelebrate > 60000) {
      lastCelebrate = Date.now();
      mood.subhead = pick(CELEBRATIONS);
    }

    const changed = !!mood.subhead || Math.abs(ni - last.intensity) > 0.015 || mood.descriptor !== last.descriptor ||
      Math.abs((mood.burstRate ?? 0) - (last.burstRate ?? 0)) > 0.1 || effectsChanged(mood.effects, last.effects);
    // the active stage can switch ambient effects off (e.g. a clean video stage)
    if (changed && getFeature("effects")) {
      try {
        await postMutate({ action: "setMood", params: { ...mood, duration: (tickMs / 1000) * 1.5 } });
        log(`[mood] ${mood.descriptor} · intensity ${ni.toFixed(2)} · burst ${(mood.burstRate || 0).toFixed(2)}`);
      } catch { /* degrade gracefully — keep the current mood */ }
    }
    last = mood;
    schedule();
  }

  function schedule() { if (!stopping) timer = setTimeout(tick, tickMs); }

  return {
    start() { console.log(`[mood] Conductor running (${useLLM ? "llm" : "rules"}, tick ${tickMs}ms)`); schedule(); },
    stop() { stopping = true; if (timer) clearTimeout(timer); },
    rulesMood, // exported for unit tests
  };
}
