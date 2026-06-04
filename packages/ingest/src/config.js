// All config via env so nothing secret is committed.
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  // where approved directives are POSTed (the Phase 0 streamer control plane)
  mutateUrl: process.env.MUTATE_URL || "http://localhost:8080/mutate",

  // comment source: "simulate" (no creds) | "youtube" (needs OAuth + liveChatId)
  source: (process.env.SOURCE || "simulate").toLowerCase(),

  // director intent engine: "rules" (deterministic) | "llm" (Claude composes
  // the directive). "llm" falls back to "rules" if no ANTHROPIC_API_KEY.
  director: (process.env.DIRECTOR || "rules").toLowerCase(),

  // --- moderation ---
  // LLM safety layer: "off" (regex/rate-limit only) | "anthropic"
  moderationLLM: (process.env.MODERATION_LLM || "off").toLowerCase(),
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  ratePerMin: num(process.env.RATE_LIMIT_PER_MIN, 4), // msgs/user/60s before throttle

  // --- director arbitration ---
  globalCooldownMs: num(process.env.GLOBAL_COOLDOWN_MS, 2500), // min gap between any 2 applied directives
  heavyCooldownMs: num(process.env.HEAVY_COOLDOWN_MS, 12000),  // min gap for theme/headline changes

  // --- Collective Mood Engine (the periodic aggregate "Mood Conductor" loop) ---
  mood: (process.env.MOOD || "on").toLowerCase() !== "off", // on by default
  moodTickMs: num(process.env.MOOD_TICK_MS, 7000),          // how often the Conductor recomputes
  moodWindowMs: num(process.env.MOOD_WINDOW_MS, 75000),     // rolling aggregate window
  moodLLM: ["on", "anthropic", "true"].includes((process.env.MOOD_LLM || "off").toLowerCase()), // else rules-based

  // --- Collective theme voting (!theme:x ballots → countdown round → winner) ---
  votes: (process.env.VOTES || "on").toLowerCase() !== "off",
  // A round must outlast the round-trip: YouTube buffers the stream ~20-30s, so a
  // viewer only SEES the vote ~30s after it opens, then their ballot takes a few
  // more seconds to come back. Duration ≈ broadcast delay + an actual voting
  // window, or delayed viewers get no chance to vote. 75s = ~30s delay + ~45s.
  voteDurationMs: num(process.env.VOTE_DURATION_MS, 75000),
  voteCooldownMs: num(process.env.VOTE_COOLDOWN_MS, 8000),  // gap before a new round can open

  // --- Music: Suno-link requests + per-song likes (forwarded to the streamer) ---
  music: (process.env.MUSIC || "on").toLowerCase() !== "off",
  // streamer music control plane — same host as /mutate, under /music
  musicUrl: (process.env.MUSIC_URL || (process.env.MUTATE_URL || "http://localhost:8080/mutate").replace(/\/mutate\/?$/, "/music")),

  // --- Fun Layer: instant emoji reactions + first-time welcome ---
  reactions: (process.env.REACTIONS || "on").toLowerCase() !== "off",
  // on-screen "typed → on-scene" latency readout
  showDelay: (process.env.SHOW_DELAY || "on").toLowerCase() !== "off",

  // --- YouTube source (only needed when source=youtube) ---
  yt: {
    liveChatId: process.env.YT_LIVE_CHAT_ID || "",
    accessToken: process.env.YT_ACCESS_TOKEN || "", // short-lived OAuth token (see docs/phase1.md)
  },

  // --- run control ---
  maxEvents: num(process.env.MAX_EVENTS, 0), // 0 = run until killed; >0 = stop after N source events (demo)
  simIntervalMs: num(process.env.SIM_INTERVAL_MS, 1800),
  auditLog: process.env.AUDIT_LOG || "./control/audit.log",
};
