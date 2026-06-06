// Real YouTube Live chat source. Auto-refreshes the OAuth token, auto-discovers
// the active broadcast's liveChatId (no hand-copying), polls liveChatMessages
// (respecting pollingIntervalMillis + pageToken), parses Super Chats, and
// re-discovers the chat when a broadcast ends — so it survives going off/on air.
//
// RESUME: the page cursor + a log of processed message ids are persisted to disk
// so a restart picks up exactly where it left off (no missed messages during the
// gap, no re-showing the backlog). YouTube's pageToken IS "everything after the
// last message I saw"; the id log dedups across the resume boundary.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getAccessToken } from "./youtube-auth.js";
import { bill, unitsSpent, loadUsage } from "./quota.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// NB: control/ is root-owned (the streamer container writes there), so the
// host-run ingest can't write it — keep the cursor in a user-writable dir.
const CURSOR_FILE = process.env.YT_CURSOR_FILE || "./state/yt-cursor.json";
const SEEN_MAX = 800; // in-memory cap on the processed-id log (persist the tail)
const CHAT_UNITS = config.yt.unitsPerCall || 5; // liveChatMessages.list cost

async function loadCursor() {
  try { return JSON.parse(await readFile(CURSOR_FILE, "utf8")); } catch { return null; }
}
async function saveCursor(liveChatId, pageToken, seen) {
  try {
    await mkdir(path.dirname(CURSOR_FILE), { recursive: true });
    await writeFile(CURSOR_FILE, JSON.stringify({ liveChatId, pageToken, seen: seen.slice(-300), ts: Date.now() }));
  } catch { /* non-fatal */ }
}

function toComment(item) {
  const s = item.snippet || {};
  const a = item.authorDetails || {};
  const sc = s.superChatDetails || s.superStickerDetails;
  const text = String(s.displayMessage || sc?.userComment || "")
    .replace(/:[a-z0-9_+-]{2,}:/gi, "").replace(/\s{2,}/g, " ").trim(); // strip :shortcode: emoji
  return {
    id: item.id,
    author: a.displayName || "viewer",
    text,
    avatar: a.profileImageUrl || "",
    ts: Date.parse(s.publishedAt) || Date.now(),
    superchat: sc ? { ytTier: sc.tier, amount: sc.amountDisplayString } : undefined,
  };
}

// discover the active broadcast → its video id (== broadcast id, what statistics
// are keyed by) and its liveChatId. Shared by the chat poller and the like poller.
export async function discoverActiveBroadcast(token) {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("broadcastStatus", "active");
  url.searchParams.set("broadcastType", "all");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await bill(1); // liveBroadcasts.list ≈ 1 unit
  if (!res.ok) throw new Error(`liveBroadcasts.list http ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const item = j.items?.[0];
  return { id: item?.id || "", liveChatId: item?.snippet?.liveChatId || "" };
}

async function resolveLiveChatId(token) {
  if (config.yt.liveChatId) return config.yt.liveChatId;
  for (;;) {
    const b = await discoverActiveBroadcast(token).catch((e) => { console.error("[youtube] discover:", e.message); return { liveChatId: "" }; });
    if (b.liveChatId) return b.liveChatId;
    console.log("[youtube] no active broadcast yet — re-checking in 15s (start 'Go Live' on YouTube)");
    await sleep(15000);
  }
}

export async function* youtubeSource() {
  let token = await getAccessToken();
  let liveChatId = await resolveLiveChatId(token);

  // resume from the saved cursor if it's the SAME chat — so a restart continues
  // from the last message instead of re-skipping the backlog
  const saved = await loadCursor();
  const resuming = !!(saved && saved.liveChatId === liveChatId && saved.pageToken);
  let pageToken = resuming ? saved.pageToken : "";
  let first = !resuming;                                  // skip backlog only on a fresh start
  const seen = new Set(resuming ? (saved.seen || []) : []);
  await loadUsage();
  console.log(`[youtube] connected — liveChatId=${liveChatId.slice(0, 14)}…${resuming ? ` (resumed, ${seen.size} seen)` : ""} | quota ${unitsSpent()}/${config.yt.quotaLimit} units today`);

  let lastSave = 0;
  let emptyStreak = 0; // consecutive empty polls → back off the interval
  for (;;) {
    // SAFETY CUTOFF: stop polling before we exceed the daily quota (music +
    // visuals keep running; restart the ingest after the Pacific-midnight reset)
    if (unitsSpent() >= config.yt.quotaLimit) {
      console.log(`[youtube] quota cutoff: spent ${unitsSpent()}/${config.yt.quotaLimit} units today — stopping chat polling. Restart after midnight Pacific.`);
      return;
    }

    token = await getAccessToken();

    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let data;
    try {
      let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      await bill(CHAT_UNITS); // a liveChatMessages.list call (~5 units)
      if (res.status === 401) { token = await getAccessToken(true); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); await bill(CHAT_UNITS); }
      if (res.status === 400 && pageToken) { // a stale/expired pageToken → start fresh
        console.log("[youtube] saved cursor rejected — starting fresh (skipping backlog)");
        pageToken = ""; first = true; continue;
      }
      if (res.status === 403 || res.status === 404) { // chat ended / broadcast over
        console.log(`[youtube] chat ${res.status} — broadcast ended; re-discovering active chat…`);
        liveChatId = await resolveLiveChatId(await getAccessToken(true));
        pageToken = ""; first = true; continue;
      }
      if (!res.ok) { console.error(`[youtube] poll http ${res.status} — retry 5s`); await sleep(5000); continue; }
      data = await res.json();
    } catch (e) {
      console.error("[youtube] poll error:", e.message, "— retry 5s");
      await sleep(5000);
      continue;
    }

    pageToken = data.nextPageToken || pageToken;
    let processed = 0;
    if (!first) {
      for (const item of data.items || []) {
        if (seen.has(item.id)) continue;   // dedup (mainly across the resume boundary)
        seen.add(item.id); processed++;
        yield toComment(item);
      }
      if (seen.size > SEEN_MAX) { // trim the in-memory log, keep the most recent half
        const tail = [...seen].slice(-Math.floor(SEEN_MAX / 2));
        seen.clear(); for (const id of tail) seen.add(id);
      }
    }
    first = false;

    const now = Date.now();
    if (now - lastSave > 5000) { lastSave = now; saveCursor(liveChatId, pageToken, [...seen]); }

    // ADAPTIVE: snappy while messages flow, ramp toward idle when quiet — never
    // faster than YouTube's own suggested cadence.
    if (processed > 0) emptyStreak = 0; else emptyStreak++;
    const want = processed > 0
      ? config.yt.pollActiveMs
      : Math.min(config.yt.pollIdleMs, config.yt.pollActiveMs + emptyStreak * 6000);
    await sleep(Math.max(want, data.pollingIntervalMillis || 0));
  }
}
