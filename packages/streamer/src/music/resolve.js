// Resolve a Suno SHARE link (a web page) into a playable audio stream + title.
//
// A "https://suno.com/s/XXXX" link is an HTML page; the actual song lives on
// Suno's CDN as "https://cdn1.suno.ai/<uuid>.mp3". We fetch the page and extract
// that URL. SAFETY: we only ever hand ffmpeg a URL on the suno.ai CDN (strict
// allowlist) so a chat link can never make the player fetch an arbitrary host.
// Suno has no public API, so this HTML scrape is intentionally defensive and
// fails closed — a resolve failure just means the song isn't queued.

// accept the /s/ short share link AND the /song/<uuid> song-page URL; resolveSuno
// scrapes either the same way (the short link just redirects to the song page)
const SHARE_RE = /https?:\/\/(?:www\.)?suno\.com\/(?:s\/[A-Za-z0-9]+|song\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// a real clip is a uuid (8-4-4-4-12); this won't match the "sil-100.mp3" silence stub
const CDN_RE = /https?:\/\/cdn\d*\.suno\.ai\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3/gi;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// pull the first suno share link out of arbitrary comment text (or null)
export function parseSunoShare(text) {
  const m = String(text ?? "").match(SHARE_RE);
  return m ? m[0] : null;
}

// decode the handful of HTML entities that show up in page titles
function decodeEntities(s) {
  return String(s)
    .replace(/&#x27;|&#39;/gi, "'").replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/");
}

// true only for the suno.ai CDN — the gate before any URL reaches the player
export function isPlayableSunoUrl(u) {
  return typeof u === "string" && /^https:\/\/cdn\d*\.suno\.ai\/[0-9a-f-]{36}\.mp3$/i.test(u);
}

export async function resolveSuno(shareUrl, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
  if (!SHARE_RE.test(shareUrl)) return { ok: false, error: "not a suno share link" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(shareUrl, { headers: { "user-agent": UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const html = await res.text();

    const audioUrl = (html.match(CDN_RE) || [])[0] || null;
    if (!isPlayableSunoUrl(audioUrl)) return { ok: false, error: "no audio on page" };

    // "<title>Song Name by artist | Suno</title>" → { title, artist }
    let title = "Unknown", artist = "Suno";
    const tm = html.match(/<title>([^<]*)<\/title>/i);
    if (tm) {
      const m2 = tm[1].match(/^(.*?)\s+by\s+(.*?)\s*\|\s*Suno/i);
      if (m2) { title = m2[1].trim(); artist = m2[2].trim(); }
      else title = tm[1].replace(/\s*\|\s*Suno.*$/i, "").trim() || title;
    }

    // cover art via og:image. The security gate is the HOST (must be the suno.ai
    // CDN, no arbitrary host); the filename varies a lot — bare uuid, _suffix,
    // image_<uuid>, image_large_<uuid> — so allow any image filename there.
    const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "";
    const image = /^https:\/\/cdn\d*\.suno\.ai\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(og) ? og : "";

    return { ok: true, audioUrl, image, title: decodeEntities(title), artist: decodeEntities(artist), share: shareUrl };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}
