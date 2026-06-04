# Live Ops — running the show with `live.sh`

`scripts/live.sh` is the single control surface for a HyperLive broadcast. It
manages the **streamer container** (Xvfb + Chromium + ffmpeg + the auto-DJ) and
the **chat ingest** (YouTube chat → moderation → director → the scene), plus the
music and show-staging controls. There's also a **JSON API** so another system
can drive everything programmatically.

> One-time setup (Google OAuth, `.env`) is in [youtube-oauth.md](./youtube-oauth.md).
> Run everything from the repo root.

## TL;DR — a typical show

```bash
scripts/live.sh boot      # streamer container up + chat ingest running
scripts/live.sh intro     # "Stream starting shortly" screen (music plays under it)
#   …prep, line up songs…
scripts/live.sh onair     # reveal the live show (music fades up)
#   …the show: viewers vote themes, paste Suno links, like songs…
scripts/live.sh status    # health, now-playing, queue, quota — at a glance
scripts/live.sh outro     # "Thanks for listening" screen (music fades out over ~6s)
scripts/live.sh down      # stop the ingest + the container
```

## Command reference

### Lifecycle (the streamer container)
| Command | Does |
|---|---|
| `boot` | **Everything on**: `up` the container (waits for health) + `start` the ingest |
| `down` | **Everything off**: stop the ingest + `docker compose down` |
| `up` | Start just the streamer container |
| `build` | Rebuild + start the container (after code changes) |

### Chat ingest (the crowd)
| Command | Does |
|---|---|
| `start` | (Re)start just the chat ingest — always single-instance |
| `stop` | Stop just the chat ingest |
| `restart` | `stop` + `start` |

### Status & logs
| Command | Does |
|---|---|
| `status` | Container up/down, ingest running?, stream health, now-playing, full queue, today's quota |
| `logs` | Tail the ingest log |

### Music
| Command | Does |
|---|---|
| `now` | What's playing — title / artist / requester / ♥ likes / queue depth / cover |
| `queue` | List up-next: viewer requests, then the **house rotation** (`→` marks what's next) |
| `queue <url> [who]` | Operator: queue a Suno song directly (resolves + shows the cover first) |
| `next` (alias `skip`) | Move onto the next song |

### Show staging
| Command | Does |
|---|---|
| `intro` | "Stream starting shortly" landing screen (music keeps playing) |
| `outro` | "Thanks for listening" landing screen + **slow music fade-out** (~6s) |
| `onair` | Reveal the live show + fade the music back up |

The landing screens are a frosted near-opaque overlay (the live scene is hidden
behind a soft ambient glow). `STANDBY_ON_BOOT=true` brings the streamer up on the
intro screen, holding until you run `onair`.

## JSON API — driving the show from another system

`live.sh json '<json>'` (→ `scripts/live-api.mjs`) takes **one JSON command in**
and returns **one JSON object out**. It covers the runtime surface (read state +
drive the scene/music); container/ingest lifecycle stays in the CLI above.

```bash
scripts/live.sh json '{"cmd":"status"}'
scripts/live.sh json '{"cmd":"enqueue","url":"https://suno.com/s/XXXX","who":"@bot"}'
scripts/live.sh json '{"cmd":"standby","mode":"outro"}'
scripts/live.sh json '{"cmd":"mutate","action":"setTheme","params":{"theme":"forest"}}'
scripts/live.sh json status          # a bare command word also works
```

| `cmd` | Args | Returns |
|---|---|---|
| `status` | — | `{ ok, container, stream, now, queue, quota }` |
| `now` | — | the now-playing object (title/artist/image/who/likes/queue) |
| `queue` | — | `{ current, queue:[requests], rotation:[house] }` |
| `quota` | — | `{ quota: { date, units, calls } }` |
| `enqueue` | `url` (or `link`), `who?` | `{ ok, title, artist, position }` or `{ ok:false, reason }` |
| `skip` / `next` | — | `{ ok }` |
| `fade` | `to` (0–100), `ms` | `{ ok, to, ms }` |
| `standby` | `mode` (`intro`/`outro`/`off`), `title?`, `subtitle?` | `{ ok, … }` — `outro`/`off` also fade the music |
| `mutate` | `action`, `params` | passes through **any allowed scene directive** (themes, headline, reactions, votes, eq, …) |

`mutate` is the power tool: it forwards to the streamer's `/mutate` allowlist, so
an external system can drive the entire scene, not just music. Endpoints are also
reachable directly (`POST http://localhost:8080/{mutate,music/enqueue,music/skip,
music/fade}`, `GET /{health,music/status,music/queue}`) if you'd rather skip the script.

## State & persistence (survives restarts)

| File | Written by | Holds |
|---|---|---|
| `state/yt-cursor.json` | ingest (host user) | chat page cursor + processed-message ids → resume without missing/re-showing |
| `state/yt-usage.json` | ingest | today's API units/calls (resets midnight Pacific) |
| `control/music-queue.json` | streamer (container root) | the waiting request queue → restored on DJ start |

> `state/` is user-writable (the ingest runs as you); `control/` is root-owned
> (the streamer container writes it). Both are gitignored. The **house rotation**
> lives in the running DJ (in memory) — it only shows in `queue` while the
> streamer is up.

## Quota safety (YouTube Data API)

The cap is **10,000 units/day**; each chat poll ≈ **5 units**. Two protections:

- **Adaptive polling** — ~8s while chat is active, ramps toward ~60s when quiet
  (`YT_POLL_ACTIVE_MS` / `YT_POLL_IDLE_MS`), never faster than YouTube's own cadence.
- **Hard cutoff** — at `YT_QUOTA_LIMIT` units (default **9000**) the ingest stops
  polling; music + visuals keep running. Resets at midnight Pacific.

Watch it in `status` (`[quota] ~N / 10000 units (M calls) cutoff …`). Tighten the
cutoff per run if you like: `YT_QUOTA_LIMIT=5000 scripts/live.sh boot`.

> Quota is charged **per call (~5 units), not per message** — so polling *less*
> is the only lever (the resume cursor is about continuity, not quota).
