// Stream-like milestones: poll the live broadcast's VIDEO like count
// (statistics.likeCount) and, when it crosses a milestone, fire a celebratory
// shoutout + burst on the scene. This is the "like the STREAM" signal — distinct
// from chat hearts, which like the current SONG. Likes hidden by the channel
// (likeCount absent) are simply skipped. Quota-aware (videos.list ≈ 1 unit) and
// it shares the chat poller's daily counter via quota.js.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getAccessToken } from "./youtube-auth.js";
import { discoverActiveBroadcast } from "./youtube.js";
import { bill, unitsSpent } from "./quota.js";

const STATE_FILE = process.env.YT_LIKES_FILE || "./state/yt-likes.json";

// curated milestone ladder; beyond the top it continues every 5000.
const LADDER = [5, 10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];

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
    try { await mkdir(path.dirname(STATE_FILE), { recursive: true }); await writeFile(STATE_FILE, JSON.stringify({ videoId, likeCount: lastCount, lastMilestone })); } catch { /* non-fatal */ }
  }

  async function ensureVideoId(token) {
    if (videoId) return videoId;
    const b = await discoverActiveBroadcast(token).catch(() => ({ id: "" }));
    if (b.id) { videoId = b.id; lastMilestone = 0; lastCount = 0; } // new broadcast → fresh milestones
    return videoId;
  }

  async function pollOnce() {
    if (unitsSpent() >= config.yt.quotaLimit) return; // share the daily cap with chat
    let token = await getAccessToken();
    if (!videoId) { await ensureVideoId(token); if (!videoId) return; }

    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "statistics");
    url.searchParams.set("id", videoId);
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    await bill(1); // videos.list ≈ 1 unit
    if (res.status === 401) { token = await getAccessToken(true); res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); await bill(1); }
    if (!res.ok) { log(`[likes] videos.list http ${res.status}`); return; }

    const item = (await res.json()).items?.[0];
    if (!item) { log("[likes] no video stats — broadcast ended? re-discovering"); videoId = config.yt.videoId || ""; return; }
    const likes = Number(item.statistics?.likeCount);
    if (!Number.isFinite(likes)) return; // channel hides likes → nothing to do

    const m = highestMilestoneCrossed(lastMilestone, likes);
    lastCount = likes;
    if (m > 0) {
      lastMilestone = m;
      log(`[likes] 🎉 stream-like milestone ${m} (now ${likes})`);
      await postMutate({ action: "addShoutout", params: { tier: "large", who: "STREAM ❤", text: `${m.toLocaleString()} likes — thank you! 🎉` } }).catch(() => {});
      await postMutate({ action: "burst", params: { intensity: 0.7 } }).catch(() => {});
    }
    await saveState();
  }

  return {
    async start() {
      await loadState();
      log(`[likes] stream-like milestones on — poll ${Math.round(config.streamLikesPollMs / 1000)}s (resuming past milestone ${lastMilestone})`);
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
