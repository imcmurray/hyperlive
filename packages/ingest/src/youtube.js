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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// NB: control/ is root-owned (the streamer container writes there), so the
// host-run ingest can't write it — keep the cursor in a user-writable dir.
const CURSOR_FILE = process.env.YT_CURSOR_FILE || "./state/yt-cursor.json";
const SEEN_MAX = 800; // in-memory cap on the processed-id log (persist the tail)

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

async function discoverLiveChatId(token) {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("broadcastStatus", "active");
  url.searchParams.set("broadcastType", "all");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`liveBroadcasts.list http ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return j.items?.[0]?.snippet?.liveChatId || "";
}

async function resolveLiveChatId(token) {
  if (config.yt.liveChatId) return config.yt.liveChatId;
  for (;;) {
    const id = await discoverLiveChatId(token).catch((e) => { console.error("[youtube] discover:", e.message); return ""; });
    if (id) return id;
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
  console.log(`[youtube] connected — liveChatId=${liveChatId.slice(0, 14)}…${resuming ? ` (resumed, ${seen.size} seen)` : ""}`);

  let lastSave = 0;
  for (;;) {
    token = await getAccessToken();

    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let data;
    try {
      let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { token = await getAccessToken(true); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
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
    if (!first) {
      for (const item of data.items || []) {
        if (seen.has(item.id)) continue;   // dedup (mainly across the resume boundary)
        seen.add(item.id);
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

    await sleep(Math.max(config.yt.minPollMs, data.pollingIntervalMillis || 3000));
  }
}
