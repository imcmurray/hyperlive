# Phase 1 — Chat → Moderation → Director → Live scene

**Goal:** turn the manually-driven Phase 0 stream into one that reacts to
**moderated** audience input. Comments (and Super Chats) flow through a safety
gate, become validated SceneAPI directives, and hit the same `/mutate` endpoint
Phase 0 already proved.

```
source ──► moderation gate ──► director ──► POST /mutate ──► live scene
(sim |        (rate-limit →     (intent →     (Phase 0
 youtube)      blocklist →       validated      streamer)
               LLM safety)       directive +
                                 cooldowns)
```

Lives in `packages/ingest/`. Runs on Node built-ins — **no `npm install`
required** for the simulator path.

## Run it against the live stream (no credentials)

With the Phase 0 streamer up (`docker compose up`), in another terminal:

```bash
# scripted demo: drives the live scene, then stops after the script
SOURCE=simulate MAX_EVENTS=15 SIM_INTERVAL_MS=1500 node packages/ingest/src/index.js

# or run the simulator continuously
SOURCE=simulate node packages/ingest/src/index.js
```

The simulator includes messages that *should* be blocked (profanity, a scam
link, a rate-limit flood) plus two fake Super Chats, so you can watch every
moderation layer act. Decisions are also appended to `control/audit.log`.

## Moderation layers (order matters — cheapest first)

1. **Rate limit** — `RATE_LIMIT_PER_MIN` (default 4) msgs/author/60s.
2. **Spam heuristics** — length cap, all-caps, char-flooding.
3. **Hard blocklist** — regex for profanity/slur stems, links, scam phrases.
   *Starter list only* — a real deployment loads a maintained list from file.
4. **LLM safety classifier** *(optional)* — a cheap Haiku call; **fails closed**
   (blocks when uncertain). Enable with:
   ```bash
   MODERATION_LLM=anthropic ANTHROPIC_API_KEY=sk-ant-... \
   SOURCE=simulate node packages/ingest/src/index.js
   ```

## Director intents (rule-based in Phase 1)

| Comment | Directive |
|---|---|
| Super Chat (any) | `addShoutout` at tier (YT tier 1→small, 2-3→medium, 4-5→large) |
| `theme: forest` / a theme word (`synthwave/sunrise/mono/forest/aurora/ember` + aliases) | `setTheme` (smooth crossfade) |
| effect word (`particles/stars/snow`, `rays/beams`, `crt/scanlines`, `grain/noise`, `vignette`); add "off"/"no" to disable | `setEffect` |
| `headline: <text>` | `setHeadline` |
| hype (`gg`, `lets go`, `🔥`) | `burst` |
| anything else | `addShoutout` (small) echoing the text |

> See [`docs/visuals.md`](visuals.md) for the full directive reference, the
> visual system, and copy-paste test commands.

Arbitration: a **global cooldown** (`GLOBAL_COOLDOWN_MS`, 2.5s) between any two
applied directives, plus a longer **heavy cooldown** (`HEAVY_COOLDOWN_MS`, 12s)
for theme/headline changes, so chat can't thrash the scene.

> In Phase 2 the `parseIntent()` function is replaced by a Claude call that
> emits the same `{action, params}` shape. The allowlist + cooldown machinery
> around it does not change.

## Going live on real YouTube chat (`SOURCE=youtube`)

You need two things: an **OAuth access token** and the broadcast's **liveChatId**.

1. **Google Cloud project** → enable **YouTube Data API v3**.
2. **OAuth consent + credentials** (OAuth client, "Desktop" type). Scope:
   `https://www.googleapis.com/auth/youtube.readonly` (reading chat) — or
   `youtube.force-ssl` if you later also moderate via the API.
3. **Get an access token.** Quickest for testing: the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) →
   authorize the YouTube scope → exchange for an access token. (Tokens expire
   in ~1h; a refresh-token flow is a Phase 4 hardening item.)
4. **Get the liveChatId** of your active broadcast:
   ```bash
   curl -s "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all" \
     -H "Authorization: Bearer $TOKEN" | jq '.items[].snippet.liveChatId'
   ```
5. Run:
   ```bash
   SOURCE=youtube \
   YT_ACCESS_TOKEN=ya29.... \
   YT_LIVE_CHAT_ID=Cg0KC... \
   node packages/ingest/src/index.js
   ```

The poller respects the API's `pollingIntervalMillis` (quota is tight — the
chat endpoint costs ~5 units/call; the daily default is 10k units), skips the
historical backlog on first poll, and parses `superChatDetails` from the same
feed (no separate payment processor — that was the Phase-0 design decision).

## Tuning backlog (observed in the first live demo)

- [x] All-caps heuristic blocked short hype like "LETS GOOOO" → now exempts
      messages under 24 chars (also unblocks the hype→`burst` intent). *(fixed)*
- [ ] Generic comments echo verbatim into shoutout cards (rules mode) → the
      Phase 2 LLM director addresses this by choosing `ignore` for chit-chat;
      for rules mode, consider requiring an intent keyword.
- [ ] Vendor a maintained blocklist from file rather than the inline starter set.
- [ ] Access-token refresh for unattended `SOURCE=youtube` runs.
