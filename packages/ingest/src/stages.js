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
import { FEATURE_KEYS, FEATURE_LABELS, normalizeFeatures } from "./features.js";

const FILE = process.env.STAGES_FILE || "./state/stages.json";

export const STAGE_KINDS = ["scene", "youtube", "video", "image"];
// how the overlay title block (#content) enters when a stage goes live. "hide"
// flies it out for a clean stage; "default"/"" defers to the global setting.
export const TITLE_ANIMS = ["slideL", "slideR", "slideU", "slideD", "fade", "none", "hide"];
const MAX_CUSTOM = 24;

// always-present builtins. "scene" clears any source → the native generative
// stage. Two themed scene presets so the view is useful out of the box.
const BUILTINS = [
  { id: "scene", label: "HyperLive Scene", kind: "scene", desc: "the native generative scene (no external source)" },
  { id: "scene-ocean", label: "Scene · Ocean", kind: "scene", theme: "ocean", desc: "native scene, ocean theme" },
  { id: "scene-synthwave", label: "Scene · Synthwave", kind: "scene", theme: "synthwave", desc: "native scene, synthwave theme" },
  // video examples — public test streams that play with sound (AUDIO_MODE=source).
  // Two HLS (via hls.js) + one direct MP4, so the video path is demonstrable out
  // of the box. Stable, widely-used reference URLs.
  { id: "ex-bbb-hls", label: "Big Buck Bunny · HLS", kind: "video", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", desc: "HLS test stream (hls.js) — plays with audio" },
  { id: "ex-bipbop", label: "Apple BipBop · HLS", kind: "video", url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8", desc: "Apple's reference HLS stream" },
  { id: "ex-bbb-mp4", label: "Big Buck Bunny · MP4", kind: "video", url: "https://www.w3schools.com/html/mov_bbb.mp4", desc: "direct progressive MP4 — plays with audio" },
  // YouTube examples (resolved via yt-dlp → played with audio under
  // AUDIO_MODE=source). One durable VOD + one live cam (the co-watch use case;
  // a live stream may rotate, then it degrades to a muted embed).
  { id: "ex-yt-zoo", label: "YouTube · Me at the Zoo", kind: "youtube", videoId: "jNQXAC9IVRw", desc: "the first YouTube video — a durable VOD example" },
  { id: "ex-yt-nature", label: "YouTube · Nature Live Cam", kind: "youtube", videoId: "DGIXT7ce3vQ", desc: "a live nature stream — the live-event co-watch use case" },
  // image backdrops (load straight in the browser; no audio)
  { id: "ex-img-forest", label: "Image · Mountain Forest", kind: "image", url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1280&q=80", desc: "a static image backdrop (Unsplash)" },
  { id: "ex-img-backdrop", label: "Image · Random Backdrop", kind: "image", url: "https://picsum.photos/seed/hyperlive/1280/720", desc: "a static image backdrop" },
];

let state = null; // { custom: [stage], active: id, titleDefault }
let seq = 0;

const ensure = () => state || (state = { custom: [], active: "scene", titleDefault: "slideL", overrides: {} });
const isBuiltin = (id) => BUILTINS.some((b) => b.id === id);
const ytId = (s) => {
  const raw = String(s || "");
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const m = raw.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
};
const httpUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null; } catch { return null; } };

// validate + normalize an incoming stage definition (operator input)
function normalize({ label, kind, source, url, id, muted, theme, titles, features, headline, kicker, subhead, ticker, showTicker } = {}) {
  kind = String(kind || "").toLowerCase();
  if (!STAGE_KINDS.includes(kind)) return { error: `kind must be ${STAGE_KINDS.join("|")}` };
  const out = { kind, label: String(label || "").slice(0, 60) };
  if (theme) out.theme = String(theme).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  // titles: "" / "default" → defer to the global default; else one of TITLE_ANIMS
  const t = String(titles || "").toLowerCase();
  if (t && t !== "default") out.titleAnim = TITLE_ANIMS.includes(t) ? t : "";
  // interactive features this stage runs (votes/superchats/effects/welcome/popups)
  out.features = normalizeFeatures(features);
  // optional overlay TITLE TEXT + TICKER messages — overlays that ride on top
  // of ANY stage (set via the existing setHeadline/setKicker/setSubhead/setTicker
  // scene actions). Strip control chars, clamp length; only kept when non-empty.
  const txt = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  let v;
  if (headline !== undefined && (v = txt(headline, 80))) out.headline = v;
  if (kicker !== undefined && (v = txt(kicker, 40))) out.kicker = v;
  if (subhead !== undefined && (v = txt(subhead, 120))) out.subhead = v;
  if (ticker !== undefined) {
    const items = (Array.isArray(ticker) ? ticker : String(ticker).split(/\r?\n/))
      .map((s) => txt(s, 60)).filter(Boolean).slice(0, 8);
    if (items.length) out.ticker = items;
  }
  out.showTicker = showTicker !== false; // explicit on every stage (default shown)
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
  state = { custom: [], active: "scene", titleDefault: "slideL", overrides: {} };
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    if (Array.isArray(j?.custom)) {
      state.custom = j.custom
        .map((c) => { const n = normalize(c); return n.stage ? { ...n.stage, id: c.id } : null; })
        .filter(Boolean);
      seq = state.custom.reduce((m, c) => Math.max(m, Number(String(c.id).replace(/\D/g, "")) || 0), 0);
    }
    // operator edits to builtins, re-validated through normalize
    if (j?.overrides && typeof j.overrides === "object") {
      for (const [k, v] of Object.entries(j.overrides)) {
        if (isBuiltin(k)) { const n = normalize(v); if (n.stage) state.overrides[k] = n.stage; }
      }
    }
    if (typeof j?.active === "string") state.active = j.active;
    if (TITLE_ANIMS.includes(j?.titleDefault)) state.titleDefault = j.titleDefault;
  } catch { /* defaults */ }
  return state;
}

