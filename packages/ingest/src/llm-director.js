// Phase 2: Claude composes the scene directive.
//
// Instead of keyword rules, we hand the model the SceneAPI action schema and a
// single moderated comment, and ask it to choose the best action + params — or
// "ignore". The model's output is NEVER trusted blindly: validateDirective()
// re-checks it against the same allowlist the rules director uses, so a
// hallucinated action or out-of-range param can't reach the scene.
//
// This is the jump from "keywords trigger preset effects" to "chat describes
// what it wants and the model picks the right directive."

import { config } from "./config.js";

export const THEMES = [
  "synthwave", "sunrise", "mono", "forest", "aurora", "ember",
  "midnight", "vapor", "matrix", "gold", "crimson",
  "neon", "dusk", "ocean", "lava", "frost", "glitch", "retro", "void", "plasma", "noir", "solar", "holo",
];
export const EFFECTS = [
  "particles", "rays", "scanlines", "grain", "vignette", "bokeh", "bars", "fog", "sweep",
  "grid", "chroma", "holoscan", "dust", "datarain", "sparks", "lightning", "filmburn", "ripple",
];
const ACTIONS = [
  "setTheme", "transitionTheme", "setHeadline", "setKicker", "setSubhead", "setHeadlineGradient",
  "addShoutout", "burst", "setEffect", "setTicker", "renderWarning", "mutateElement", "ignore",
];

// Tier 1 element mutation: ids + clamps mirror the scene's registry (scene.js
// MUTABLES/TWEEN_CLAMPS — the scene re-clamps everything, this is defense in depth)
const MUTABLE_IDS = ["headline", "kicker", "subhead"];
const TWEEN_LIMITS = { x: [-200, 200], y: [-120, 120], scale: [0.5, 2], rotation: [-25, 25], opacity: [0.15, 1], duration: [0.2, 4], repeat: [0, 3] };
const TWEEN_EASES = ["power2.out", "power2.inOut", "sine.inOut", "back.out", "elastic.out"];

// The action schema, described once. Cached on the API side (see system block).
const SYSTEM = `You are the live "director" of an interactive YouTube stream. Each viewer
comment (already moderated as safe) may steer an on-screen HTML scene. Choose the
SINGLE best action for the comment, or "ignore" if it doesn't clearly ask for a
visual change.

Return ONLY compact JSON: {"action": "...", "params": {...}, "why": "<=8 words"}.

Available actions and params:
- transitionTheme { "theme": <one of THEMES>, "duration"?: 0.3-4 }        // smooth crossfade to a vibe/mood (PREFERRED for theme changes)
- setTheme        { "theme": <one of THEMES> }                            // alias; also crossfades
- setHeadline     { "text": "<=80 chars" }                                // viewer proposes the big on-screen title
- setSubhead      { "text": "<=140 chars" }                               // a smaller supporting line
- addShoutout     { "who": "<author>", "text": "<=120 chars", "tier": "small"|"medium"|"large" }  // greet/echo a viewer
- burst           { "intensity": 0.0-1.0 }                                // a quick light flash + shockwave for hype moments
- setEffect       { "effect": <one of EFFECTS>, "on": true|false }        // toggle an ambient effect
- setTicker       { "items": ["<=60 chars", ...up to 8] }                 // rewrite the scrolling bottom ticker
- mutateElement   { "id": "headline"|"kicker"|"subhead", "ops": [ up to 4 of:
                    {"op":"setText","text":"..."} |
                    {"op":"tween","x":-200..200,"y":-120..120,"scale":0.5..2,"rotation":-25..25,"opacity":0.15..1,"duration":0.2..4,"repeat":0..3,"yoyo":true,"ease":"power2.out"|"power2.inOut"|"sine.inOut"|"back.out"|"elastic.out"} |
                    {"op":"reset"} ] }                                    // fine-grained: move/spin/scale/fade a SPECIFIC on-stage element ("tilt the headline", "shrink the kicker", "wiggle it") — use reset to put it back
- ignore          {}                                                      // off-topic, unclear, or low-value

THEMES: synthwave sunrise mono forest aurora ember midnight vapor matrix gold crimson neon dusk ocean lava frost glitch retro void plasma noir solar holo
EFFECTS: particles rays scanlines grain vignette bokeh bars fog sweep grid chroma holoscan dust datarain sparks lightning filmburn ripple

Guidance:
- Map mood words to the closest theme: neon/cyberpunk→neon, twilight/sunset→dusk, underwater→ocean, volcanic/molten→lava, icy→frost, corrupted/vhs→glitch, 80s/crt→retro, deep space→void, electric→plasma, cinematic b&w→noir, overexposed/bright→solar, holographic→holo (plus the earlier ones).
- Effect words: stars/snow→particles, beams→rays, orbs→bokeh, equalizer→bars, mist→fog, spotlight→sweep, perspective grid→grid, dust→dust, falling code/matrix rain→datarain, sparks→sparks, lightning→lightning, light leak/film burn→filmburn, ripple→ripple, scan line→holoscan, aberration→chroma. "turn off X"→on:false.
- "set the ticker to ..." / a list of phrases → setTicker.
- Paid comments (marked SUPERCHAT) deserve a shoutout; bigger amount → higher tier.
- Keep text faithful to the viewer's intent; do not invent unsafe or promotional content.
- Prefer "ignore" over forcing a weak action on chit-chat.`;

