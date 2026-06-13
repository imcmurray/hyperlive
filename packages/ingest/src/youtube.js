// Real YouTube Live chat source. Auto-refreshes the OAuth token, auto-discovers
// the active broadcast's liveChatId (no hand-copying), polls liveChatMessages
// (respecting pollingIntervalMillis + pageToken), parses Super Chats, and
// re-discovers the chat when a broadcast ends — so it survives going off/on air.
//
// RESUME: the page cursor + a log of processed message ids are persisted to disk
// so a restart picks up exactly where it left off (no missed messages during the
// gap, no re-showing the backlog). YouTube's pageToken IS "everything after the
// last message I saw"; the id log dedups across the resume boundary.

import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { saveJson } from "./state.js";
import { getAccessToken } from "./youtube-auth.js";
import { bill, unitsSpent, loadUsage, msUntilQuotaReset } from "./quota.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- feed health for the dashboard watchdog --------------------------------
// The poll loop retries token failures quietly forever (correct for a 24/7
// run), which means auth death is INVISIBLE to a moderator — chat just goes
// quiet. These timestamps let the dashboard turn that into an amber/red LED.
// videoId is the CURRENT broadcast id from discovery — the authoritative answer
// to "which broadcast are we on", which the stats/likes poller follows so it
// never clings to a stale persisted id from a past stream.
const health = { lastPollOkAt: 0, lastCommentAt: 0, tokenFailingSince: 0, quotaPausedUntil: 0, videoId: "" };
export const feedHealth = () => ({ ...health });
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
    await saveJson(CURSOR_FILE, { liveChatId, pageToken, seen: seen.slice(-300), ts: Date.now() });
  } catch { /* non-fatal */ }
}

