// Visual-safety gate for model-authored markup (Tier 2/3 of the mutation
// ladder, docs/platform-directions.md §7). Text moderation can't catch "a slur
// drawn out of div borders" — so candidate cards are rendered OFF-AIR (a
// separate Puppeteer page the screencast can never capture), screenshotted,
// and the screenshot is judged by a cheap vision model before anything is
// allowed on the broadcast. Fails CLOSED: no key / API error / timeout / weird
// output all mean "not safe".

const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.VISION_MODEL || "claude-haiku-4-5-20251001";

export const visionEnabled = !!KEY;

const SYSTEM =
  "You are a strict visual-safety gate for imagery about to appear on a PUBLIC live YouTube broadcast. " +
  "Block hate symbols or slurs (including ones drawn with shapes, borders, or ASCII), sexual or violent imagery, " +
  "harassment or doxxing, scams/advertising, and anything brand-unsafe. A plain, ugly, or boring image is SAFE — " +
  "you judge safety, not quality. Reply ONLY with compact JSON: {\"safe\": true|false, \"reason\": \"<=8 words\"}. " +
  "Default to safe:false when unsure.";

export async function visionCheck(pngBase64, context) {
  if (!KEY) return { safe: false, reason: "no ANTHROPIC_API_KEY" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 80,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
            { type: "text", text: `This is ${context}, rendered exactly as it would appear on stream. Safe to broadcast?` },
          ],
        }],
      }),
    });
    if (!res.ok) return { safe: false, reason: `vision http ${res.status}` };
    const data = await res.json();
    const m = (data?.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
    if (!m) return { safe: false, reason: "unparseable verdict" };
    const v = JSON.parse(m[0]);
    return { safe: v.safe === true, reason: String(v.reason || "") };
  } catch {
    return { safe: false, reason: "vision check failed" };
  }
}
