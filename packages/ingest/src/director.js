// The Director maps an APPROVED comment to a validated SceneAPI directive,
// and arbitrates so chat can't thrash the scene (cooldowns + fairness).
//
// Phase 1 keeps this rule-based and deterministic. Phase 2 swaps the intent()
// function for a Claude call that emits the same {action, params} shape — the
// allowlist + cooldown machinery around it stays identical.

import { config } from "./config.js";
import { llmIntent } from "./llm-director.js";

const THEMES = [
  "synthwave", "sunrise", "mono", "forest", "aurora", "ember",
  "midnight", "vapor", "matrix", "gold", "crimson",
  "neon", "dusk", "ocean", "lava", "frost", "glitch", "retro", "void", "plasma", "noir", "solar", "holo",
];
const THEME_ALIASES = {
  cyberpunk: "neon", dawn: "dusk", sunset: "dusk", twilight: "dusk",
  grey: "mono", gray: "mono", nature: "forest",
  northern: "aurora", coal: "ember", warm: "ember",
  night: "midnight", vaporwave: "vapor", pastel: "vapor", miami: "vapor",
  terminal: "matrix", hacker: "matrix", code: "matrix", royal: "gold", luxury: "gold",
  red: "crimson", blood: "crimson", underwater: "ocean", sea: "ocean",
  molten: "lava", volcano: "lava", ice: "frost", icy: "frost", cold: "frost",
  corrupted: "glitch", vhs: "glitch", "80s": "retro", space: "void", stars: "void",
  electric: "plasma", energy: "plasma", noire: "noir", bright: "solar", sun: "solar",
  holographic: "holo", hologram: "holo",
};

// effect keyword → canonical effect name
const EFFECT_WORDS = {
  particles: "particles", snow: "particles", motes: "particles",
  rays: "rays", beams: "rays",
  scanlines: "scanlines",
  grain: "grain",
  vignette: "vignette",
  bokeh: "bokeh", orbs: "bokeh",
  bars: "bars", equalizer: "bars", eq: "bars",
  fog: "fog", mist: "fog", haze: "fog",
  sweep: "sweep", spotlight: "sweep", lighthouse: "sweep",
  grid: "grid", perspective: "grid",
  chroma: "chroma", aberration: "chroma",
  holoscan: "holoscan", scanline: "holoscan",
  dust: "dust",
  datarain: "datarain", rain: "datarain",
  sparks: "sparks", spark: "sparks",
  lightning: "lightning", bolt: "lightning",
  filmburn: "filmburn", burn: "filmburn", leak: "filmburn",
  ripple: "ripple", wave: "ripple",
};

const HEAVY = new Set(["setTheme", "transitionTheme", "setHeadline", "setSubhead"]);

// Map a YouTube Super Chat tier (1–5) or simulator tier to our 3 visual tiers.
function scTier(sc) {
  if (!sc) return null;
  if (sc.tier) return ["small", "medium", "large"].includes(sc.tier) ? sc.tier : "medium";
  const t = Number(sc.ytTier || 1);
  return t >= 4 ? "large" : t >= 2 ? "medium" : "small";
}

function parseIntent(comment) {
  const text = String(comment.text || "").trim();
  const lower = text.toLowerCase();

  // 1) Super Chat → escalate by tier (the headline payment feature)
  const tier = scTier(comment.superchat);
  if (tier) {
    return {
      action: "addShoutout",
      params: { who: comment.author || "supporter", text: text || "thanks for the support!", tier },
    };
  }

  // NOTE: the director no longer changes themes directly. Theme changes go ONLY
  // through the vote system (!theme/!vote + hotwords) or the mood engine's eased
  // drift — so a comment that merely mentions a theme word (e.g. "solar") can't
  // instantly swap the theme out from under an open vote.

  // 3) "headline: ..." → big headline
  let m = text.match(/^headline[:\s]+(.+)/i);
  if (m) return { action: "setHeadline", params: { text: m[1] } };

  // 3a) "ticker: a, b, c" → rewrite the scrolling ticker
  m = text.match(/^ticker[:\s]+(.+)/i);
  if (m) {
    const items = m[1].split(/[,|]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (items.length) return { action: "setTicker", params: { items } };
  }

  // 3b) effect toggles ("add particles", "turn off rays", "crt on")
  for (const [word, effect] of Object.entries(EFFECT_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      const on = !/\b(off|no|stop|disable|remove|hide|without)\b/.test(lower);
      return { action: "setEffect", params: { effect, on } };
    }
  }

  // 4) hype words → flash
  if (/\b(gg|lets?\s*go|hype|fire|🔥|let'?s gooo+)\b/i.test(lower)) {
    return { action: "burst", params: { intensity: 0.7 } };
  }

  // 5) anything else → a small shoutout card echoing the comment
  return { action: "addShoutout", params: { who: comment.author || "viewer", text, tier: "small" } };
}

export function createDirector() {
  let lastAnyAt = 0;
  const lastActionAt = new Map();

  // pick the intent engine; "llm" falls back to "rules" without a key
  const useLLM = config.director === "llm" && !!config.anthropicKey;
  if (config.director === "llm" && !config.anthropicKey) {
    console.warn("[director] DIRECTOR=llm but no ANTHROPIC_API_KEY — falling back to rules");
  }
  const computeIntent = useLLM ? llmIntent : (c) => parseIntent(c);

  return {
    engine: useLLM ? "llm" : "rules",
    /**
     * @returns {Promise<{directive:object}|{skip:string}>}
     */
    async decide(comment, now = Date.now()) {
      // global cooldown FIRST (cheap) — so we never spend an LLM call on a
      // comment that would be dropped for thrashing anyway
      if (now - lastAnyAt < config.globalCooldownMs) return { skip: "global cooldown" };

      const directive = await computeIntent(comment);
      if (!directive) return { skip: "no intent" };

      // heavier actions get a longer dedicated cooldown
      if (HEAVY.has(directive.action)) {
        const last = lastActionAt.get(directive.action) || 0;
        if (now - last < config.heavyCooldownMs) return { skip: `${directive.action} cooldown` };
      }

      lastAnyAt = now;
      lastActionAt.set(directive.action, now);
      return { directive };
    },
  };
}