// a builtin with its operator override applied (override fully replaces it,
// keeping the builtin's id + desc so it stays a resettable preset)
function builtinEffective(b) {
  const ov = state.overrides[b.id];
  return ov ? { ...ov, id: b.id, desc: b.desc, customized: true } : b;
}

export function getTitleDefault() { return ensure().titleDefault; }
export async function setTitleDefault(anim) {
  ensure();
  if (!TITLE_ANIMS.includes(anim)) return { ok: false, error: `titles must be ${TITLE_ANIMS.join("|")}` };
  state.titleDefault = anim;
  await persist();
  return { ok: true, titleDefault: anim };
}

async function persist() { try { await saveJson(FILE, state); } catch { /* non-fatal */ } }

export function listStages() {
  ensure();
  return {
    builtins: BUILTINS.map((b) => { const s = builtinEffective(b); return { ...s, builtin: true, features: featuresOf(s) }; }),
    custom: state.custom.map((c) => ({ ...c, builtin: false, features: featuresOf(c) })),
    active: state.active,
    kinds: STAGE_KINDS,
    titleAnims: TITLE_ANIMS,
    titleDefault: state.titleDefault,
    featureKeys: FEATURE_KEYS,
    featureLabels: FEATURE_LABELS,
  };
}

// a stage's interactive feature set (builtins default to everything on)
export function featuresOf(stage) { return normalizeFeatures(stage && stage.features); }

export function getStage(id) {
  ensure();
  const b = BUILTINS.find((x) => x.id === id);
  if (b) return builtinEffective(b);
  return state.custom.find((c) => c.id === id) || null;
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

export async function updateStage(id, def = {}) {
  ensure();
  const n = normalize(def);
  if (n.error) return { ok: false, error: n.error };
  // a builtin is edited by storing an override (it stays in the list, resettable)
  if (isBuiltin(id)) {
    state.overrides[id] = n.stage;
    await persist();
    return { ok: true, stage: { ...n.stage, id, builtin: true, customized: true } };
  }
  const i = state.custom.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: "unknown stage" };
  state.custom[i] = { ...n.stage, id };
  await persist();
  return { ok: true, stage: state.custom[i] };
}

