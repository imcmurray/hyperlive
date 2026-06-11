# HyperLive as a platform — directions

> We set out to build a Suno live stream. What we *actually* built is a
> general-purpose **live interactive broadcast engine**: a way to put any
> real-time, crowd-steerable HTML scene onto a 24/7 stream that's *safe to
> expose to the public internet*. Suno music is application #1, not the ceiling.

This doc names the reusable kernel, the seam where domain logic plugs in, and a
catalog of directions the same stack can go — including how each connects to
other projects in the portfolio.

---

## 1. What we actually built (the kernel)

Five layers, none of which are Suno-specific:

1. **Persistent headless scene** — a long-lived HTML/CSS/GSAP document rendered
   in a real (headless) Chromium, 24/7, with anti-throttling so it never sleeps.
   Authoring model is HyperFrames-style: plain markup + seekable animation.
2. **Live capture → RTMP** — Xvfb/x11grab or CDP screencast → ffmpeg → YouTube.
   CFR pump (no A/V drift), reconnect supervisor, CBR encode, GPU/CPU fallback.
3. **The safe directive bus** *(the crown jewel)* — external input is moderated,
   then turned into a validated `{action, params}` directive against a fixed
   allow-list of scene methods. **The outside world can only ever supply
   *arguments* to pre-vetted actions, never markup or code.** This is what makes
   it safe to wire a public chat (or a payment webhook, or a sensor) straight to
   a live broadcast.
4. **Collective dynamics** — votes (countdown rounds → winner), a Mood Engine
   (rolling aggregate → ambient drift), instant reactions, Super-Chat tiers,
   first-timer welcomes. Crowd → atmosphere, without any single user dominating.
5. **A content/domain pack** — currently the Suno auto-DJ (resolve → play →
   now-playing card → per-song likes → credits). This is the *only* layer that
   knows what "a song" is.