function clampText(s, max) {
  return String(s ?? "").replace(/[\x00-\x1f<>]/g, " ").slice(0, max).trim();
}

/** Re-validate + coerce a model-proposed directive against the allowlist. */
export function validateDirective(d) {
  if (!d || typeof d !== "object") return null;
  const action = String(d.action || "");
  if (!ACTIONS.includes(action) || action === "ignore") return null;
  const p = d.params && typeof d.params === "object" ? d.params : {};

  switch (action) {
    case "setTheme":
      return THEMES.includes(p.theme) ? { action, params: { theme: p.theme } } : null;
    case "transitionTheme": {
      if (!THEMES.includes(p.theme)) return null;
      const params = { theme: p.theme };
      const d = Number(p.duration);
      if (Number.isFinite(d)) params.duration = Math.max(0.3, Math.min(4, d));
      return { action, params };
    }
    case "setEffect": {
      if (!EFFECTS.includes(p.effect)) return null;
      const params = { effect: p.effect, on: p.on !== false };
      const d = Number(p.duration);
      if (Number.isFinite(d)) params.duration = Math.max(0.1, Math.min(3, d));
      return { action, params };
    }
    case "setTicker": {
      const items = (Array.isArray(p.items) ? p.items : [])
        .map((s) => clampText(s, 60)).filter(Boolean).slice(0, 8);
      return items.length ? { action, params: { items } } : null;
    }
    case "renderWarning":
      return { action, params: { show: p.show !== false } };
    case "setHeadline": {
      const text = clampText(p.text, 80);
      return text ? { action, params: { text } } : null;
    }
    case "setSubhead": {
      const text = clampText(p.text, 140);
      return text ? { action, params: { text } } : null;
    }
    case "setKicker": {
      const text = clampText(p.text, 40);
      return text ? { action, params: { text } } : null;
    }
    case "setHeadlineGradient": {
      const params = { animate: p.animate !== false };
      const s = Number(p.speed);
      if (Number.isFinite(s)) params.speed = Math.max(2, Math.min(30, s));
      return { action, params };
    }
    case "addShoutout": {
      const tier = ["small", "medium", "large"].includes(p.tier) ? p.tier : "small";
      return { action, params: { who: clampText(p.who, 40) || "viewer", text: clampText(p.text, 120), tier } };
    }
    case "burst": {
      const intensity = Math.max(0, Math.min(1, Number(p.intensity)));
      return Number.isFinite(intensity) ? { action, params: { intensity: intensity || 0.6 } } : null;
    }
    case "mutateElement": {
      const id = String(p.id || "");
      if (!MUTABLE_IDS.includes(id) && !/^hf-[a-z0-9]{4,8}x{0,4}$/.test(id)) return null;
      const ops = (Array.isArray(p.ops) ? p.ops : []).slice(0, 4).map((o) => {
        const kind = String(o?.op || "");
        if (kind === "reset") return { op: "reset" };
        if (kind === "setText") {
          const text = clampText(o.text, 160);
          return text ? { op: "setText", text } : null;
        }
        if (kind === "tween") {
          const t = { op: "tween" };
          for (const [k, [lo, hi]] of Object.entries(TWEEN_LIMITS)) {
            const v = Number(o[k]);
            if (Number.isFinite(v)) t[k] = Math.max(lo, Math.min(hi, v));
          }
          if (TWEEN_EASES.includes(o.ease)) t.ease = o.ease;
          if (o.yoyo !== undefined) t.yoyo = !!o.yoyo;
          return Object.keys(t).length > 1 ? t : null;
        }
        return null;
      }).filter(Boolean);
      return ops.length ? { action, params: { id, ops } } : null;
    }
    default:
      return null;
  }
}

function userContent(comment) {
  const sc = comment.superchat ? ` [SUPERCHAT tier=${comment.superchat.tier || comment.superchat.ytTier || "?"}]` : "";
  return `Author: ${comment.author || "viewer"}${sc}\nComment: ${clampText(comment.text, 200)}`;
}

/**
 * Ask Claude to compose a directive. Returns a validated directive or null
 * (ignore / parse failure / API error — all safe no-ops).
 */
export async function llmIntent(comment) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(8000), // serial pipeline — don't stall on a hung connection
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 120,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent(comment) }],
      }),
    });
    if (!res.ok) {
      console.error(`[llm-director] http ${res.status}`);
      return null;
    }
    const data = await res.json();
    const txt = (data?.content?.[0]?.text || "").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return validateDirective(JSON.parse(m[0]));
  } catch (e) {
    console.error("[llm-director] error:", e.message);
    return null;
  }
}
