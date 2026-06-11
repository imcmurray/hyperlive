// "Stages": named presets for what's on the MAIN VIDEO — the native HyperLive
// scene, or an external source (a YouTube video, a direct video/HLS URL, an
// image) — plus an optional theme. The dashboard's STAGES view edits these;
// applying one live-switches the broadcast mid-show.
//
// A stage is just data. Applying it = a setStageSource directive (+ an optional
// transitionTheme), both already vetted/clamped scene actions — the same
// safe-template rule as everything else. Operator-only: stages are never
// reachable from chat.
//
// Persisted to state/stages.json (custom stages + the active id).

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const FILE = process.env.STAGES_FILE || "./state/stages.json";

export const STAGE_KINDS = ["scene", "youtube", "video", "image"];
const MAX_CUSTOM = 24;

// always-present builtins. "scene" clears any source → the native generative
// stage. Two themed scene presets so the view is useful out of the box.
const BUILTINS = [
  { id: "scene", label: "HyperLive Scene", kind: "scene", desc: "the native generative scene (no external source)" },
  { id: "scene-ocean", label: "Scene · Ocean", kind: "scene", theme: "ocean", desc: "native scene, ocean theme" },
  { id: "scene-synthwave", label: "Scene · Synthwave", kind: "scene", theme: "synthwave", desc: "native scene, synthwave theme" },
];

let state = null; // { custom: [stage], active: id }
let seq = 0;

const ensure = () => state || (state = { custom: [], active: "scene" });
const ytId = (s) => {
  const raw = String(s || "");
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const m = raw.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
};
const httpUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null; } catch { return null; } };

// validate + normalize an incoming stage definition (operator input)
function normalize({ label, kind, source, url, id, muted, theme } = {}) {
  kind = String(kind || "").toLowerCase();
  if (!STAGE_KINDS.includes(kind)) return { error: `kind must be ${STAGE_KINDS.join("|")}` };
  const out = { kind, label: String(label || "").slice(0, 60) };
  if (theme) out.theme = String(theme).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  if (kind === "youtube") {
    // NB: videoId (the 11-char YouTube id), NOT id — id is the stage's own
    // unique key, assigned by addStage; conflating them clobbers one.
    const vid = ytId(source || id || url);
    if (!vid) return { error: "youtube needs a video id or url" };
    out.videoId = vid;
    out.muted = muted === true; // default to SOUND ON for a video stage
  } else if (kind === "video" || kind === "image") {
    const u = httpUrl(source || url);
    if (!u) return { error: `${kind} needs an http(s) url` };
    out.url = u;
    if (kind === "video") out.muted = muted === true;
  }
  if (!out.label) out.label = kind === "scene" ? "Scene" : `${kind}: ${(out.videoId || out.url || "").slice(0, 28)}`;
  return { stage: out };
}

export async function loadStages() {
  state = { custom: [], active: "scene" };
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    if (Array.isArray(j?.custom)) {
      state.custom = j.custom
        .map((c) => { const n = normalize(c); return n.stage ? { ...n.stage, id: c.id } : null; })
        .filter(Boolean);
      seq = state.custom.reduce((m, c) => Math.max(m, Number(String(c.id).replace(/\D/g, "")) || 0), 0);
    }
    if (typeof j?.active === "string") state.active = j.active;
  } catch { /* defaults */ }
  return state;
}

async function persist() { try { await saveJson(FILE, state); } catch { /* non-fatal */ } }

export function listStages() {
  ensure();
  return {
    builtins: BUILTINS.map((b) => ({ ...b, builtin: true })),
    custom: state.custom.map((c) => ({ ...c, builtin: false })),
    active: state.active,
    kinds: STAGE_KINDS,
  };
}

export function getStage(id) {
  ensure();
  return BUILTINS.find((b) => b.id === id) || state.custom.find((c) => c.id === id) || null;
}

export async function addStage(def = {}) {
  ensure();
  const n = normalize(def);
  if (n.error) return { ok: false, error: n.error };
  if (state.custom.length >= MAX_CUSTOM) return { ok: false, error: `too many stages (${MAX_CUSTOM} max)` };
  const stage = { ...n.stage, id: `s${++seq}` };
  state.custom.push(stage);
  await persist();
  return { ok: true, stage };
}

export async function removeStage(id) {
  ensure();
  const i = state.custom.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: "unknown stage (builtins can't be removed)" };
  state.custom.splice(i, 1);
  if (state.active === id) state.active = "scene";
  await persist();
  return { ok: true };
}

export async function setActive(id) { ensure(); state.active = id; await persist(); }

// the directives that apply a stage live: clear/set the source, then (if the
// stage names a theme) crossfade to it. Both are vetted, clamped scene actions.
export function buildApplyDirectives(stage) {
  const d = [];
  if (stage.kind === "scene") d.push({ action: "setStageSource", params: { kind: "none" } });
  else if (stage.kind === "youtube") d.push({ action: "setStageSource", params: { kind: "youtube", id: stage.videoId, muted: !!stage.muted } });
  else if (stage.kind === "video") d.push({ action: "setStageSource", params: { kind: "video", url: stage.url, muted: !!stage.muted } });
  else if (stage.kind === "image") d.push({ action: "setStageSource", params: { kind: "image", url: stage.url } });
  if (stage.theme) d.push({ action: "transitionTheme", params: { theme: stage.theme, duration: 1.2 } });
  return d;
}
