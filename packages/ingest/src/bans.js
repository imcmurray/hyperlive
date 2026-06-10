// Local ban list — "kick" at the directive-bus level. A banned viewer's
// messages are dropped before moderation, so they can't influence the stage
// at all. This is deliberately LOCAL-only: our OAuth scope is youtube.readonly
// by design, so we never touch YouTube's own chat moderation (that would need
// a youtube.force-ssl credential — documented opt-in, not default posture).
//
// Keyed by channelId when we have one (display names can change or be
// spoofed), with the display name as a fallback for sources without ids
// (the simulator) and for bans placed before an id was seen.

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const BANS_FILE = process.env.BANS_FILE || "./state/bans.json";

// bans  — dropped entirely before any processing (the hard tool)
// mutes — their messages are seen (feed shows "muted") but can never trigger
//         directives, cards, music, or votes (the soft tool)
// Both support optional expiresAt timeouts. Persisted together.
let bans = [];  // [{ channelId, author, ts, by, expiresAt? }]
let mutes = []; // same shape

export async function loadBans() {
  try {
    const j = JSON.parse(await readFile(BANS_FILE, "utf8"));
    if (Array.isArray(j)) bans = j.filter((b) => b && (b.channelId || b.author)); // legacy format
    else if (j && typeof j === "object") {
      bans = (j.bans || []).filter((b) => b && (b.channelId || b.author));
      mutes = (j.mutes || []).filter((b) => b && (b.channelId || b.author));
    }
  } catch { /* none yet */ }
  return bans.length + mutes.length;
}

async function persist() {
  try { await saveJson(BANS_FILE, { bans, mutes }); } catch { /* non-fatal */ }
}

const matches = (list, comment) => {
  const id = comment?.channelId || "";
  const name = String(comment?.author || "").toLowerCase();
  return list.some((b) =>
    (id && b.channelId && b.channelId === id) ||
    (name && b.author && b.author.toLowerCase() === name));
};

// lazily drop expired timeouts (a write only happens when something expired)
function pruneExpired() {
  const now = Date.now();
  const lb = bans.filter((b) => !b.expiresAt || b.expiresAt > now);
  const lm = mutes.filter((b) => !b.expiresAt || b.expiresAt > now);
  if (lb.length !== bans.length || lm.length !== mutes.length) { bans = lb; mutes = lm; persist(); }
}

export function isBanned(comment) { pruneExpired(); return matches(bans, comment); }
export function isMuted(comment) { pruneExpired(); return matches(mutes, comment); }

// durationMs missing/0 → permanent; otherwise a timeout that self-expires
export async function ban({ channelId = "", author = "", by = "dashboard", durationMs = 0 }) {
  if (!channelId && !author) return { ok: false, error: "channelId or author required" };
  if (isBanned({ channelId, author })) return { ok: true, already: true };
  const entry = { channelId, author, ts: Date.now(), by };
  if (Number(durationMs) > 0) entry.expiresAt = Date.now() + Number(durationMs);
  bans.push(entry);
  await persist();
  return { ok: true, expiresAt: entry.expiresAt };
}

export async function unban({ channelId = "", author = "" }) {
  const before = bans.length;
  const name = String(author || "").toLowerCase();
  bans = bans.filter((b) =>
    !((channelId && b.channelId === channelId) ||
      (name && b.author && b.author.toLowerCase() === name)));
  if (bans.length !== before) await persist();
  return { ok: true, removed: before - bans.length };
}

export async function mute({ channelId = "", author = "", by = "dashboard", durationMs = 0 }) {
  if (!channelId && !author) return { ok: false, error: "channelId or author required" };
  if (isMuted({ channelId, author })) return { ok: true, already: true };
  const entry = { channelId, author, ts: Date.now(), by };
  if (Number(durationMs) > 0) entry.expiresAt = Date.now() + Number(durationMs);
  mutes.push(entry);
  await persist();
  return { ok: true, expiresAt: entry.expiresAt };
}

export async function unmute({ channelId = "", author = "" }) {
  const before = mutes.length;
  const name = String(author || "").toLowerCase();
  mutes = mutes.filter((b) =>
    !((channelId && b.channelId === channelId) ||
      (name && b.author && b.author.toLowerCase() === name)));
  if (mutes.length !== before) await persist();
  return { ok: true, removed: before - mutes.length };
}

export function listBans() { pruneExpired(); return [...bans]; }
export function listMutes() { pruneExpired(); return [...mutes]; }
