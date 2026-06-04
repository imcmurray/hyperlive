// Real YouTube Live chat source. Auto-refreshes the OAuth token, auto-discovers
// the active broadcast's liveChatId (no hand-copying), polls liveChatMessages
// (respecting pollingIntervalMillis + pageToken), parses Super Chats, and
// re-discovers the chat when a broadcast ends — so it survives going off/on air.

import { config } from "./config.js";
import { getAccessToken } from "./youtube-auth.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toComment(item) {
  const s = item.snippet || {};
  const a = item.authorDetails || {};
  // Super Chat / Super Sticker arrive in the SAME feed; tier (1–5) → ytTier,
  // which director.js scTier() maps to our small/medium/large.
  const sc = s.superChatDetails || s.superStickerDetails;
  return {
    id: item.id,
    author: a.displayName || "viewer",
    text: s.displayMessage || sc?.userComment || "",
    avatar: a.profileImageUrl || "",                 // the viewer's actual avatar
    ts: Date.parse(s.publishedAt) || Date.now(),     // when they actually typed it
    superchat: sc ? { ytTier: sc.tier, amount: sc.amountDisplayString } : undefined,
  };
}

// find the liveChatId of the channel's currently-active broadcast
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

// explicit YT_LIVE_CHAT_ID wins; otherwise poll until a broadcast is live
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
  console.log(`[youtube] connected — liveChatId=${liveChatId.slice(0, 14)}…`);

  let pageToken = "";
  let first = true; // skip the historical backlog; only react to NEW messages

  for (;;) {
    token = await getAccessToken(); // cached; refreshes itself near expiry

    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let data;
    try {
      let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { // token rejected mid-life → force a refresh + retry
        token = await getAccessToken(true);
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      }
      if (res.status === 403 || res.status === 404) { // chat ended / broadcast over
        console.log(`[youtube] chat ${res.status} — broadcast ended; re-discovering active chat…`);
        liveChatId = await resolveLiveChatId(await getAccessToken(true));
        pageToken = ""; first = true;
        continue;
      }
      if (!res.ok) { console.error(`[youtube] poll http ${res.status} — retry 5s`); await sleep(5000); continue; }
      data = await res.json();
    } catch (e) {
      console.error("[youtube] poll error:", e.message, "— retry 5s");
      await sleep(5000);
      continue;
    }

    pageToken = data.nextPageToken || pageToken;
    if (!first) for (const item of data.items || []) yield toComment(item);
    first = false;

    // poll no faster than our quota cap, but slower if YouTube asks (quiet chat)
    await sleep(Math.max(config.yt.minPollMs, data.pollingIntervalMillis || 3000));
  }
}
