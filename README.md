# HyperLive

A comment- and payment-driven **live YouTube channel** where viewers steer the
video in real time. Built on a [HyperFrames](https://github.com/heygen-com/hyperframes)-style
HTML/CSS/animation authoring model, but streamed live instead of rendered offline.

> Write HTML. Mutate it live from moderated chat. Stream it to YouTube.

**▶ [Watch a demo on YouTube](https://www.youtube.com/live/NjpZs7JjWIU)** <sub>(captured during a dev session)</sub>

[![HyperLive scene — layered gradient background, mutable titles, and a pop-up countdown card](docs/screenshot.png)](https://www.youtube.com/live/NjpZs7JjWIU)

<sub>The live scene: kicker / gradient headline / subhead, the bottom pop-up cards with countdown dots, and (top) the on-screen warning shown when it auto-falls back to CPU rendering. Click to watch the demo.</sub>

## The idea

- A long-lived **HTML/CSS/GSAP scene** renders in a real (headless) browser.
- A real-time **browser capture** (Xvfb + ffmpeg `x11grab`) pushes it to
  **YouTube Live** over RTMP — a single continuous stream.
- Viewers' **chat comments**, once moderated, become **scene directives**
  (`{action, params}`) that mutate the scene live.
- **Super Chats** escalate the effect by amount tier — small = shoutout,
  medium = scene change, large = a pre-rendered HyperFrames "takeover" clip.
- A **moderation gate** sits in front of everything; viewer input can only ever
  become *arguments* to pre-vetted actions, never executable markup.

## Why this architecture (the key bet)

HyperFrames is a *deterministic, offline* HTML→MP4 renderer — fantastic for
polished clips, but a 30–90s render+buffer delay would kill live interactivity.
So the **live surface is a real-time captured browser scene** (low latency,
live DOM mutation), and HyperFrames' offline renderer is reserved for
high-quality **pre-rendered takeover clips**. See [`docs/phase0.md`](docs/phase0.md)
for the full rationale.

## Status

| Phase | What | State |
|-------|------|-------|
| **0** | Transport spike: live scene → x11grab → ffmpeg → YouTube RTMP, mutable while live | ✅ built + verified live (`packages/streamer`) |
| **1** | Comments → moderation gate → rule-based director → `/mutate` | ✅ built + verified live via simulator (`packages/ingest`); real YouTube polling ready, needs OAuth — see [`docs/phase1.md`](docs/phase1.md) |
| **2** | Swap the director's `parseIntent()` for a **Claude** call (same directive shape, re-validated) | ✅ built (`packages/ingest`, `DIRECTOR=llm`); needs `ANTHROPIC_API_KEY` to run — see [`docs/phase2.md`](docs/phase2.md) |
| 3 | Super Chat tiers → escalating effects + pre-rendered takeover clips | partial (tiers→shoutouts done; takeover clips pending) |
| 4 | Hardening: reconnect, watchdog, 1080p60, kill-switch dashboard | planned (`packages/dashboard`) |

## Quick start (Phase 0)

```bash
# one-time on EndeavourOS/Arch: sudo pacman -S docker-compose
cp .env.example .env      # add your YouTube stream key, set DRY_RUN=false
docker compose up --build
# then, while it streams:
scripts/mutate.sh '{"action":"setTheme","params":{"theme":"forest"}}'
```

Full walkthrough + YouTube key setup + CPU notes: **[`docs/phase0.md`](docs/phase0.md)**.

## Layout

```
packages/
  streamer/   ✅ Phase 0: scene + browser capture + ffmpeg→RTMP + /mutate
  director/      Phase 2: Claude brain that emits validated directives
  ingest/        Phase 1/3: YouTube chat + Super Chat ingestion + moderation
  dashboard/     Phase 4: operator console + kill switch
docs/phase0.md   transport spike walkthrough
scripts/         mutate.sh / mutate-file.sh helpers
```

## Credits & acknowledgements

HyperLive was inspired by and bootstrapped from
**[HyperFrames](https://github.com/heygen-com/hyperframes)** by
[HeyGen](https://github.com/heygen-com) — an open-source, agent-friendly
framework for turning HTML + CSS + animations into deterministic MP4 videos
("Write HTML. Render video. Built for agents."). HyperLive borrows its
HTML-first authoring model and component sensibility, then takes the idea in a
different direction: **live, real-time, chat-driven streaming** instead of
deterministic offline rendering.

Huge thanks to the HyperFrames authors for the foundation. ❤️

---

License: Apache-2.0 (matching upstream HyperFrames).
