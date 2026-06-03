# ingest (Phase 1 — ✅ built)

YouTube Live ingestion + the moderation gate that feeds the streamer's
`/mutate` endpoint.

```
source (simulate | youtube) → moderation → director → POST /mutate
```

- **Runs on Node built-ins** — no `npm install` for the simulator path.
- **Simulator mode** lets the whole reactive loop be tested against a live
  stream with **zero credentials**.
- **Moderation** (layered, cheapest first): rate-limit → spam heuristics →
  regex blocklist → optional Haiku safety classifier (fails closed).
- **Director** maps approved comments → validated SceneAPI directives with
  global + per-action cooldowns. Super Chats arrive in the same YouTube feed
  via `superChatDetails` and map to shoutout tiers (no separate payment infra).
- Every decision is appended to `control/audit.log`.

**Full usage, YouTube OAuth setup, and the tuning backlog:**
[`../../docs/phase1.md`](../../docs/phase1.md).

Quick demo (with the Phase 0 streamer running):
```bash
SOURCE=simulate MAX_EVENTS=15 SIM_INTERVAL_MS=1500 node src/index.js
```

## Next (Phase 2)
Replace `director.js`'s rule-based `parseIntent()` with a Claude call that emits
the same `{action, params}` shape. The moderation gate + cooldown arbitration
stay exactly as they are.
