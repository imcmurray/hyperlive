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

  const pickFiller = (exclude) => {
    const pool = THEMES.filter((t) => !exclude.includes(t));
    return pool[(Math.random() * pool.length) | 0];
  };

  // The candidate set is LOCKED when a round opens (first ballot + random
  // challenger[s] → 2 or 3 fixed options, in a fixed display order). New themes
  // voted mid-round are consumed but ignored — they can't appear or win — so the
  // ballot people see at the start is exactly the ballot that resolves.
  const MIN_OPTS = 2;
  const MAX_OPTS = 3;

  // current tallies in the round's locked candidate order (rows never reorder)
  function options() {
    const counts = new Map();
    for (const t of round.ballots.values()) counts.set(t, (counts.get(t) || 0) + 1);
    return round.candidates.map((key) => ({ key, label: LABELS[key] || key, votes: counts.get(key) || 0 }));
  }
  // highest-voted candidate; ties keep the earlier (opener-first) candidate
  function leader(opts) {
    let best = opts[0];
    for (const o of opts) if (o.votes > best.votes) best = o;
    return best;
  }

  function pushUpdate() {
    const opts = options();
    postMutate({ action: "voteUpdate", params: { options: opts, leader: leader(opts).key } }).catch(() => {});
  }

  function startRound(firstTheme, firstAuthor) {
    // lock 2-3 candidates up front: the opener's theme + random distinct challengers
    const target = MIN_OPTS + ((Math.random() * (MAX_OPTS - MIN_OPTS + 1)) | 0); // 2 or 3
    const candidates = [firstTheme];
    while (candidates.length < target) candidates.push(pickFiller(candidates));
    round = { candidates, ballots: new Map([[firstAuthor, firstTheme]]), timer: null, lastPush: 0 };
    const opts = options();
    postMutate({ action: "voteStart", params: { title: "VOTE THE NEXT THEME", options: opts, leader: firstTheme, durationMs } })
      .catch(() => {});
    round.timer = setTimeout(endRound, durationMs);
    log(`  ⚑ vote round OPEN (${durationMs / 1000}s) — options LOCKED: ${candidates.join(", ")}`);
  }

  function endRound() {
    if (!round) return;
    const opts = options();
    round = null;
    cooldownUntil = Date.now() + cooldownMs;
    const winner = leader(opts);
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
        // only the locked options count; a ballot for any other theme is still
        // consumed (never shown as chat) but does not change the ballot
        if (round.candidates.includes(theme)) {
          round.ballots.set(author, theme); // last vote wins; spamming can't stuff the ballot
          const now = Date.now();
          if (now - round.lastPush > 350) { round.lastPush = now; pushUpdate(); }
        }
      } else if (Date.now() >= cooldownUntil) {
        startRound(theme, author);
      } // else: brief post-round cooldown — ballot is still consumed, just ignored
      return theme;
    },
    stop() { if (round?.timer) clearTimeout(round.timer); round = null; },
    active() { return !!round; },
  };
}
