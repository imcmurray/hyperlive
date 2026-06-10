// Tier 2 of the mutation ladder (docs/platform-directions.md §7): a viewer
// types "!card <description>" and Claude AUTHORS real HTML+CSS for it — the
// HyperFrames "Write HTML" model, live. This module only writes the markup;
// safety is layered downstream: the streamer pre-renders it OFF-AIR,
// vision-checks the screenshot, and even then it renders inside a fully
// sandboxed iframe (no scripts, CSP default-src 'none') with a TTL.

import { config } from "./config.js";

const SYSTEM = `You write a single small HTML fragment for a 360x250 pixel "viewer card" shown on a live stream.
A viewer described what they want; build the closest tasteful version with pure HTML + inline CSS.

Hard rules (violations are discarded):
- ONE self-contained fragment. Inline style="" attributes and/or ONE <style> block with classes.
- NO <script>, <iframe>, <img>, <video>, <audio>, <object>, <embed>, <link>, <meta>, <form>, no event handlers (onclick etc), no url() anywhere. The render sandbox blocks all network and scripting — anything external simply won't render.
- Visuals come from: div shapes, borders, border-radius, CSS gradients, box-shadow, text-shadow, transforms, unicode glyphs/emoji, and CSS @keyframes animations (these DO run — use them, subtle motion makes cards feel alive).
- Design for EXACTLY 360x250, transparent or dark background, no scrollbars. Assume a dark stage behind the card.
- Keep total output under 6000 characters.
- Content must be safe for a public broadcast: nothing hateful, sexual, violent, political, or ad-like. If the request can't be honored safely, render a tasteful "couldn't draw that one" card instead.

Output ONLY the HTML fragment — no markdown fences, no commentary.`;

export async function authorCard(description, who) {
  if (!config.anthropicKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(25000), // authoring is slower than classification
      headers: { "content-type": "application/json", "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 2000,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Viewer ${String(who || "someone").slice(0, 40)} asks for: ${String(description).slice(0, 220)}` }],
      }),
    });
    if (!res.ok) { console.error(`[card-author] http ${res.status}`); return null; }
    const data = await res.json();
    let html = (data?.content?.[0]?.text || "").trim()
      .replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "").trim();
    // mirror the streamer's belt-and-braces check so a bad generation fails here
    if (!html || html.length > 16384) return null;
    if (/<\s*(script|iframe|object|embed|link|meta|base|form|img|video|audio)\b|\bon[a-z]+\s*=|url\s*\(/i.test(html)) {
      console.error("[card-author] generation used a disallowed construct — discarded");
      return null;
    }
    return html;
  } catch (e) {
    console.error("[card-author] error:", e.message);
    return null;
  }
}

// "!card a neon dragon breathing fire" → "a neon dragon breathing fire"
export function parseCardCommand(text) {
  const m = String(text ?? "").match(/^!card\s+(.{4,220})/i);
  return m ? m[1].trim() : null;
}
