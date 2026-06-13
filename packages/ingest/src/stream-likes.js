// Stream-like milestones + stream stats, one poller:
//  · likes — poll the live broadcast's VIDEO like count (statistics.likeCount)
//    and, when it crosses a milestone, fire a celebratory shoutout + burst on
//    the scene. This is the "like the STREAM" signal — distinct from chat
//    hearts, which like the current SONG. Likes hidden by the channel
//    (likeCount absent) are simply skipped. Gated by config.streamLikes.
//  · stats — concurrentViewers + actualStartTime ride the SAME videos.list
//    call (parts are free; the call is 1 unit either way), and subscriberCount
//    comes from a channels.list (~1 unit) every SUBS_EVERY polls. They feed
//    the dashboard header via streamStats(). Gated by config.streamStats.
// Quota-aware and it shares the chat poller's daily counter via quota.js.

import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { saveJson } from "./state.js";
import { getAccessToken } from "./youtube-auth.js";
import { discoverActiveBroadcast, feedHealth } from "./youtube.js";
import { bill, unitsSpent, loadUsage } from "./quota.js";
import { automation, emitAutomation } from "./automations.js";

const STATE_FILE = process.env.YT_LIKES_FILE || "./state/yt-likes.json";

// curated milestone ladder; beyond the top it continues every 5000.
const LADDER = [5, 10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];

// ---- stream stats for the dashboard header (viewers / subs / started) -------
// nulls until the first successful poll; viewers goes back to null if the
// broadcast ends (liveStreamingDetails disappears with it).
const SUBS_EVERY = 8; // subscriber poll every Nth video poll (45s × 8 ≈ 6 min)
const stats = { viewers: null, subscribers: null, startedAt: null };
export const streamStats = () => ({ ...stats });

// highest milestone in (prev, cur] — 0 if none. Only the top one is celebrated,
// so a big jump between polls fires once, not a flurry.
export function highestMilestoneCrossed(prev, cur) {
  if (!(cur > prev)) return 0;
  let best = 0;
  for (const m of LADDER) if (m > prev && m <= cur) best = m;
  const top = LADDER[LADDER.length - 1];
  if (cur > top) for (let m = top + 5000; m <= cur; m += 5000) if (m > prev) best = m;
  return best;
}

export function createStreamLikes({ postMutate, log = () => {} }) {
  let stopped = false;
  let videoId = config.yt.videoId || "";
  let lastMilestone = 0;
  let lastCount = 0;
  let timer = null;

  async function loadState() {
    try {
      const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
      if (s && s.videoId && (!videoId || s.videoId === videoId)) {
        videoId = videoId || s.videoId;
        lastMilestone = s.lastMilestone || 0;
        lastCount = s.likeCount || 0;
      }
    } catch { /* none yet */ }
  }
  async function saveState() {
    try { await saveJson(STATE_FILE, { videoId, likeCount: lastCount, lastMilestone }); } catch { /* non-fatal */ }
  }

  async function ensureVideoId(token) {
    if (videoId) return videoId;
    const b = await discoverActiveBroadcast(token).catch(() => ({ id: "" }));
    if (b.id) { videoId = b.id; lastMilestone = 0; lastCount = 0; } // new broadcast → fresh milestones
    return videoId;
  }

  let pollN = 0; // counts video polls, paces the (rarer) subscriber poll

  // subscriberCount of OUR channel (mine=true — same OAuth identity that owns
  // the broadcast). Hidden subscriber counts come back absent → stays null.
  async function pollSubscribers(token) {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "statistics");
    url.searchParams.set("mine", "true");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    await bill(1); // channels.list ≈ 1 unit
    if (!res.ok) { log(`[stats] channels.list http ${res.status}`); return; }
    const subs = Number((await res.json()).items?.[0]?.statistics?.subscriberCount);
    stats.subscribers = Number.isFinite(subs) ? subs : null;
  }

  async function pollOnce() {
    if (unitsSpent() >= config.yt.quotaLimit) return; // share the daily cap with chat
    let token = await getAccessToken();
    // Follow the chat poller's CURRENT broadcast — its discovery is the source
    // of truth. Without this, a videoId loaded from disk (or pinned from a past
    // run) keeps these stats on a long-ended stream: its ancient actualStartTime
    // shows as a days-long "uptime" and its likes/viewers are meaningless.
    const liveVid = feedHealth().videoId;
    if (liveVid && liveVid !== videoId) {
      videoId = liveVid;
      lastMilestone = 0; lastCount = 0;          // fresh broadcast → fresh like ladder
      stats.viewers = null; stats.startedAt = null;
    }
    if (!videoId) { await ensureVideoId(token); if (!videoId) return; }

    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "statistics,liveStreamingDetails");
    url.searchParams.set("id", videoId);
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    await bill(1); // videos.list ≈ 1 unit (regardless of parts)
    if (res.status === 401) { token = await getAccessToken(true); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); await bill(1); }
    if (!res.ok) { log(`[likes] videos.list http ${res.status}`); return; }

    const item = (await res.json()).items?.[0];
    if (!item) {
      log("[likes] no video stats — broadcast ended? re-discovering");
      videoId = config.yt.videoId || "";
      stats.viewers = null; stats.startedAt = null;
      return;
    }

    if (config.streamStats) {
      const lsd = item.liveStreamingDetails || {};
      const viewers = Number(lsd.concurrentViewers);
      // concurrentViewers is present ONLY while the broadcast is live right now.
      // Gate BOTH viewers and the on-air clock on it: a ready/ended video still
      // carries actualStartTime (possibly days old), so anchoring uptime to it
      // off-air is how a 165-hour "uptime" happens. Off-air → null → the header
      // falls back to ingest uptime.
      const liveNow = Number.isFinite(viewers);
      stats.viewers = liveNow ? viewers : null;
      stats.startedAt = liveNow ? (Date.parse(lsd.actualStartTime) || null) : null;
      if (pollN % SUBS_EVERY === 0) await pollSubscribers(token).catch((e) => log(`[stats] subs poll: ${e.message}`));
    }
    pollN++;

    if (!config.streamLikes) return; // stats-only mode — no milestone work
    const likes = Number(item.statistics?.likeCount);
    if (!Number.isFinite(likes)) return; // channel hides likes → nothing to do

    const m = highestMilestoneCrossed(lastMilestone, likes);
    lastCount = likes;
    if (m > 0) {
      lastMilestone = m;
      log(`[likes] 🎉 stream-like milestone ${m} (now ${likes})`);
      if (automation("milestone").enabled) {
        await postMutate({ action: "addShoutout", params: { tier: "large", who: "STREAM ❤", text: `${m.toLocaleString()} likes — thank you! 🎉` } }).catch(() => {});
        await postMutate({ action: "burst", params: { intensity: 0.7 } }).catch(() => {});
      }
      emitAutomation("milestone", { count: m.toLocaleString() });
    }
    await saveState();
  }

  return {
    async start() {
      await loadState();
      await loadUsage(); // don't poll (and bill) before today's spend is known
      const jobs = [config.streamLikes && "like milestones", config.streamStats && "stream stats"].filter(Boolean).join(" + ");
      log(`[likes] ${jobs} on — poll ${Math.round(config.streamLikesPollMs / 1000)}s (resuming past milestone ${lastMilestone})`);
      const loop = async () => {
        if (stopped) return;
        try { await pollOnce(); } catch (e) { log(`[likes] poll error: ${e.message}`); }
        if (!stopped) timer = setTimeout(loop, config.streamLikesPollMs);
      };
      loop();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
