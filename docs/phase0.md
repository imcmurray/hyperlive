# Phase 0 — Transport Spike

**Goal:** prove the hardest, least-glamorous part of the whole project — a
live HTML/GSAP scene rendered in a real browser, captured in real time, and
pushed as a continuous, stable RTMP feed to YouTube Live — *and* mutable on
screen while it streams.

If this runs stable for 30–60+ minutes and you can change the screen live, the
risky architectural bet (browser-capture transport) is de-risked and Phase 1
(comments → moderation → mutations) is just plumbing on top.

---

## What's in the box

```
docker-compose.yml          one service: the streamer
packages/streamer/
  Dockerfile                node22 + chromium + ffmpeg + xvfb
  start.sh                  starts Xvfb, then the Node orchestrator
  src/
    config.js               all config from env
    ffmpeg.js               builds + supervises the x11grab→RTMP ffmpeg process
    index.js                express control plane + Puppeteer + file-watch
  scene/
    index.html              HyperFrames-style #stage composition
    styles.css              self-sufficient styling (survives CDN failure)
    scene.js                SceneAPI — the ONLY way the scene can be mutated
scripts/
  mutate.sh                 drive the live scene over HTTP
  mutate-file.sh            drive it via the file-watch trigger
control/                    bind-mounted; directives.json lives here at runtime
```

The data flow:

```
scene/index.html  ──Puppeteer──► Chromium (headless:false) on Xvfb :99
                                      │
                              ffmpeg -f x11grab :99  +  anullsrc audio
                                      │  libx264 / aac / flv
                                      ▼
                          rtmp://a.rtmp.youtube.com/live2/<key>
        ▲
   POST /mutate  or  write control/directives.json  →  SceneAPI.<action>(params)
```

---

## 1. Get a YouTube stream key (unlisted test stream)

1. Go to **studio.youtube.com** → top-right **Create** → **Go live**.
   (First time only: YouTube takes ~24h to enable live streaming on a new
   channel, and the account must have no live-streaming restrictions.)
2. Choose **Streaming software** (not webcam).
3. Set the broadcast **visibility to Unlisted** (or Private) for testing.
4. In **Stream settings** copy:
   - **Stream URL** → `rtmp://a.rtmp.youtube.com/live2` (this is the default).
   - **Stream key** → the secret string. This is your `YT_STREAM_KEY`.
5. Leave the Studio "Go live" page open — it shows the preview + health and
   flips to **LIVE** automatically once it receives your ffmpeg feed.

> Tip: use a **persistent stream key** (Stream settings → "Select stream key" →
> create a reusable key) so you don't have to re-copy it every test.

## 2. Configure

```bash
cp .env.example .env
# edit .env:
#   YT_STREAM_KEY=xxxx-xxxx-xxxx-xxxx-xxxx
#   DRY_RUN=false        # false = actually push to YouTube
```

Keep `DRY_RUN=true` if you just want to bring up the scene + control plane
without streaming (e.g. to develop the visuals).

## 3. Run

> **Prerequisite (EndeavourOS/Arch):** the Compose v2 plugin isn't installed by
> default. Install it once: `sudo pacman -S docker-compose` (this provides the
> `docker compose` subcommand). Also ensure your user is in the `docker` group
> and the daemon is running: `sudo systemctl enable --now docker`.

```bash
docker compose up --build
```

Watch the logs for, in order:
- `[start] Xvfb ready`
- `[control] listening on http://localhost:8080/`
- `[browser] scene loaded`
- `[ffmpeg] starting → rtmp://.../<key>`

Within ~5–15s the YouTube Studio "Go live" page should show an incoming feed
and let you confirm the broadcast is healthy. Let it run.

Health check from the host:

```bash
curl -s localhost:8080/health | jq
# { "ok": true, "sceneReady": true, "ffmpegUp": true, "ffmpegRestarts": 0, ... }
```

## 4. Change the screen WHILE it's live (the bonus)

Two equivalent ways — both go through the safe SceneAPI, never raw markup:

**Over HTTP:**
```bash
scripts/mutate.sh '{"action":"setHeadline","params":{"text":"viewers are driving this"}}'
scripts/mutate.sh '{"action":"setTheme","params":{"theme":"forest"}}'
scripts/mutate.sh '{"action":"addShoutout","params":{"who":"ian","text":"hello from chat","tier":"large"}}'
scripts/mutate.sh '{"action":"burst","params":{"intensity":0.9}}'
```

**Via file-watch** (stand-in for the Phase 2 Director's output):
```bash
scripts/mutate-file.sh '{"action":"setTheme","params":{"theme":"sunrise"}}'
```

Valid actions: `setTheme` (synthwave|sunrise|mono|forest), `setHeadline`,
`setSubhead`, `addShoutout` (tier small|medium|large), `burst`, `status`.
Anything not on the allowlist is rejected with HTTP 400.

## 5. Stop

```bash
docker compose down
```

---

## CPU baseline (720p30)

Encoding live H.264 is the dominant cost; Chromium + Xvfb are comparatively
cheap for this mostly-CSS/GSAP scene.

- **`-preset veryfast`, 1280x720@30, 4500k** typically lands around **1–2
  modern cores** (~100–200% of one core). On a recent desktop/laptop CPU it's
  comfortable; on a small VPS, give it 2 vCPU minimum.
- Measure your actual number:
  ```bash
  docker stats   # watch the CPU% column for the streamer container
  ```
- Knobs if you're CPU-bound: lower `VIDEO_FPS` to 24, drop `VIDEO_BITRATE`,
  or move `-preset` to `superfast`/`ultrafast` (larger files / lower quality
  per bit, but cheaper). Going to 1080p60 later roughly **3–4×** the cost — plan
  for hardware (NVENC/QSV) at that point rather than x264 software encode.

## Known gotchas / notes

- **CDN dependency:** the scene loads Tailwind + GSAP from CDNs. `styles.css`
  is self-sufficient so a CDN blip won't break the layout, but if GSAP fails to
  load the animations are skipped (text still updates). For production, vendor
  these locally.
- **Audio is required by YouTube** even for a silent stream — that's why we
  always mux `anullsrc` (or a `tone`). Don't remove it.
- **First Xvfb run** may leave a stale `/tmp/.X99-lock`; `start.sh` clears it.
- **Reconnect:** if YouTube drops the connection, `ffmpeg.js` respawns after
  2s; `ffmpegRestarts` in `/health` tells you how often that's happening.
- **Determinism:** this live path is intentionally NOT frame-deterministic
  (that's fine for live). The real HyperFrames offline renderer is reserved for
  the pre-rendered "premium takeover" clips in Phase 3.
