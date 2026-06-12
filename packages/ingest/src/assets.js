// Asset library: a collection of the model/operator-authored cards (and
// takeovers) that have ACTUALLY been aired, captured so they can be re-used or
// tweaked instead of re-composed from scratch. Each carries its off-air
// pre-render as a thumbnail and a 0–3 star rating so favorites sort to the top.
//
// Captured at the air point (an approved pending item). Deduped by html — airing
// the same markup again just bumps its use count. Persisted to state/assets.json.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveJson } from "./state.js";

const FILE = process.env.ASSETS_FILE || "./state/assets.json";
// starter examples shipped with the repo — loaded on a fresh install so the
// library isn't empty out of the box (then it's a normal mutable library)
const SEED = process.env.ASSETS_SEED || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/assets.seed.json");
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
  let haveFile = false;
  try {
    const j = JSON.parse(await readFile(FILE, "utf8"));
    haveFile = true; // the file exists — respect it even if the user emptied it
    if (Array.isArray(j?.assets)) assets = j.assets.filter((a) => a && a.html && a.kind);
  } catch { /* no saved file yet */ }
  // fresh install (no saved file) → seed the shipped starter examples
  if (!haveFile) {
    try {
      const seed = JSON.parse(await readFile(SEED, "utf8"));
      if (Array.isArray(seed?.assets)) {
        const now = Date.now();
        assets = seed.assets.filter((a) => a && a.html && a.kind).map((a, i) => ({
          ...a, id: `a${i + 1}`,
          stars: Math.max(0, Math.min(MAX_STARS, Number(a.stars) || 0)),
          usedCount: 1, ts: now - (seed.assets.length - i), usedAt: now - (seed.assets.length - i),
        }));
        await persist(); // write them to state so edits/stars stick from here on
      }
    } catch { /* no seed file — empty library */ }
  }
  seq = assets.reduce((m, a) => Math.max(m, Number(String(a.id).replace(/\D/g, "")) || 0), 0);
  return assets.length;
}

async function persist() { try { await saveJson(FILE, { assets }); } catch { /* non-fatal */ } }

// derive a short human label from the markup (first text or a tag), best-effort.
// strips tags and decodes the common HTML entities so the label reads cleanly
// (e.g. "&#127881; 1,000 &#8212; thanks" → "🎉 1,000 — thanks").
function deriveLabel(html) {
  let text = String(html || "").replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return " "; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return " "; } })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
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

// operator-renamed library label. Empty → re-derive from the markup so a card
// is never left blank in the library.
export async function setLabel(id, label) {
  const a = assets.find((x) => x.id === id);
  if (!a) return { ok: false, error: "unknown asset" };
  a.label = (String(label || "").replace(/\s+/g, " ").trim().slice(0, 60)) || deriveLabel(a.html);
  await persist();
  return { ok: true, label: a.label };
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
