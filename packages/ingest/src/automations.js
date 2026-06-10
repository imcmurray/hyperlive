// Event → animation bindings ("automations"): the dashboard's AUTOS view
// edits these, the event hooks across the ingest consult/emit them.
//
// Two kinds:
//   builtins — the curated recognitions (superchat, welcome, vote win,
//              milestone), each with an on/off switch and a style choice
//   custom   — operator-added bindings: ON one of the emitted events, fire
//              ONE vetted scene action with operator params; {who} {text}
//              {amount} {theme} {count} placeholders substitute from event
//              data. Not code — the same safe-template rule as everything
//              else (and the scene re-sanitizes every param regardless).
//
// Persisted to state/automations.json (legacy flat format still loads).

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const FILE = process.env.AUTOMATIONS_FILE || "./state/automations.json";

// events the ingest emits (hooks call emitAutomation at these moments)
export const EVENTS = {
  superchat: "a paid message arrived ({who} {text} {amount})",
  first_message: "a chatter spoke for the first time this session ({who})",
  vote_win: "a theme vote round closed ({theme})",
  milestone: "a stream-like milestone was crossed ({count})",
};

// scene actions a CUSTOM automation may fire (a curated subset of the
// streamer's allowlist — params still validated scene-side)
export const CUSTOM_ACTIONS = [
  "burst", "addShoutout", "react", "setHeadline", "setSubhead", "setKicker",
  "setTicker", "setEffect", "transitionTheme", "superchatCard",
];

const BUILTINS = {
  superchat: {
    enabled: true, style: "golden-card",
    styles: ["golden-card", "shoutout", "burst-only"],
    label: "Superchat recognition",
    desc: "every paid message gets an on-stage thank-you, scaled by amount",
  },
  welcome: {
    enabled: true, style: "welcome-pop",
    styles: ["welcome-pop", "sparkle"],
    label: "First-time welcome",
    desc: "greet a chatter the first time they speak this session",
  },
  voteWin: {
    enabled: true, style: "crossfade",
    styles: ["crossfade"],
    label: "Vote winner",
    desc: "crossfade to the winning theme when a vote round closes",
  },
  milestone: {
    enabled: true, style: "celebration",
    styles: ["celebration"],
    label: "Like milestones",
    desc: "celebrate stream-like milestones with a big shoutout + burst",
  },
};

let state = null;  // { builtins: {key: {enabled, style}}, custom: [{id, label, on, action, params, enabled}] }
let poster = null; // postMutate, provided by index.js (avoids a circular import)
let customSeq = 0;

export function setAutomationPoster(fn) { poster = fn; }

function freshBuiltins() {
  return Object.fromEntries(Object.keys(BUILTINS).map((k) => [k, { enabled: BUILTINS[k].enabled, style: BUILTINS[k].style }]));
}
const ensure = () => state || (state = { builtins: freshBuiltins(), custom: [] });

export async function loadAutomations() {
  state = { builtins: freshBuiltins(), custom: [] };
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    const src = j?.builtins || j || {}; // new format or legacy flat map
    for (const [k, v] of Object.entries(src)) {
      if (!state.builtins[k] || !v) continue;
      if (typeof v.enabled === "boolean") state.builtins[k].enabled = v.enabled;
      if (BUILTINS[k].styles.includes(v.style)) state.builtins[k].style = v.style;
    }
    if (Array.isArray(j?.custom)) {
      state.custom = j.custom.filter((c) => c && EVENTS[c.on] && CUSTOM_ACTIONS.includes(c.action));
      customSeq = state.custom.reduce((m, c) => Math.max(m, Number(String(c.id).replace(/\D/g, "")) || 0), 0);
    }
  } catch { /* defaults */ }
  return state;
}

async function persist() {
  try { await saveJson(FILE, state); } catch { /* non-fatal */ }
}

export function automation(key) { return ensure().builtins[key] || { enabled: false, style: "" }; }

export function listAutomations() {
  ensure();
  return {
    builtins: Object.entries(BUILTINS).map(([key, d]) => ({
      key, label: d.label, desc: d.desc, styles: d.styles,
      enabled: state.builtins[key].enabled, style: state.builtins[key].style,
    })),
    custom: [...state.custom],
    events: EVENTS,
    actions: CUSTOM_ACTIONS,
  };
}

