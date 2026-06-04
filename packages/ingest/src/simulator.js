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
const pick = (a) => a[(Math.random() * a.length) | 0];

export async function* simulatorSource() {
  let i = 0;
  for (const base of SCRIPT) {
    yield { id: `sim-${i}`, ...base, ts: Date.now() };
    i += 1;
    await sleep(config.simIntervalMs);
  }
}

// ----- "live" simulator: an endless, lifelike crowd for the on-air demo -----
// Energy WAVES (calm lulls ⇄ hype surges) so the Mood Engine visibly drifts; a
// steady trickle of fresh newcomers so welcomes keep firing; varied emojis so
// every reaction kind shows; the occasional Super Chat. SOURCE=live to use it.
const HYPE = ["lets gooo 🔥🔥", "this is INSANE 🔥", "🔥🔥🔥", "epic!! ⚡", "POG 🎉", "🤯🤯", "so good omg ⚡", "🥳🥳🥳", "the energy!! 🔥"];
const WARM = ["love this ❤️", "so beautiful ✨", "❤️❤️", "gorgeous 🥰", "this is lovely 💖", "💖💖", "soft and pretty ✨"];
const CALM = ["so chill 🌙", "very relaxing 😌", "peaceful vibes 🍃", "🌊 nice", "cozy 😌", "calm and dreamy 🌙"];
const PLAIN = ["hi everyone", "first time here!", "what is this 👀", "how does it work", "this is cool", "👋", "just vibing", "😂 lol", "🤣 amazing", "whoa 🤯"];
const NAMES = ["nova", "pixel", "echo", "riff", "lumen", "vortex", "gizmo", "flux", "halo", "sol", "zen", "kit", "mox", "wren", "ivy", "juno", "bee", "fox", "sky", "rune", "ash", "dot", "ember", "koi"];
// a few popular themes the simulated crowd will campaign for via "!theme:x" ballots
const VOTE_THEMES = ["forest", "ocean", "synthwave", "aurora", "ember", "frost", "neon"];
// Suno share links the simulated crowd "requests" (the operator's own songs, so
// the demo exercises the queue) + ways listeners show a song some love
const SUNO_LINKS = [
  "https://suno.com/s/i6L6bOSa8hqcgJSq", "https://suno.com/s/Df1Usfrjl53ilzIl",
  "https://suno.com/s/Ds3vKquYkfWr6keP", "https://suno.com/s/epl8OZSyueDkawUc",
  "https://suno.com/s/CpP5WssHaGE680Pp", "https://suno.com/s/jbylIBvANe5Ieffa",
];
const LIKES = ["!like", "❤️", "👍", "this song ❤️", "!like"];

export async function* liveSimulatorSource() {
  let n = 0;
  while (true) {
    const surge = Math.random() < 0.5;
    const msgs = surge ? 8 + ((Math.random() * 8) | 0) : 3 + ((Math.random() * 4) | 0);
    for (let k = 0; k < msgs; k++) {
      n += 1;
      const fresh = Math.random() < 0.4; // ~40% brand-new author → fires a welcome
      const author = "@" + pick(NAMES) + (fresh ? n : 1 + ((Math.random() * 5) | 0));
      const r = Math.random();
      // ~14% theme ballots, ~6% song requests, ~12% song love — the rest is chat.
      // (ballots/requests/likes are consumed, not shown; they drive the panels.)
      const text = r < 0.14
        ? `!theme:${pick(VOTE_THEMES)}`
        : r < 0.20
          ? pick(SUNO_LINKS)
          : r < 0.32
            ? pick(LIKES)
            : surge
              ? (r < 0.62 ? pick(HYPE) : r < 0.82 ? pick(PLAIN) : pick(WARM))
              : (r < 0.5 ? pick(CALM) : r < 0.85 ? pick(PLAIN) : pick(WARM));
      const c = { id: `live-${n}`, author, text };
      // synthetic "typed N ms ago" so the on-scene delay readout looks realistic
      // (real YouTube uses the actual publishedAt timestamp)
      c.ts = Date.now() - (800 + Math.random() * 2200);
      if (Math.random() < 0.06) {
        const t = r < 0.4 ? "small" : r < 0.7 ? "medium" : "large";
        c.superchat = { tier: t, amount: "$5.00" };
        c.avatar = `https://i.pravatar.cc/160?img=${1 + ((Math.random() * 70) | 0)}`; // fake photo for the demo
      }
      yield c;
      await sleep(surge ? 300 + Math.random() * 700 : 1500 + Math.random() * 3500);
    }
    await sleep(2000 + Math.random() * 4000); // breather between waves
  }
}
