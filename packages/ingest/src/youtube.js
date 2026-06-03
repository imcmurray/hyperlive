// Real YouTube Live chat source. Polls liveChatMessages.list, respects the
// API's pollingIntervalMillis + pageToken, and parses Super Chats. Needs an
// OAuth access token + the broadcast's liveChatId (see docs/phase1.md).
//
// Uses raw fetch (no googleapis dependency). The access token is short-lived;
// for an unattended run you'd refresh it — left as a Phase 4 hardening item.

import { config } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toComment(item) {
  const s = item.snippet || {};
  const author = item.authorDetails?.displayName || "viewer";
  // Super Chat / Super Sticker surface here in the SAME feed
  const sc = s.superChatDetails || s.superStickerDetails;
  return {
    id: item.id,
    author,
    text: s.displayMessage || sc?.userComment || "",
    superchat: sc ? { ytTier: sc.tier, amount: sc.amountDisplayString } : undefined,
  };
}

export async function* youtubeSource() {
  const { liveChatId, accessToken } = config.yt;
  if (!liveChatId || !accessToken) {
    throw new Error("SOURCE=youtube needs YT_LIVE_CHAT_ID and YT_ACCESS_TOKEN (see docs/phase1.md)");
  }

  let pageToken = "";
  // skip the historical backlog on first poll — only react to NEW messages
  let first = true;

  while (true) {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let data;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        console.error(`[youtube] poll http ${res.status} — retrying in 5s`);
        await sleep(5000);
        continue;
      }
      data = await res.json();
    } catch (e) {
      console.error("[youtube] poll error:", e.message, "— retrying in 5s");
      await sleep(5000);
      continue;
    }

    pageToken = data.nextPageToken || pageToken;
    const items = data.items || [];
    if (!first) {
      for (const item of items) yield toComment(item);
    }
    first = false;

    // honour the server's requested cadence (quota-friendly), min 1.5s
    await sleep(Math.max(1500, data.pollingIntervalMillis || 3000));
  }
}