export async function setAutomation(key, { enabled, style } = {}) {
  ensure();
  if (!BUILTINS[key]) return { ok: false, error: "unknown automation" };
  if (typeof enabled === "boolean") state.builtins[key].enabled = enabled;
  if (style !== undefined) {
    if (!BUILTINS[key].styles.includes(style)) return { ok: false, error: `style must be one of ${BUILTINS[key].styles.join("|")}` };
    state.builtins[key].style = style;
  }
  await persist();
  return { ok: true, ...state.builtins[key] };
}

// ---- custom automations ------------------------------------------------------
export async function addCustom({ label, on, action, params } = {}) {
  ensure();
  if (!EVENTS[on]) return { ok: false, error: `event must be one of ${Object.keys(EVENTS).join("|")}` };
  if (!CUSTOM_ACTIONS.includes(action)) return { ok: false, error: `action must be one of ${CUSTOM_ACTIONS.join("|")}` };
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return { ok: false, error: "params must be a JSON object" };
  }
  if (JSON.stringify(params || {}).length > 2048) return { ok: false, error: "params too large" };
  if (state.custom.length >= 24) return { ok: false, error: "too many custom automations (24 max)" };
  const entry = {
    id: `c${++customSeq}`,
    label: String(label || `${on} → ${action}`).slice(0, 60),
    on, action, params: params || {}, enabled: true,
  };
  state.custom.push(entry);
  await persist();
  return { ok: true, automation: entry };
}

export async function updateCustom(id, { enabled, remove } = {}) {
  ensure();
  const i = state.custom.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: "unknown custom automation" };
  if (remove) state.custom.splice(i, 1);
  else if (typeof enabled === "boolean") state.custom[i].enabled = enabled;
  await persist();
  return { ok: true };
}

// substitute {who} {text} {amount} {theme} {count} in param strings (one level
// deep + arrays); the scene clean()s everything again on arrival
function substitute(params, data) {
  const sub = (s) => String(s).replace(/\{(who|text|amount|theme|count)\}/g, (_, k) => String(data[k] ?? ""));
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") out[k] = sub(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? sub(x) : x));
    else out[k] = v;
  }
  return out;
}

// hooks call this at event moments; every enabled custom automation on that
// event fires its action (builtins are handled at their call sites)
export function emitAutomation(event, data = {}) {
  ensure();
  if (!poster) return;
  for (const c of state.custom) {
    if (!c.enabled || c.on !== event) continue;
    poster({ action: c.action, params: substitute(c.params, data) })
      .catch(() => { /* scene rejected or down — non-fatal */ });
  }
}

// ---- previews: fire an automation on the stage with sample data ----
export const SAMPLE_DATA = { who: "@preview", text: "this is what it looks like ✨", amount: "$20.00", theme: "neon", count: "1,000" };

export function superchatDirective(style, { who, text, amount, tier }) {
  if (style === "shoutout") return { action: "addShoutout", params: { who, text, tier } };
  if (style === "burst-only") return { action: "burst", params: { intensity: tier === "large" ? 0.8 : 0.5 } };
  return { action: "superchatCard", params: { who, text, amount, tier } };
}

// builds the directive(s) a preview should fire — the ADMIN decides where they
// go (the off-air scene twin by default, the live stage only if asked)
export function buildPreviewDirectives({ key, id } = {}) {
  ensure();
  if (id) {
    const c = state.custom.find((x) => x.id === id);
    if (!c) return { ok: false, error: "unknown custom automation" };
    return { ok: true, directives: [{ action: c.action, params: substitute(c.params, SAMPLE_DATA) }] };
  }
  if (key === "superchat") {
    return { ok: true, directives: [superchatDirective(automation("superchat").style, { who: SAMPLE_DATA.who, text: SAMPLE_DATA.text, amount: SAMPLE_DATA.amount, tier: "large" })] };
  }
  if (key === "welcome") {
    return { ok: true, directives: [{ action: "react", params: { kind: automation("welcome").style === "sparkle" ? "sparkle" : "welcome", who: SAMPLE_DATA.who } }] };
  }
  if (key === "voteWin") {
    const themes = ["neon", "ocean", "aurora", "ember", "vapor", "frost"];
    return { ok: true, directives: [{ action: "transitionTheme", params: { theme: themes[(Math.random() * themes.length) | 0], duration: 2 } }] };
  }
  if (key === "milestone") {
    return { ok: true, directives: [
      { action: "addShoutout", params: { tier: "large", who: "STREAM ❤", text: `${SAMPLE_DATA.count} likes — thank you! 🎉` } },
      { action: "burst", params: { intensity: 0.7 } },
    ] };
  }
  return { ok: false, error: "unknown automation" };
}
