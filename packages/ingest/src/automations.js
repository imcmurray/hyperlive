// Event → animation bindings ("automations"): the dashboard's AUTOMATIONS view
// edits these, the event hooks across the ingest consult them. Each automation
// is a built-in event with an on/off switch and a choice of pre-built scene
// animation — NOT free-form code (same safe-template rule as everything else:
// the configurable surface is which vetted action fires, never what it is).
//
// Persisted to state/automations.json so show configuration survives restarts.

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const FILE = process.env.AUTOMATIONS_FILE || "./state/automations.json";

// key → { enabled, style, styles: [allowed styles], label, desc }
const DEFAULTS = {
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

let state = null; // key → { enabled, style }

export async function loadAutomations() {
  state = {};
  for (const k of Object.keys(DEFAULTS)) state[k] = { enabled: DEFAULTS[k].enabled, style: DEFAULTS[k].style };
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    for (const [k, v] of Object.entries(j || {})) {
      if (!state[k] || !v) continue;
      if (typeof v.enabled === "boolean") state[k].enabled = v.enabled;
      if (DEFAULTS[k].styles.includes(v.style)) state[k].style = v.style;
    }
  } catch { /* defaults */ }
  return state;
}

const ensure = () => state || (state = Object.fromEntries(
  Object.keys(DEFAULTS).map((k) => [k, { enabled: DEFAULTS[k].enabled, style: DEFAULTS[k].style }])));

export function automation(key) { return ensure()[key] || { enabled: false, style: "" }; }

export function listAutomations() {
  ensure();
  return Object.entries(DEFAULTS).map(([key, d]) => ({
    key, label: d.label, desc: d.desc, styles: d.styles,
    enabled: state[key].enabled, style: state[key].style,
  }));
}

export async function setAutomation(key, { enabled, style } = {}) {
  ensure();
  if (!DEFAULTS[key]) return { ok: false, error: "unknown automation" };
  if (typeof enabled === "boolean") state[key].enabled = enabled;
  if (style !== undefined) {
    if (!DEFAULTS[key].styles.includes(style)) return { ok: false, error: `style must be one of ${DEFAULTS[key].styles.join("|")}` };
    state[key].style = style;
  }
  try { await saveJson(FILE, state); } catch { /* non-fatal */ }
  return { ok: true, ...state[key] };
}
