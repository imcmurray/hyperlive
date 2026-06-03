// Layered moderation gate. Order matters — cheapest/hardest filters first,
// the (optional, paid) LLM safety classifier last.
//
//   rate-limit per author  →  hard regex blocklist  →  LLM safety classifier
//
// Only messages that survive every layer reach the Director. Everything is
// returned with a reason so the caller can audit-log the decision.

import { config } from "./config.js";

// Starter blocklist. A real deployment should load a maintained list from a
// file (slurs, brand-unsafe terms, scam patterns) — this is intentionally
// small and conservative; the LLM layer is the real safety net.
const BLOCK_PATTERNS = [
  /\bf+u+c+k+/i,
  /\bs+h+i+t+/i,
  /\bb+i+t+c+h+/i,
  /\bn[i1]gg/i, // slur stem
  /\bf[a4]g/i, // slur stem
  /\bk[i1]ll\s+(yourself|urself)\b/i,
  /https?:\/\/\S+/i, // no links (spam/scam vector)
  /\b(free\s+v-?bucks|crypto\s+giveaway|t\.me\/|discord\.gg\/)\b/i,
];

// crude "shouting/spam" heuristics
function looksSpammy(text) {
  if (text.length > 200) return "too long";
  const letters = text.replace(/[^a-z]/gi, "");
  // only flag all-caps on longer messages — short hype like "LETS GOOOO" is fine
  if (text.length > 24 && letters.length >= 8) {
    const caps = (text.match(/[A-Z]/g) || []).length;
    if (caps / letters.length > 0.8) return "all caps";
  }
  if (/(.)\1{7,}/.test(text)) return "char flooding";
  return null;
}

export function createModerator() {
  const hits = new Map(); // author -> [timestamps]

  function rateLimited(author, now) {
    const windowStart = now - 60_000;
    const arr = (hits.get(author) || []).filter((t) => t > windowStart);
    arr.push(now);
    hits.set(author, arr);
    return arr.length > config.ratePerMin;
  }

  async function llmSafe(text) {
    // Cheap Haiku classifier. Returns { block, reason }. Fails OPEN-to-block on
    // error (when uncertain, drop — safer for a public broadcast).
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.anthropicModel,
          max_tokens: 60,
          system: [
            {
              type: "text",
              text:
                "You are a strict content-safety gate for text shown as a caption on a PUBLIC live YouTube broadcast. " +
                "Block anything hateful, harassing, sexual, violent, self-harm-related, doxxing, spam/scam, or otherwise brand-unsafe. " +
                'Reply ONLY with compact JSON: {"block": true|false, "reason": "<=6 words"}. Default to block when unsure.',
              cache_control: { type: "ephemeral" }, // cache the system prompt across calls
            },
          ],
          messages: [{ role: "user", content: `Message: ${text}` }],
        }),
      });
      if (!res.ok) return { block: true, reason: `llm http ${res.status}` };
      const data = await res.json();
      const txt = (data?.content?.[0]?.text || "").trim();
      const m = txt.match(/\{[\s\S]*\}/);
      const verdict = m ? JSON.parse(m[0]) : { block: true, reason: "unparseable" };
      return { block: !!verdict.block, reason: String(verdict.reason || "llm") };
    } catch (e) {
      return { block: true, reason: "llm error" };
    }
  }

  return {
    /** @returns {Promise<{allowed:boolean, reason:string, text:string}>} */
    async moderate(comment, now = Date.now()) {
      const author = comment.author || "anon";
      const text = String(comment.text || "").trim();

      if (!text) return { allowed: false, reason: "empty", text };
      if (rateLimited(author, now)) return { allowed: false, reason: "rate limit", text };

      const spam = looksSpammy(text);
      if (spam) return { allowed: false, reason: spam, text };

      for (const re of BLOCK_PATTERNS) {
        if (re.test(text)) return { allowed: false, reason: "blocklist", text };
      }

      if (config.moderationLLM === "anthropic" && config.anthropicKey) {
        const v = await llmSafe(text);
        if (v.block) return { allowed: false, reason: `llm:${v.reason}`, text };
      }

      return { allowed: true, reason: "ok", text };
    },
  };
}
