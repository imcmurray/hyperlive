// Synthetic comment source so the whole Phase 1 pipeline is testable WITHOUT
// any YouTube/Google credentials. Deliberately includes messages that SHOULD
// be blocked (profanity, spam, a rate-limit flood) so you can watch the
// moderation gate work, plus a couple of fake Super Chats.

import { config } from "./config.js";

const SCRIPT = [
  { author: "@alice", text: "theme: forest" },
  { author: "@bob", text: "this is actually working lol" },
  { author: "@spammer", text: "FREE VBUCKS http://scam.example.com claim now" }, // blocked: link/scam
  { author: "@carol", text: "headline: the community runs this show" },
  { author: "@troll", text: "fuck this stream" }, // blocked: blocklist
  { author: "@dave", text: "synthwave looks so clean 🔥" },
  { author: "@erin", text: "LETS GOOOO" },
  { author: "@whale", text: "love what you're building!", superchat: { tier: "large" } }, // payment
  { author: "@flooder", text: "spam1" }, // these 5 trip the rate limiter
  { author: "@flooder", text: "spam2" },
  { author: "@flooder", text: "spam3" },
  { author: "@flooder", text: "spam4" },
  { author: "@flooder", text: "spam5" },
  { author: "@frank", text: "switch to sunrise theme please" },
  { author: "@grace", text: "shoutout to the late night crew", superchat: { tier: "medium" } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function* simulatorSource() {
  let i = 0;
  for (const base of SCRIPT) {
    yield { id: `sim-${i}`, ...base };
    i += 1;
    await sleep(config.simIntervalMs);
  }
}
