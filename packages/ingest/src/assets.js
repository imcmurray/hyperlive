// Asset library: a collection of the model/operator-authored cards (and
// takeovers) that have ACTUALLY been aired, captured so they can be re-used or
// tweaked instead of re-composed from scratch. Each carries its off-air
// pre-render as a thumbnail and a 0–3 star rating so favorites sort to the top.
//
// Captured at the air point (an approved pending item). Deduped by html — airing
// the same markup again just bumps its use count. Persisted to state/assets.json.

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const FILE = process.env.ASSETS_FILE || "./state/assets.json";
const MAX = 40;          // cap; evict lowest-star, then least-recently-used
const MAX_STARS = 3;

let assets = [];   // [{ id, kind, html, who, screenshot, stars, ts, usedCount, usedAt }]
let seq = 0;

// a cheap stable hash of the markup, for dedup
function hash(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function loadAssets() {
  assets = [];
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    if (Array.isArray(j?.assets)) {
      assets = j.assets.filter((a) => a && a.html && a.kind);
      seq = assets.reduce((m, a) => Math.max(m, Number(String(a.id).replace(/\D/g, "")) || 0), 0);
    }
  } catch { /* none yet */ }
  return assets.length;
}

async function persist() { try { await saveJson(FILE, { assets }); } catch { /* non-fatal */ } }

// derive a short human label from the markup (first text or a tag), best-effort
function deriveLabel(html) {
  const text = String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 40);
  const tag = String(html || "").match(/<(\w+)/);
  return tag ? `<${tag[1]}>…` : "card";
}

// capture an AIRED asset. Same markup already in the library → bump its usage
// (and refresh the thumbnail) rather than duplicate.
export async function captureAsset({ kind = "card", html, who = "moderator", screenshot = "", label } = {}) {
  if (!html) return null;
  const h = hash(html);
  const existing = assets.find((a) => a.hash === h);
  if (existing) {
    existing.usedCount = (existing.usedCount || 1) + 1;
    existing.usedAt = Date.now();
    if (screenshot) existing.screenshot = screenshot;
    await persist();
    return existing;
  }
  const entry = {
    id: `a${++seq}`, kind, html, who, hash: h,
    screenshot: screenshot || "",
    label: String(label || deriveLabel(html)).slice(0, 60),
    stars: 0, ts: Date.now(), usedCount: 1, usedAt: Date.now(),
  };
  assets.push(entry);
  // evict when over cap: lowest stars first, then least-recently-used
  if (assets.length > MAX) {
    assets.sort((a, b) => (a.stars - b.stars) || ((a.usedAt || a.ts) - (b.usedAt || b.ts)));
    assets = assets.slice(assets.length - MAX);
  }
  await persist();
  return entry;
}

// favorites first, then most-recently used
export function listAssets() {
  return [...assets].sort((a, b) => (b.stars - a.stars) || ((b.usedAt || b.ts) - (a.usedAt || a.ts)));
}

export function getAsset(id) { return assets.find((a) => a.id === id) || null; }

export async function setStars(id, n) {
  const a = assets.find((x) => x.id === id);
  if (!a) return { ok: false, error: "unknown asset" };
  a.stars = Math.max(0, Math.min(MAX_STARS, Math.round(Number(n) || 0)));
  await persist();
  return { ok: true, stars: a.stars };
}

export async function removeAsset(id) {
  const i = assets.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, error: "unknown asset" };
  assets.splice(i, 1);
  await persist();
  return { ok: true };
}

export async function markUsed(id) {
  const a = assets.find((x) => x.id === id);
  if (!a) return;
  a.usedCount = (a.usedCount || 1) + 1;
  a.usedAt = Date.now();
  await persist();
}
