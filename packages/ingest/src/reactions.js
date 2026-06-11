// The Fun Layer's heart: instant, charming reactions to viewers.
//   1. Emoji → micro-effect: a moderated comment containing a reaction emoji
//      fires a react() directive IMMEDIATELY (bypasses the heavy director
//      cooldown) so cause-and-effect feels magical.
//   2. "The room noticed you": a viewer's FIRST comment triggers a warm,
//      named welcome glow — you arrive and the world acknowledges you.

import { emitAutomation } from "./automations.js";
import { getFeature } from "./features.js";
const EMOJI_REACT = [
  { kind: "fire", emojis: ["🔥", "⚡", "🌶", "🌶️"] },
  { kind: "love", emojis: ["❤", "❤️", "🥰", "😍", "💖", "💕", "♥️", "🩷", "💗"] },
  { kind: "sparkle", emojis: ["✨", "⭐", "🌟", "💫"] },
  { kind: "laugh", emojis: ["😂", "🤣", "😹", "🎉", "🥳"] },
  { kind: "wow", emojis: ["😮", "😲", "🤯", "🙀", "‼", "‼️"] },
  { kind: "calm", emojis: ["🌙", "😌", "🍃", "🌊", "💤"] },
];


export function createReactions({ postMutate, log = () => {}, perReactionMs = 700, welcome = true } = {}) {
  const seen = new Set();   // authors who have chatted before (first-time = welcome)
  let lastReactAt = 0;      // light global rate-limit so emoji floods don't overwhelm

  function detect(text) {
    const t = String(text || "");
    for (const r of EMOJI_REACT) for (const e of r.emojis) if (t.includes(e)) return r.kind;
    return null;
  }

  async function handle(comment, now = Date.now()) {
    const author = comment.author || "viewer";
    const fired = [];

    // 1) first-time welcome — "the room noticed you" (an automation when
    // `welcome` is a provider fn: the dashboard can disable it or swap the
    // animation; a plain boolean keeps the old behavior)
    const auto = typeof welcome === "function" ? welcome() : { enabled: !!welcome, style: "welcome-pop" };
    if (!seen.has(author)) {
      seen.add(author); // first-timers are tracked even when the builtin is off
      emitAutomation("first_message", { who: author });
      if (auto.enabled && getFeature("welcome")) {
        const kind = auto.style === "sparkle" ? "sparkle" : "welcome";
        try { await postMutate({ action: "react", params: { kind, who: author, avatar: comment.avatar || "" } }); fired.push("welcome"); log(`  ♥ WELCOME ${author}`); } catch {}
      }
    }

    // 2) emoji reaction popups (rate-limited globally so it stays delightful) —
    // the active stage can switch these off for a clean look
    const kind = detect(comment.text);
    if (kind && getFeature("popups") && now - lastReactAt >= perReactionMs) {
      lastReactAt = now;
      try { await postMutate({ action: "react", params: { kind, who: kind === "love" ? author : "" } }); fired.push(kind); log(`  ✦ react:${kind} ← ${author}`); } catch {}
    }
    return fired;
  }

  return { handle, detect, seenCount: () => seen.size };
}
