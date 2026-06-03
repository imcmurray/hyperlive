# Scene visuals & directive reference

The live scene (`packages/streamer/scene/`) is a layered, "premium-but-lightweight"
composition tuned for **software rendering** (we run Chromium with `--disable-gpu`):
depth comes from layered radial gradients, transforms, and opacity crossfades —
**no large blur filters, no WebGL**.

## Layer model

```
#bg
  bg-layer A / bg-layer B   ← double-buffered for crossfade theme transitions
    bg-base (theme gradient) · 3 radial-gradient auras (parallax) · masked grid
  #fx-rays                  ← slow-rotating light beams (toggle)
  #fx-particles (canvas)    ← ≤60 drifting motes, theme-tinted (toggle)
#content                    ← kicker · headline (masked reveal + float) · subhead
#shoutouts                  ← cards: accent bar, staggered text, glow on `large`
#ticker                     ← scrolling marquee
#overlays                   ← grain · scanlines · vignette (cinematic grade)
```

Theme changes **crossfade**: the new theme renders into the hidden bg-layer and
GSAP fades it in (with a gentle scale) while the old one fades out; UI accent
colors swap at the fade midpoint. No hard cuts.

## Directives (the full allowlist)

All go through `POST /mutate` → `SceneAPI` → validated by `validateDirective()`.

| action | params | effect |
|---|---|---|
| `transitionTheme` | `theme`, `duration?` (0.3–4s) | smooth crossfade to a theme |
| `setTheme` | `theme` | same crossfade (back-compatible alias) |
| `setHeadline` | `text` (≤80) | headline change: rise-out → reveal-in (transform/opacity) |
| `setSubhead` | `text` (≤140) | supporting line change |
| `addShoutout` | `who`, `text` (≤120), `tier` (small/medium/large) | card; `large` adds flash + glow pulse |
| `burst` | `intensity` (0–1) | light flash + expanding shockwave ring |
| `setEffect` | `effect`, `on` (bool), `duration?` (0.1–3s) | fade an effect in/out |
| `setTicker` | `items` (array, ≤8 strings, ≤60 each) | rewrite the scrolling bottom ticker |
| `status` | `text`, `show` (bool) | dev status chip |

**Themes (23):** `synthwave` · `sunrise` · `mono` · `forest` · `aurora` · `ember` · `midnight` · `vapor` · `matrix` · `gold` · `crimson` · `neon` · `dusk` · `ocean` · `lava` · `frost` · `glitch` · `retro` · `void` · `plasma` · `noir` · `solar` · `holo`

**Effects (18):**
- *ambient (fade in/out):* `particles` · `rays` · `bokeh` · `dust` · `fog` · `sweep` · `bars` (equalizer) · `grid` (perspective floor) · `holoscan` (scan line) · `chroma` (aberration) · `scanlines` · `grain` · `vignette`
- *canvas:* `datarain` (matrix rain)
- *periodic bursts (toggle the timer):* `sparks` · `lightning` · `filmburn` (light leak) · `ripple`

**Defaults:** `vignette`, `scanlines`, `grain` ON; everything else OFF.

**Performance:** the default scene renders at a solid 60fps; animation is pinned to an even 30fps (`gsap.ticker.fps(30)`) and the pipeline captures at 30 — matched rates = smooth motion. Each *active* effect adds render cost; periodic effects are nearly free at idle.

**Capture modes** (`CAPTURE` env):
- `x11grab` (default fallback) — headful Chromium on Xvfb, **software** rendering. Lowest CPU (~1.4–1.7 cores @720p30), lossless capture, but render-bound: stacking heavy effects (`datarain`+`particles`+`bars`) pulls fps below 30.
- `screencast` — headless Chromium on the **Intel iGPU** (Vulkan via `--use-angle=vulkan` + `/dev/dri/renderD128`) → CDP `Page.startScreencast` (q92) → ffmpeg. Runs **1080p60 with full blend-mode richness** (rich auras/grain/scanlines). The scene is authored at 1280×720 and scaled 1.5× to fill 1920×1080 (`--sscale`). Trade-off: **high CPU** (~4–4.5 cores @1080p60) from the JPEG round-trip + 1080p x264. Requires Mesa in the image + `--device /dev/dri/renderD128` + host `render` gid in `group_add`.

**Automatic CPU fallback:** if `CAPTURE=screencast` but no hardware GPU is detected (WebGL probe returns llvmpipe/swiftshader), the streamer **auto-falls back** to `x11grab` at **720p30 in "lite" mode** (blend modes off, 30fps) and shows an on-screen `⚠ CPU RENDERING` warning. `renderMode` + `gpuRenderer` are reported in `/health`. The operator can dismiss the banner:
```bash
scripts/mutate.sh '{"action":"renderWarning","params":{"show":false}}'
```

## Test the new visuals

These work with your existing `scripts/mutate.sh` (HTTP) and the simulator flow.

```bash
# smooth theme crossfades
scripts/mutate.sh '{"action":"transitionTheme","params":{"theme":"aurora","duration":1.4}}'
scripts/mutate.sh '{"action":"transitionTheme","params":{"theme":"ember"}}'
scripts/mutate.sh '{"action":"setTheme","params":{"theme":"forest"}}'   # also crossfades now

# toggle effects
scripts/mutate.sh '{"action":"setEffect","params":{"effect":"particles","on":true}}'
scripts/mutate.sh '{"action":"setEffect","params":{"effect":"rays","on":true}}'
scripts/mutate.sh '{"action":"setEffect","params":{"effect":"scanlines","on":false}}'

# premium card + headline motion
scripts/mutate.sh '{"action":"addShoutout","params":{"who":"@whale","text":"this looks incredible","tier":"large"}}'
scripts/mutate.sh '{"action":"setHeadline","params":{"text":"chat is driving the vibe"}}'

# the simulator (rules director) understands effect/theme words:
SOURCE=simulate node packages/ingest/src/index.js
```

### Visual QA without touching the live stream

`GET /screenshot` returns a PNG of the current scene. To preview changes safely,
run an isolated copy that does **not** push to YouTube:

```bash
docker build -t hyperlive-streamer:dev packages/streamer
docker run -d --name hl-dev --shm-size=1g -e DRY_RUN=true -p 8099:8080 hyperlive-streamer:dev
curl -s localhost:8099/mutate -X POST -H 'content-type: application/json' \
  -d '{"action":"transitionTheme","params":{"theme":"aurora"}}'
curl -s localhost:8099/screenshot -o shot.png      # open shot.png
docker rm -f hl-dev
```

## Performance notes (720p30, software render)

- Scene rendering alone ≈ 1 core; **particles** are the heaviest effect. With the
  encoder, budget ~2 cores total at 720p30. Toggle `particles` off for headroom.
- Auras are radial gradients (cheap) — they replaced the old `blur(90px)` blobs.
- Overlays (grain/scanlines/vignette) are static or transform-animated — near-free.
- To apply scene changes to the **live** stream you must rebuild the image:
  `docker compose up --build -d` (brief reconnect; YouTube tolerates it).
