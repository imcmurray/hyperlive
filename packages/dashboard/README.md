# dashboard — the moderator console (Phase 4)

A single self-contained `index.html` (no build step, no CDNs — renders on an
air-gapped loopback box) served by the ingest's admin server
(`packages/ingest/src/admin.js`) at `http://127.0.0.1:8090/`. Loopback only;
remote mods tunnel in (Tailscale/SSH).

## What's on it

- **Preflight modal** — auto-opens at console entry (once per tab session) and
  runs the pre-stream go/no-go server-side: streamer scene + encoder up,
  YouTube refresh token actually mints an access token, an ACTIVE broadcast
  exists, its live chat is readable (a real `liveChatMessages.list` call, ~5
  quota units), Anthropic key valid (free `/v1/models` probe), quota headroom.
  All green → closes itself; anything failed stays up with fix instructions.
  Re-run any time with the header **✓ PREFLIGHT** button — e.g. right before
  Go Live. Auth failures can't be fixed *from* the dashboard (the OAuth consent
  flow is interactive and the refresh token lives in `.env`); the modal tells
  you exactly what to run (`node packages/ingest/src/youtube-auth.js`).
- **Header stream stats** — 👁 concurrent viewers · ⚑ subscribers · ⏱ time on
  air. Viewers + start time ride the same `videos.list` poll as the like
  milestones (no extra quota); subscribers add a `channels.list` (~1 unit)
  every ~6 minutes. YouTube source only — the simulator shows uptime (since
  ingest start) and hides the rest. `STREAM_STATS=off` disables the polling.
- **Live moderation feed** — every comment's journey (applied / blocked / held
  / music / vote / superchat), with filters, search, pause, hover-freeze,
  in-row ban menus, and mod replay of cooldown-skipped comments.
  **First-time chatters glow blue with a NEW badge** (first appearance ever +
  a 5-minute grace window) so the host can call them out; the **✦ NEW** filter
  chip shows only them (works in the USERS view too). First-seen times persist
  in `state/first-seen.json`, so a mid-stream ingest restart doesn't re-flag
  regulars. **Clicking a NEW badge** puts a small welcome shoutout card on
  stage (`POST /admin/callout` → the same allowlisted `addShoutout` action) —
  the on-screen callout for when the host is mid-flow.
- **YT FEED watchdog LED** (youtube source) — green while chat polls succeed;
  amber when polls go silent, quota-paused, or pre–Go Live; **red when OAuth
  token refresh starts failing** (the poller retries quietly forever — this is
  how a mod finds out). Hover for details + the recovery command.
- **Quota burn-rate ETA** — the header's `YT n/9000u` counter projects the
  current burn forward and shows `cap ~HH:MM` (amber) only when the daily cap
  would land *before* the midnight-Pacific reset, i.e. a mid-show chat outage.
- **Kill switch** — clear all model-generated content from the stage (armed
  double-click).
- **Show/music transport**, **stages**, **automations**, **users directory**,
  **review queue** (hold-for-review cards with edit-in-place), **asset
  library**, **compose** — see `docs/live-ops.md` for the verbs behind them.

## Relevant env (ingest side)

| var | default | meaning |
| --- | --- | --- |
| `DASHBOARD` | `on` | serve the console + admin API |
| `ADMIN_PORT` | `8090` | loopback admin port |
| `HOLD_CARDS` | `off` | viewer cards queue for human approval |
| `STREAM_LIKES` | `on` | like-milestone celebrations (videos.list poll) |
| `STREAM_STATS` | `on` | header viewers/subs/uptime (shares the same poll) |
| `STREAM_LIKES_POLL_MS` | `45000` | poll cadence for both of the above |
