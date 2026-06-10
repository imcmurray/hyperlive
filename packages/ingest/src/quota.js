// Shared YouTube Data API quota accounting. Units spent today are persisted so
// live.sh can read them and a restart resumes the running total; resets at
// midnight Pacific (YouTube's own reset). Both the chat poller and the
// stream-like poller bill against this single in-memory counter, so together
// they never blow the daily cap.

import { readFile } from "node:fs/promises";
import { saveJson } from "./state.js";

const USAGE_FILE = process.env.YT_USAGE_FILE || "./state/yt-usage.json";
const pacificDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
let usage = null; // { date, units, calls }

async function ensure() {
  const today = pacificDate();
  if (usage && usage.date === today) return usage;
  if (!usage) {
    try { const u = JSON.parse(await readFile(USAGE_FILE, "utf8")); if (u && u.date === today) { usage = u; return usage; } } catch { /* none/stale */ }
  }
  usage = { date: today, units: 0, calls: 0 }; // fresh or post-midnight reset
  return usage;
}

// count one API call that cost `units` quota units (liveChatMessages.list ≈ 5;
// liveBroadcasts.list / videos.list ≈ 1)
export async function bill(units = 1) {
  await ensure();
  usage.units += units;
  usage.calls += 1;
  try { await saveJson(USAGE_FILE, usage); } catch { /* non-fatal */ }
  return usage.units;
}

// date-aware: after the Pacific-midnight reset, yesterday's total reads as 0
// even though nothing has billed yet today (pollers gate on this BEFORE billing)
export function unitsSpent() { return usage && usage.date === pacificDate() ? usage.units : 0; }
export async function loadUsage() { return ensure(); }

// how long until YouTube's quota reset (midnight Pacific), with a 60s margin
export function msUntilQuotaReset() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const secsLeft = 24 * 3600 - ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second"));
  return secsLeft * 1000 + 60000;
}
