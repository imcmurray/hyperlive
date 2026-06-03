// Rolling-window aggregator for the Collective Mood Engine.
// Pure + synchronous: the per-comment loop feeds it via record(); the Mood
// Conductor reads cheap, no-LLM signals via snapshot(). No async, no fetch —
// trivially unit-testable.

const EMOJI = {
  hype: ["🔥", "⚡", "🚀", "💯", "🎉", "😤", "‼️", "🙌"],
  warm: ["❤️", "😍", "✨", "🥰", "🌸", "💖", "☺️", "😊"],
  calm: ["🌙", "💤", "🌊", "🍃", "☁️", "🕊️", "😌"],
  tense: ["😱", "💀", "😨", "⚠️", "🥶", "👀"],
};

// crude per-message sentiment from emojis + a few word cues
function classify(text) {
  const raw = String(text || "");
  const t = raw.toLowerCase();
  const c = { hype: 0, warm: 0, calm: 0, tense: 0 };
  for (const k of Object.keys(EMOJI)) for (const e of EMOJI[k]) if (raw.includes(e)) c[k] += 1;
  if (/\b(love|beautiful|gorgeous|warm|cozy|stunning|pretty)\b/.test(t)) c.warm += 1;
  if (/\b(hype|lets?\s*go+|fire|insane|epic|pog|sick|wild|amazing|goated)\b/.test(t)) c.hype += 1;
  if (/\b(calm|chill|peace|relax|serene|gentle|soft|cozy|zen)\b/.test(t)) c.calm += 1;
  if (/\b(scary|creepy|dark|eerie|tense|ominous|spooky|haunting)\b/.test(t)) c.tense += 1;
  if ((raw.match(/!/g) || []).length >= 2) c.hype += 1;
  return c;
}

export function createMoodState({ windowMs = 75000 } = {}) {
  const buf = []; // { t, author, cls, sc } oldest-first

  function prune(now) {
    const cut = now - windowMs;
    while (buf.length && buf[0].t < cut) buf.shift();
  }

  function record(comment, now = Date.now()) {
    buf.push({
      t: now,
      author: comment.author || "anon",
      cls: classify(comment.text),
      sc: comment.superchat ? Number(comment.superchat.ytTier || comment.superchat.tier || 1) || 1 : 0,
    });
    prune(now);
  }

  function snapshot(now = Date.now()) {
    prune(now);
    const n = buf.length;
    const winSec = windowMs / 1000;
    const rate = n / winSec; // msgs/sec across the window

    // acceleration: recent quarter-window rate vs full-window rate (>1 = speeding up)
    const qCut = now - windowMs / 4;
    const recentN = buf.reduce((a, e) => a + (e.t >= qCut ? 1 : 0), 0);
    const recentRate = recentN / (winSec / 4);
    const accel = rate > 0.01 ? recentRate / rate : 0;

    const sentiment = { hype: 0, warm: 0, calm: 0, tense: 0 };
    const authors = new Set();
    let scCount = 0, scWeight = 0;
    for (const e of buf) {
      sentiment.hype += e.cls.hype; sentiment.warm += e.cls.warm;
      sentiment.calm += e.cls.calm; sentiment.tense += e.cls.tense;
      authors.add(e.author);
      if (e.sc) { scCount += 1; scWeight += e.sc; }
    }
    return { n, rate, recentRate, accel, sentiment, uniqueAuthors: authors.size, scCount, scWeight };
  }

  return { record, snapshot, size: () => buf.length, _classify: classify };
}
