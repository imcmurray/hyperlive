// The Fun Layer's heart: instant, charming reactions to viewers.
//   1. Emoji → micro-effect: a moderated comment containing a reaction emoji
//      fires a react() directive IMMEDIATELY (bypasses the heavy director
//      cooldown) so cause-and-effect feels magical.
//   2. "The room noticed you": a viewer's FIRST comment triggers a warm,
//      named welcome glow — you arrive and the world acknowledges you.

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

    // 1) first-time welcome — "the room noticed you"
    if (welcome && !seen.has(author)) {
      seen.add(author);
      try { await postMutate({ action: "react", params: { kind: "welcome", who: author, avatar: comment.avatar || "" } }); fired.push("welcome"); log(`  ♥ WELCOME ${author}`); } catch {}
    }

    // 2) emoji reaction (rate-limited globally so it stays delightful, not chaotic)
    const kind = detect(comment.text);
    if (kind && now - lastReactAt >= perReactionMs) {
      lastReactAt = now;
      try { await postMutate({ action: "react", params: { kind, who: kind === "love" ? author : "" } }); fired.push(kind); log(`  ✦ react:${kind} ← ${author}`); } catch {}
    }
    return fired;
  }

  return { handle, detect, seenCount: () => seen.size };
}