// getAccessToken throws on any network blip to Google — never let that kill the
// 24/7 ingest. Retry with backoff; only a missing-config error is unrecoverable.
async function getTokenWithRetry(force = false) {
  for (let delay = 5000; ; delay = Math.min(delay * 2, 120000)) {
    try {
      const t = await getAccessToken(force);
      health.tokenFailingSince = 0; // refresh works again
      return t;
    } catch (e) {
      if (/YT_CLIENT_ID/.test(e.message)) throw e; // config missing — retrying won't help
      if (!health.tokenFailingSince) health.tokenFailingSince = Date.now();
      console.error(`[youtube] token refresh failed: ${e.message} — retry ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

// park until YouTube's quota reset (midnight Pacific), then carry on
async function sleepUntilQuotaReset(what) {
  const ms = msUntilQuotaReset();
  console.log(`[youtube] quota cutoff: spent ${unitsSpent()}/${config.yt.quotaLimit} units today — pausing ${what} ~${Math.ceil(ms / 60000)}m until the Pacific-midnight reset`);
  health.quotaPausedUntil = Date.now() + ms; // the LED explains the silence instead of crying wolf
  await sleep(ms);
  health.quotaPausedUntil = 0;
  console.log(`[youtube] quota reset — resuming ${what}`);
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
    channelId: a.channelId || "", // stable identity for the ban list (names can change)
    text,
    avatar: a.profileImageUrl || "",
    ts: Date.parse(s.publishedAt) || Date.now(),
    superchat: sc ? { ytTier: sc.tier, amount: sc.amountDisplayString } : undefined,
  };
}

// Pure broadcast selector (no I/O — unit-tested). Picks the broadcast to attach
// to from raw liveBroadcasts.list items:
//   · an ON-AIR broadcast (broadcastStatus=active) always wins.
//   · otherwise a WAITING one that's bound and whose chat is already open —
//     `testing` (in preview) ranks above `ready`, earliest scheduled first.
//     `created` (merely scheduled, no stream bound) and chat-less items are
//     skipped, so we never attach to a future scheduled stream.
// Returns the lifecycle status so callers can tell "on air" from "waiting".
export function chooseBroadcast(activeItems = [], upcomingItems = []) {
  const onAir = (activeItems || []).find((b) => b.snippet?.liveChatId);
  if (onAir) return { id: onAir.id, liveChatId: onAir.snippet.liveChatId, status: onAir.status?.lifeCycleStatus || "live" };
  const rank = (b) => (b.status?.lifeCycleStatus === "testing" ? 0 : 1); // testing outranks ready
  const w = (upcomingItems || [])
    .filter((b) => b.snippet?.liveChatId && ["ready", "testing"].includes(b.status?.lifeCycleStatus))
    .sort((a, b) => rank(a) - rank(b) ||
      String(a.snippet.scheduledStartTime || "").localeCompare(String(b.snippet.scheduledStartTime || "")))[0];
  return w ? { id: w.id, liveChatId: w.snippet.liveChatId, status: w.status?.lifeCycleStatus || "" }
    : { id: "", liveChatId: "", status: "" };
}

async function listBroadcasts(token, broadcastStatus) {
  const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("broadcastStatus", broadcastStatus);
  url.searchParams.set("broadcastType", "all");
  url.searchParams.set("maxResults", "20");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await bill(1); // liveBroadcasts.list ≈ 1 unit
  if (!res.ok) throw new Error(`liveBroadcasts.list http ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).items || [];
}

// Discover the broadcast to attach to → its video id (== broadcast id, what
// statistics are keyed by), liveChatId, and lifecycle status. Prefers the LIVE
// broadcast; falls back to a READY/TESTING one whose chat is already open, so
// the ingest picks up the waiting-room chat before Go Live (YouTube's
// broadcastStatus=active misses those). The on-air case stays a single call;
// the upcoming probe (1 more unit) only fires when nothing is live.
// Shared by the chat poller, the like/stats poller, and the dashboard preflight.
export async function discoverActiveBroadcast(token, { includeUpcoming = true } = {}) {
  const active = await listBroadcasts(token, "active");
  const hit = chooseBroadcast(active, []);
  if (hit.id || !includeUpcoming) return hit;
  const upcoming = await listBroadcasts(token, "upcoming");
  return chooseBroadcast(active, upcoming);
}

async function resolveLiveChatId(token) {
  if (config.yt.liveChatId) return config.yt.liveChatId;
  for (;;) {
    if (unitsSpent() >= config.yt.quotaLimit) { await sleepUntilQuotaReset("broadcast discovery"); token = await getTokenWithRetry(); }
    const b = await discoverActiveBroadcast(token).catch((e) => { console.error("[youtube] discover:", e.message); return { liveChatId: "" }; });
    if (b.liveChatId) {
      health.videoId = b.id || ""; // stats/likes poller follows this current broadcast
      if (b.status && b.status !== "live") console.log(`[youtube] attached to ${b.status} broadcast (chat open pre-live) — video ${b.id} | will keep reading through Go Live`);
      return b.liveChatId;
    }
    console.log("[youtube] no live or ready broadcast yet — re-checking in 15s (it attaches as soon as a broadcast's chat opens, before Go Live)");
    await sleep(15000);
  }
}

export async function* youtubeSource() {
  await loadUsage(); // before discovery, so its quota guard sees today's spend
  let token = await getTokenWithRetry();
  let liveChatId = await resolveLiveChatId(token);

  // resume from the saved cursor if it's the SAME chat — so a restart continues
  // from the last message instead of re-skipping the backlog
  const saved = await loadCursor();
  const resuming = !!(saved && saved.liveChatId === liveChatId && saved.pageToken);
  let pageToken = resuming ? saved.pageToken : "";
  let first = !resuming;                                  // skip backlog only on a fresh start
  const seen = new Set(resuming ? (saved.seen || []) : []);
  console.log(`[youtube] connected — liveChatId=${liveChatId.slice(0, 14)}…${resuming ? ` (resumed, ${seen.size} seen)` : ""} | quota ${unitsSpent()}/${config.yt.quotaLimit} units today`);

  let lastSave = 0;
  let emptyStreak = 0; // consecutive empty polls → back off the interval
  // Catch-up probe: a STALE pageToken is the silent failure mode — a restarted
  // broadcast keeps the same liveChatId but kills the old session's token, and
  // YouTube returns empty (not an error), so a normal poll would miss everything
  // forever. When polls go quiet, one poll periodically drops the pageToken to
  // re-anchor to the live tail; if that surfaces unseen messages, the token was
  // stale and we've recovered. It replaces an idle poll, so it costs no extra
  // quota. lastProbeAt=0 ⇒ probe on the FIRST idle, so a fresh start that
  // resumed a dead token self-heals within ~a minute.
  const PROBE_INTERVAL_MS = Number(process.env.YT_PROBE_INTERVAL_MS) || 180000;
  let lastProbeAt = 0;
  let probeNext = false;
  for (;;) {
    // SAFETY CUTOFF: pause polling before we exceed the daily quota (music +
    // visuals keep running), then resume after the Pacific-midnight reset.
    // Hours of backlog accumulated during the pause — re-anchor at the live
    // tail like a fresh start instead of replaying stale messages.
    if (unitsSpent() >= config.yt.quotaLimit) {
      await sleepUntilQuotaReset("chat polling");
      pageToken = ""; first = true;
    }

    token = await getTokenWithRetry();

    const probing = probeNext; probeNext = false; // a probe drops the token to re-anchor
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (pageToken && !probing) url.searchParams.set("pageToken", pageToken);

    let data;
    try {
      let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      await bill(CHAT_UNITS); // a liveChatMessages.list call (~5 units)
      if (res.status === 401) { token = await getTokenWithRetry(true); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); await bill(CHAT_UNITS); }
      if (res.status === 400 && pageToken) { // a stale/expired pageToken → start fresh
        console.log("[youtube] saved cursor rejected — starting fresh (skipping backlog)");
        pageToken = ""; first = true; continue;
      }
      if (res.status === 403 || res.status === 404) { // chat ended / broadcast over
        console.log(`[youtube] chat ${res.status} — broadcast ended; re-discovering active chat…`);
        liveChatId = await resolveLiveChatId(await getTokenWithRetry(true));
        pageToken = ""; first = true; continue;
      }
      if (!res.ok) { console.error(`[youtube] poll http ${res.status} — retry 5s`); await sleep(5000); continue; }
      data = await res.json();
      health.lastPollOkAt = Date.now();
    } catch (e) {
      console.error("[youtube] poll error:", e.message, "— retry 5s");
      await sleep(5000);
      continue;
    }

    pageToken = data.nextPageToken || pageToken;
    let processed = 0;
    if (first) {
      // skip the backlog on a fresh start — but REMEMBER its ids so a later
      // catch-up probe doesn't replay the same backlog as "unseen"
      for (const item of data.items || []) seen.add(item.id);
    } else {
      for (const item of data.items || []) {
        if (seen.has(item.id)) continue;   // dedup (resume boundary + probe overlap)
        seen.add(item.id); processed++;
        health.lastCommentAt = Date.now();
        yield toComment(item);
      }
      if (seen.size > SEEN_MAX) { // trim the in-memory log, keep the most recent half
        const tail = [...seen].slice(-Math.floor(SEEN_MAX / 2));
        seen.clear(); for (const id of tail) seen.add(id);
      }
    }
    first = false;
    if (probing) {
      lastProbeAt = Date.now();
      if (processed > 0) console.log(`[youtube] catch-up probe re-synced (+${processed} missed — stale pageToken recovered)`);
    }

    const now = Date.now();
    if (now - lastSave > 5000) { lastSave = now; saveCursor(liveChatId, pageToken, [...seen]); }

    // ADAPTIVE: snappy while messages flow, ramp toward idle when quiet — never
    // faster than YouTube's own suggested cadence.
    if (processed > 0) emptyStreak = 0; else emptyStreak++;
    // when polls go quiet, periodically re-anchor with a token-less probe so a
    // dead pageToken can't strand us in permanent silence
    if (processed === 0 && !probing && now - lastProbeAt >= PROBE_INTERVAL_MS) probeNext = true;
    const want = processed > 0
      ? config.yt.pollActiveMs
      : Math.min(config.yt.pollIdleMs, config.yt.pollActiveMs + emptyStreak * 6000);
    await sleep(Math.max(want, data.pollingIntervalMillis || 0));
  }
}
