// Collective theme voting. Comments like "!theme:forest" are BALLOTS, not
// messages — they're consumed here (never shown on screen) and drive a vote
// round instead. A round opens on the first ballot, runs for a countdown, and
// the winning theme is applied. One vote per author (last vote wins). Only
// known theme keys count; everything the scene renders comes from this trusted
// label map, so a ballot can't inject arbitrary text onto the stream.

import { config } from "./config.js";

// must stay in sync with the scene's THEMES (packages/streamer/scene/scene.js)
const THEMES = [
  "synthwave", "sunrise", "mono", "forest", "aurora", "ember",
  "midnight", "vapor", "matrix", "gold", "crimson",
  "neon", "dusk", "ocean", "lava", "frost", "glitch", "retro", "void", "plasma", "noir", "solar", "holo",
];
const THEME_ALIASES = {
  cyberpunk: "neon", dawn: "dusk", sunset: "dusk", twilight: "dusk",
  grey: "mono", gray: "mono", nature: "forest",
  northern: "aurora", coal: "ember", warm: "ember",
  night: "midnight", vaporwave: "vapor", pastel: "vapor", miami: "vapor",
  terminal: "matrix", hacker: "matrix", code: "matrix", royal: "gold", luxury: "gold",
  red: "crimson", blood: "crimson", underwater: "ocean", sea: "ocean",
  molten: "lava", volcano: "lava", ice: "frost", icy: "frost", cold: "frost",
  corrupted: "glitch", vhs: "glitch", space: "void", stars: "void",
  electric: "plasma", energy: "plasma", noire: "noir", bright: "solar", sun: "solar",
  holographic: "holo", hologram: "holo",
};
const LABELS = {
  synthwave: "Synthwave", sunrise: "Sunrise", mono: "Mono", forest: "Forest",
  aurora: "Aurora", ember: "Ember", midnight: "Midnight", vapor: "Vapor",
  matrix: "Matrix", gold: "Gold", crimson: "Crimson", neon: "Neon", dusk: "Dusk",
  ocean: "Ocean", lava: "Lava", frost: "Frost", glitch: "Glitch", retro: "Retro",
  void: "Void", plasma: "Plasma", noir: "Noir", solar: "Solar", holo: "Holo",
};

// "!theme:forest" / "!theme forest" / "!theme = forest" — the whole comment must
// be the command (so normal chat mentioning a theme word isn't swallowed).
const VOTE_RE = /^\s*!\s*theme\s*[:=\s]\s*([a-z0-9]+)\s*$/i;

export function parseThemeVote(text) {
  const m = String(text ?? "").match(VOTE_RE);
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (THEMES.includes(key)) return key;
  const alias = THEME_ALIASES[key];
  return alias && THEMES.includes(alias) ? alias : null;
}

export function createVotes({ postMutate, log = () => {} }) {
  const durationMs = config.voteDurationMs;
  const cooldownMs = config.voteCooldownMs;
  let round = null;          // { ballots: Map<author,theme>, timer, lastPush }
  let cooldownUntil = 0;

  function options(limit = 5) {
    const counts = new Map();
    for (const t of round.ballots.values()) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()]
      .map(([key, votes]) => ({ key, label: LABELS[key] || key, votes }))
      .sort((a, b) => b.votes - a.votes || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  function pushUpdate() {
    const opts = options();
    postMutate({ action: "voteUpdate", params: { options: opts, leader: opts[0]?.key || null } })
      .catch(() => {});
  }

  function startRound(firstTheme, firstAuthor) {
    round = { ballots: new Map([[firstAuthor, firstTheme]]), timer: null, lastPush: 0 };
    const opts = options();
    postMutate({ action: "voteStart", params: { title: "VOTE THE NEXT THEME", options: opts, leader: firstTheme, durationMs } })
      .catch(() => {});
    round.timer = setTimeout(endRound, durationMs);
    log(`  ⚑ vote round OPEN (${durationMs / 1000}s) — first ballot: ${firstTheme}`);
  }

  function endRound() {
    if (!round) return;
    const opts = options();
    round = null;
    cooldownUntil = Date.now() + cooldownMs;
    if (!opts.length) { postMutate({ action: "voteEnd", params: {} }).catch(() => {}); return; }
    const winner = opts[0];
    log(`  ⚑ vote WON: ${winner.key} (${winner.votes} vote${winner.votes === 1 ? "" : "s"})`);
    postMutate({ action: "voteEnd", params: { winner: winner.key, winnerLabel: winner.label, votes: winner.votes, options: opts } })
      .catch(() => {});
    // apply the theme after a beat, so the winner highlight is seen first
    setTimeout(() => postMutate({ action: "transitionTheme", params: { theme: winner.key, duration: 2.5 } }).catch(() => {}), 900);
  }

  return {
    // returns the theme key if the comment was a ballot (so the caller consumes
    // it and shows nothing), or null if it's an ordinary comment.
    handle(comment) {
      const theme = parseThemeVote(comment.text);
      if (!theme) return null;
      const author = comment.author || "anon";
      if (round) {
        round.ballots.set(author, theme); // last vote wins; spamming can't stuff the ballot
        const now = Date.now();
        if (now - round.lastPush > 350) { round.lastPush = now; pushUpdate(); }
      } else if (Date.now() >= cooldownUntil) {
        startRound(theme, author);
      } // else: brief post-round cooldown — ballot is still consumed, just ignored
      return theme;
    },
    stop() { if (round?.timer) clearTimeout(round.timer); round = null; },
    active() { return !!round; },
  };
}