Layers 1–4 are the **platform**. Layer 5 is **one pack**. Swap the pack (and the
input sources and the scene's visual vocabulary) and you have a different channel.

---

## 2. The seam: core vs pack

```
            ┌──────────────────────── INPUT SOURCES ────────────────────────┐
            │  YouTube chat · Super Chats · webhooks · RSS · sensors · APIs   │
            └───────────────────────────────┬───────────────────────────────┘
                                             ▼
                         ┌─────────── MODERATION GATE ───────────┐
                         │  rate-limit · blocklist · LLM safety   │
                         └───────────────────┬────────────────────┘
                                             ▼
   ┌──────────── DIRECTOR ────────────┐   {action, params}   ┌─── SCENE API ───┐
   │ rules / LLM → pick a vetted call │ ───────────────────▶ │ allow-listed     │
   └──────────────────────────────────┘                      │ mutations only   │
                                                              └────────┬─────────┘
                                                                       ▼
                         headless scene ──▶ capture ──▶ ffmpeg ──▶ RTMP / YouTube
```

Everything left of the Scene API is **content-agnostic core**. A "pack" is:
- a set of **Scene API actions** + the matching scene DOM/CSS (the visual vocab),
- optional **input adapters** (where the directives come from),
- optional **background daemons** (the Suno DJ is one).

That seam is already clean in the code — which is exactly why a fork or a
core-extraction is low-friction (see §5).

---

## 3. Directions catalog

Grouped by what changes. Each lists the pack + the cross-project tie-in.

### A. Audio-driven channels
- **Suno music live** *(current)* — viewer-requested AI songs, DJ, now-playing,
  per-song hearts, credit roll. → `SunoLiveStream`, and siblings
  `SunoPlaylistPlayer`, `suno-video-generator`.
- **Any-audio visualizer** — drop the request/resolve layer, keep the live
  spectrum → reactive scene. Works for podcasts, radio, mixtapes, ambient.
- **Lo-fi / ambient "TV"** — a branded 24/7 chill channel; chat reactions nudge
  the mood. The Mood Engine already does most of this.

### B. Data / ops channels (24/7 dashboards-as-broadcast)
- **Markets ticker / chart-race** — live prices, P&L, signals streamed as a
  channel. → `DrSol`, `TraderHoe`, `SATA`, `InspectorBit` (BTC analytics),
  `MrMiner`, `rusty-btc-dormants`. A "paper-trading research agent" narrating its
  own decisions live is a natural fit.
- **Status / uptime board** — a public live status page for any system. →
  `changeDetector`, `hashpies` cluster, `moss-network-main` health.
- **Civic / countdown trackers** — a public live counter or status board. →
  `shutdown-clock` (US gov shutdown) is *already* a tracker; making it a live
  channel is a tiny pack. (Court-facing public boards would need separate review
  — keep that on the courthouse side, not this experimental stack.)

### C. Crowd / collective experiences
- **Twitch-Plays-style canvas** — the directive bus + votes already give you a
  collective-control surface; point it at a paintable/buildable scene.
- **Vote-driven generative art** — rounds pick prompts/params; the scene renders
  the winner. Reuses the existing vote machinery verbatim.
- **Community lobby** — a persistent hangout the chat decorates together.

### D. Events / launches / announcements
- **Release channel** — branded countdown → reveal → highlight reel for drops. →
  `AIonitePath` (weekly publishing cadence), product launches.
- **HyperFrames takeover clips** — splice high-quality *pre-rendered* segments
  into the live scene (Super-Chat large tier already reserves this slot).

### E. AI-agent stages
- **Autonomous narrator / "founder-agent" showroom** — an agent drives the scene
  *and* the commentary live; viewers steer via chat. → `CostCovered` /
  `claude-cost-coverage` (the "Claude pays for itself" / autonomous-founder
  ambition) gets a literal stage.
- **Live agent demos** — show an agent working in real time as a watchable,
  rewindable broadcast.

### F. Education / explainer
- **Live slides / diagrams** — a script (or chat Q&A) drives an animated
  explainer scene; the captured stream becomes an evergreen video.
- **Docs-to-video, live** — pair with HyperFrames' offline renderer for polished
  segments.

### G. Monetized / interactive
- **Tiered effects** — Super Chat amount → escalating visual payoff (built,
  partial). The payment→effect path is the same safe directive bus.
- **Sponsor segments** — scheduled branded takeovers via the standby/overlay
  system we just built (intro/break/outro screens generalize to "sponsor card").

---

## 4. What's constant vs what changes (per direction)

| Layer | Reused as-is | Swapped per direction |
|---|---|---|
| Capture → RTMP | ✅ always | — |
| Anti-throttle / reconnect / CBR | ✅ always | — |
| Moderation gate | ✅ always | blocklist/allow-list tuning |
| Directive bus + allow-list | ✅ (mechanism) | the *set* of actions |
| Scene shell (bg, overlays, standby) | ✅ mostly | the content widgets |
| Votes / Mood / reactions | ✅ optional | thresholds, vocabulary |
| Input adapters | partial | the source (chat/webhook/sensor/API) |
| Domain daemon | ❌ | the pack (DJ → ticker → agent → …) |

Rule of thumb: **a new channel ≈ a new pack (actions + scene widgets + one
adapter), not a new platform.**

---

## 5. Recommended structural move

The honest tradeoffs for splitting Suno out:

- **Hard fork, diverge immediately** — fastest today, but every core fix (the
  stale-`pageToken` probe, CBR, anti-throttle, the show-phase system) then needs
  hand-porting to two repos, and they *will* drift. This is the trap.
- **Monorepo with `core/` + `packs/`** — cleanest long-term, no duplication, but
  more refactoring than this moment warrants.
- **Fork with `hyperlive` as upstream (recommended)** — `SunoLiveStream` gets its
  own identity, README, deploy, and roadmap; `hyperlive` stays the playground for
  discovery. Crucially, keep the **Suno layer thin** and pull core fixes from
  `hyperlive` (`git fetch upstream && merge`) so the platform doesn't fork in two.

Recommendation: **fork now, treat `hyperlive` as upstream, keep the pack thin** —
and *if* a third direction gets real, that's the signal to graduate to the
`core/ + packs/` monorepo. Don't pay the monorepo refactor cost for one product.

> **Status (2026-06-10): done.** `SunoLiveStream` is forked and running with this
> repo as its hyperlive base. The Suno experience evolves THERE; this repo is now
> the **platform upstream** — core hardening, HyperFrames-native experiments
> (see §7), and anything content-agnostic. Core fixes flow downstream via merge.

**Watch-items as it diverges**
- Keep `streamer/` (capture/encode) and the `ingest/` core (poll/moderate/probe/
  quota) identical to upstream — those are pure platform; resist Suno-specific
  edits there.
- Suno specifics live in: `music/` (DJ/resolve/rotation/intro), the music control
  plane, the now-playing/credits scene widgets, and the `parseSunoShare`/resolver.
  That's the pack boundary to defend.

---

## 6. The stage is a *video source*, not necessarily our scene

Everything above (§2–§4) treats the broadcast as **our browser scene, captured
to RTMP**. That's one stage type. The bigger platform move is to recognize that
the **interaction stack — ingest → moderation → director → dashboard,
automations, superchats, bans — is completely independent of *what's on the
main video*.** Someone should be able to stream their **game session, a live
event camera, a desktop, another app** and still get the moderated,
chat-driven HyperLive overlay + the mod console on top of it.

This splits the kernel into two cleanly separable halves:

```
   ┌──────────── INTERACTION STACK (the HyperLive value) ────────────┐
   │  ingest → moderation gate → director → {action,params}          │
   │  dashboard · automations · superchats · bans · votes · mood      │
   └───────────────────────────────┬─────────────────────────────────┘
                                    ▼  drives only the OVERLAY
   ┌──────────────────────── COMPOSITOR (the stage) ─────────────────┐
   │   main source            +     HyperLive scene (transparent)    │
   │   ├─ our browser scene         lower-thirds · alerts · cards ·   │
   │   ├─ game capture              superchat recognition · ticker    │
   │   ├─ event camera (RTMP/v4l2)  vote bars · now-playing           │
   │   └─ desktop / another app                                       │
   └───────────────────────────────┬─────────────────────────────────┘
                                    ▼
                          ffmpeg ──▶ RTMP / YouTube
```

**What this is, concretely:** today the scene IS the full frame. Make it an
**alpha overlay layer** instead, and let the streamer composite `[main source]`
under `[scene overlay]`. The scene already renders over a transparent root in a
headless Chromium — the change is (a) a compositor step in the streamer with N
inputs instead of one, and (b) a scene "overlay mode" that drops its own
background so the main source shows through.

**What stays identical:** the entire interaction stack. Chat still becomes
vetted directives; the dashboard still bans/holds/previews; superchats still
fire recognition cards; automations still bind events to overlay actions. None
of it cares whether the pixels behind the overlay are a gradient, a game, or a
camera.

**Why this is HyperLive's lane, not OBS's.** OBS already composites a "browser
source" over a game capture — but the overlay is static and the operator drives
it by hand. HyperLive's overlay is **moderated, chat-driven, and run from a
purpose-built mod console**: the value isn't the compositing, it's the safe
interaction engine feeding it. The compositor is the commodity; the gate +
director + dashboard are the product.

**The safety story gets *easier*, not harder.** Viewer input still only ever
touches the overlay scene through the same allowlist + sandbox (§7,
`SECURITY.md`) — and now the blast radius is smaller: the worst a malicious
directive can do is misbehave inside a transparent overlay, never the operator's
game or camera feed, which the interaction stack can't address at all.

**Two places to composite — and we built the cheap one first.**

- **In-browser (built).** For any source the browser can render — a **YouTube
  video**, a direct video/HLS URL, an image — the simplest path is to put the
  source *inside the scene page* as a bottom layer and make the themed
  background transparent. The existing screencast captures the composite as-is:
  **zero ffmpeg changes, no alpha-capture problem.** This is the
  `setStageSource` action (operator-only — allowlisted on `/mutate`, never
  emitted by the director, so viewers can't set the source). A cross-origin
  YouTube embed is an out-of-process iframe, and the CDP screencast composites
  OOPIFs fine (the same path Tier-2/3 cards already rely on). Verified headless:
  the video plays and is captured, the scene rides on top, the 11-char id
  whitelist rejects injection. See `docs/overlay-mode.png`.
- **In-ffmpeg (future).** For sources the browser *can't* host — a live game
  capture, a hardware camera, another app's window — generalize the streamer's
  single capture into a source list: `main` (v4l2 / RTMP ingest / x11grab
  region) under `overlay` (the scene rendered over transparency), composited
  with `ffmpeg -filter_complex overlay`. This needs the alpha-capable capture
  the in-browser path sidesteps (a PNG/`webm`-alpha screencast or a CSS color
  key). Same `setStageSource`-shaped control surface; different plumbing behind
  it.

**Then: source as a pack.** "YouTube co-watch", "game overlay", "event camera",
"just-chatting" each become packs in the §2 sense — a source choice + the
overlay widgets that suit it, reusing the whole interaction stack unchanged.

**Still open:** *audio.* The in-browser path captures the source's **picture**
but not its **sound** — browser audio isn't routed into the ffmpeg capture yet
(the YouTube embed autoplays muted). Capturing it means teeing the page's
PulseAudio output into the encoder, which the music-mode sink plumbing already
does for the DJ and can be adapted for. Until then, overlay mode is silent (or
runs under the existing music bed).

This is the cleanest answer to *"how does someone stream **their** content on
HyperLive?"* — they bring the stage; HyperLive brings the moderated crowd layer
and the console to run it. **Status (2026-06-11): in-browser overlay prototyped
and verified; ffmpeg compositing + audio are the next steps.**

---

## 7. Comment-alters-the-stage: the three-tier mutation ladder

The next platform experiment: let a viewer comment change the stage itself, not
just pick from preset actions. Upstream HyperFrames just built the key
infrastructure for their editor (stable `data-hf-id` element identity,
#1269–#1299); this is its live-broadcast translation. Each tier widens what the
model may do — ship in order, because each tier's safety story builds on the
last. The invariant from §1 NEVER changes: *the outside world supplies arguments
to vetted operations* — the tiers just shrink the granularity of "operation."

**Tier 1 — element mutation (`mutateElement`).**
Mint `data-hf-id` over the stage at boot; expose a manifest
(`GET /elements` → `{id, role, mutableProps}`) so the director knows what
exists and what it may touch; one new directive
`{action:"mutateElement", params:{id, ops:[…]}}` with a vetted op vocabulary:
set text (through `clean()`), toggle allowlisted classes, clamped
transform/opacity tweens. "Make the headline huge and tilt it" becomes real.
Same safety posture as today, finer grain. Merges downstream usefully —
SunoLiveStream inherits a richer director.

**Tier 2 — sandboxed viewer cards.**
A comment describes a visual; Claude authors actual HTML+CSS for it — the
HyperFrames "Write HTML" model, live. Containment, in order of importance:
1. **iframe sandbox** — the card renders in `<iframe sandbox>` (NO
   `allow-scripts`, NO `allow-same-origin`) in a fixed-size slot; CSS
   animations only. It cannot script, fetch, or escape into the stage.
2. **CSP `default-src 'none'`** baked into the srcdoc — no network, no
   external images/fonts; inline styles only.
3. **Pre-render gate** — render hidden → screenshot the slot → vision safety
   check (text moderation can't catch "a slur drawn out of div borders"; a
   screenshot check can) → only then reveal, with a TTL.
4. **Operator kill** — cards die with `setStandby` / a clear-cards call.
No `ANTHROPIC_API_KEY` in the streamer → viewer-sourced cards are refused
(operator-only via the loopback control API still works).

**Tier 3 — segment takeovers.**
The same machinery at full-stage scale: a fullscreen sandboxed composition
with a hard TTL, show-phase aware (never fights standby/outro). Super-Chat
large tier already reserves this slot; eventually pre-rendered HyperFrames
clips splice in here too (§3D).

**Honest risks** (why the gates above are all mandatory, not menu items):
tier 2 is the first time model-generated *markup* reaches the broadcast, so
chat prompt-injection graduates from "annoying directive" to
"attacker-influenced visuals." The sandbox bounds the blast radius to one
slot's pixels; the vision gate bounds what those pixels can show; the TTL
bounds for how long; the operator kill bounds everything else. Also: iframe
compositing has a capture cost — confirm screencast fps holds on the iGPU
with an animating card in frame before building on top.

---

## 8. Operational truths we paid for (carry into every direction)

- **Post in the live-chat panel, not the video's comments** — only live chat
  feeds the API. (And viewer links need moderator/verified status.)
- **`build` = container/streamer; `restart` = host ingest** — two processes.
- **This iGPU's H264 is low-power/CQP-only** — no hardware bitrate target; use
  CPU libx264 **CBR** for a guaranteed rate.
- **Stale `pageToken` returns empty, not an error** — the catch-up probe is what
  keeps a 24/7 poller honest across broadcast restarts.
- **NFKC-fold display text** — fancy Unicode names (𝓙𝓸𝓼𝓲𝓮) tofu otherwise.