// custom → delete; builtin → reset to its default (clear the override)
export async function removeStage(id) {
  ensure();
  if (isBuiltin(id)) {
    if (!state.overrides[id]) return { ok: false, error: "builtin is already at its default" };
    delete state.overrides[id];
    await persist();
    return { ok: true, reset: true };
  }
  const i = state.custom.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: "unknown stage" };
  state.custom.splice(i, 1);
  if (state.active === id) state.active = "scene";
  await persist();
  return { ok: true };
}

export async function setActive(id) { ensure(); state.active = id; await persist(); }

// identifies a stage's VIDEO/IMAGE source (incl. mute) so we can tell whether a
// re-apply actually needs to reload it. Re-applying the same source would
// restart the video — which we skip (see buildApplyDirectives { skipSource }).
export function sourceKey(stage) {
  if (!stage) return "none";
  if (stage.kind === "scene") return "scene";
  if (stage.kind === "youtube") return `youtube:${stage.videoId || ""}:${stage.muted ? "m" : ""}`;
  if (stage.kind === "video") return `video:${stage.url || ""}:${stage.muted ? "m" : ""}`;
  if (stage.kind === "image") return `image:${stage.url || ""}`;
  return stage.kind;
}

// the directives that apply a stage live: (optionally) set the source, crossfade
// the theme, fly the overlay titles in/out, set title text + ticker. All vetted,
// clamped scene actions. { skipSource } omits the setStageSource directive when
// the source is unchanged from what's already live — so re-applying a stage to
// toggle its titles/features doesn't restart the video.
export function buildApplyDirectives(stage, { skipSource = false } = {}) {
  ensure();
  const d = [];
  if (!skipSource) {
    if (stage.kind === "scene") d.push({ action: "setStageSource", params: { kind: "none" } });
    else if (stage.kind === "youtube") d.push({ action: "setStageSource", params: { kind: "youtube", id: stage.videoId, muted: !!stage.muted } });
    else if (stage.kind === "video") d.push({ action: "setStageSource", params: { kind: "video", url: stage.url, muted: !!stage.muted } });
    else if (stage.kind === "image") d.push({ action: "setStageSource", params: { kind: "image", url: stage.url } });
  }
  if (stage.theme) d.push({ action: "transitionTheme", params: { theme: stage.theme, duration: 1.2 } });
  // overlay title TEXT — set before the fly-in so the new text animates in
  if (stage.kicker) d.push({ action: "setKicker", params: { text: stage.kicker } });
  if (stage.headline) d.push({ action: "setHeadline", params: { text: stage.headline } });
  if (stage.subhead) d.push({ action: "setSubhead", params: { text: stage.subhead } });
  const anim = stage.titleAnim || state.titleDefault || "slideL";
  d.push(anim === "hide"
    ? { action: "setTitles", params: { show: false, anim: "fade" } }
    : { action: "setTitles", params: { show: true, anim } });
  // bottom ticker messages (the rotating cards). showTicker is explicit on
  // normalized stages, so every real apply sets the ticker's visibility:
  //   off → hide it · has messages → rotate them · on/no messages → re-show.
  // (raw stage objects without showTicker — e.g. tests — emit nothing here.)
  if (stage.showTicker === false) d.push({ action: "setTicker", params: { show: false } });
  else if (stage.ticker && stage.ticker.length) d.push({ action: "setTicker", params: { items: stage.ticker } });
  else if (stage.showTicker === true) d.push({ action: "setTicker", params: { show: true } });
  // Clear residual on-stage elements for any DISABLED feature, so applying the
  // stage brings the broadcast to the same clean state the fresh preview shows.
  // (Disabling a feature stops NEW events but doesn't remove what's already up —
  // an open vote panel, the standing ambient-effects state.) Only meaningful on
  // a normalized stage (features present); raw test objects skip it.
  if (stage.features) {
    const f = featuresOf(stage);
    if (!f.votes) d.push({ action: "voteEnd", params: {} }); // dismiss any open vote
    if (!f.effects) d.push({ action: "setMood", params: { intensity: 0.16, burstRate: 0, duration: 1.2,
      effects: { particles: -1, sparks: -1, datarain: -1, bokeh: -1, fog: -1, lightning: -1 } } }); // calm to off
  }
  return d;
}
