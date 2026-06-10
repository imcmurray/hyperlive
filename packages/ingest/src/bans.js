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

let bans = []; // [{ channelId, author, ts, by }]

export async function loadBans() {
  try {
    const arr = JSON.parse(await readFile(BANS_FILE, "utf8"));
    if (Array.isArray(arr)) bans = arr.filter((b) => b && (b.channelId || b.author));
  } catch { /* none yet */ }
  return bans.length;
}

async function persist() {
  try { await saveJson(BANS_FILE, bans); } catch { /* non-fatal */ }
}

export function isBanned(comment) {
  const id = comment?.channelId || "";
  const name = String(comment?.author || "").toLowerCase();
  return bans.some((b) =>
    (id && b.channelId && b.channelId === id) ||
    (name && b.author && b.author.toLowerCase() === name));
}

export async function ban({ channelId = "", author = "", by = "dashboard" }) {
  if (!channelId && !author) return { ok: false, error: "channelId or author required" };
  if (isBanned({ channelId, author })) return { ok: true, already: true };
  bans.push({ channelId, author, ts: Date.now(), by });
  await persist();
  return { ok: true };
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

export function listBans() { return [...bans]; }
