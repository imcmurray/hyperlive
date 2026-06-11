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

  // --- Tier 2 viewer cards: "!card <description>" → Claude authors HTML →
  // the streamer's vision gate decides. Needs ANTHROPIC_API_KEY twice over
  // (authoring here, vision gate in the streamer container) — so default to
  // on only when a key is present.
  cards: (process.env.CARDS || (process.env.ANTHROPIC_API_KEY ? "on" : "off")).toLowerCase() !== "off",
  cardUrl: (process.env.CARD_URL || (process.env.MUTATE_URL || "http://localhost:8080/mutate").replace(/\/mutate\/?$/, "/card")),
  cardCooldownMs: num(process.env.CARD_COOLDOWN_MS, 60000), // min gap between viewer cards

  // --- Phase 4: moderator dashboard (loopback admin server in this process) ---
  dashboard: (process.env.DASHBOARD || "on").toLowerCase() !== "off",
  adminPort: num(process.env.ADMIN_PORT, 8090),
  // bind address for the admin server. 127.0.0.1 (the default) on the host;
  // the demo container sets 0.0.0.0 because compose publishes the port as
  // 127.0.0.1:8090 on the host side — net exposure is still loopback-only.
  adminBind: process.env.ADMIN_BIND || "127.0.0.1",
  // hold viewer cards for human approval instead of airing on vision-pass
  holdCards: (process.env.HOLD_CARDS || "off").toLowerCase() === "on",
  // streamer control-plane base (the /mutate url minus the path)
  controlBase: (process.env.MUTATE_URL || "http://localhost:8080/mutate").replace(/\/mutate\/?$/, ""),

  // --- Fun Layer: instant emoji reactions + first-time welcome ---
  reactions: (process.env.REACTIONS || "on").toLowerCase() !== "off",
  // on-screen "typed → on-scene" latency readout
  showDelay: (process.env.SHOW_DELAY || "on").toLowerCase() !== "off",

  // --- Stream-like milestones (YouTube video likeCount → celebratory shoutouts) ---
  // distinct from chat hearts, which like the current SONG. youtube source only.
  streamLikes: (process.env.STREAM_LIKES || "on").toLowerCase() !== "off",
  streamLikesPollMs: num(process.env.STREAM_LIKES_POLL_MS, 45000), // videos.list ≈ 1 unit/poll

  // --- YouTube source (only needed when source=youtube). See docs/youtube-oauth.md ---
  yt: {
    // OAuth: refresh token mints access tokens automatically (24/7, no human).
    clientId: process.env.YT_CLIENT_ID || "",
    clientSecret: process.env.YT_CLIENT_SECRET || "",
    refreshToken: process.env.YT_REFRESH_TOKEN || "",
    // optional overrides: pin a chat id, or supply a short-lived token directly
    liveChatId: process.env.YT_LIVE_CHAT_ID || "", // blank = auto-discover the active broadcast
    videoId: process.env.YT_VIDEO_ID || "",        // blank = auto-discover (for stream-like polling)
    accessToken: process.env.YT_ACCESS_TOKEN || "", // bypass refresh (manual/testing only)
    // Adaptive polling: poll fast while chat is active, back off when it's quiet
    // — far fewer calls/day than a fixed interval. (list = ~5 units/call,
    // 10k units/day cap.) We never poll faster than YouTube's pollingIntervalMillis.
    pollActiveMs: num(process.env.YT_POLL_ACTIVE_MS, 8000),  // when messages are flowing
    pollIdleMs: num(process.env.YT_POLL_IDLE_MS, 60000),     // ramps to this when quiet
    minPollMs: num(process.env.YT_MIN_POLL_MS, 8000),        // absolute floor (legacy)
    // Safety: stop polling once we've spent this many quota units today, so we
    // can't exceed the daily cap. Resets at midnight Pacific (YouTube's reset).
    quotaLimit: num(process.env.YT_QUOTA_LIMIT, 9000),
    unitsPerCall: num(process.env.YT_UNITS_PER_CALL, 5),
  },

  // --- run control ---
  maxEvents: num(process.env.MAX_EVENTS, 0), // 0 = run until killed; >0 = stop after N source events (demo)
  simIntervalMs: num(process.env.SIM_INTERVAL_MS, 1800),
  // NB: ./state/, not ./control/ — control/ is root-owned (container writes
  // it), so the host-run ingest's audit appends there failed SILENTLY for the
  // project's whole life (audit() swallows errors by design).
  auditLog: process.env.AUDIT_LOG || "./state/audit.log",
};
