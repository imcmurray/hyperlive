// Chat → music: detect a Suno share link (queue it) or a "like" (heart the
// current song) and forward to the streamer's music control plane. The link is
// only PARSED here; the streamer resolves + CDN-allowlists it before playing.

const SHARE_RE = /https?:\/\/suno\.com\/s\/[A-Za-z0-9]+/;
const LIKE_RE = /^\s*!\s*like\s*$/i;                 // explicit "like the song" command
const HEART_RE = /[❤♥\u{1F49B}-\u{1F49F}\u{1F44D}]|❤️/u; // hearts / thumbs-up

export function parseSunoShare(text) {
  const m = String(text ?? "").match(SHARE_RE);
  return m ? m[0] : null;
}
export function isLikeCommand(text) { return LIKE_RE.test(String(text ?? "")); }
export function hasHeart(text) { return HEART_RE.test(String(text ?? "")); }

export function createMusic({ baseUrl }) {
  async function post(path, body) {
    try {
      const r = await fetch(baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return await r.json().catch(() => ({ ok: false }));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return {
    enqueue: (link, who) => post("/enqueue", { link, who }),
    like: (who) => post("/like", { who }),
  };
}
