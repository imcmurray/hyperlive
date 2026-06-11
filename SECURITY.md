# Security model

HyperLive does something most "let chat control the screen" projects don't dare
to: it lets **untrusted input from the open internet mutate a live DOM that is
being broadcast in real time**. The entire architecture exists to make that
safe. This document is the threat model, and `tests/adversarial/` is its
executable proof.

## The one invariant

> **Viewer input can only ever become *arguments* to pre-vetted actions —
> never markup, code, or selectors that the system executes.**

Everything below is in service of that sentence. If you find a way for a chat
message (or a Super Chat, or an automation param) to run script in the scene
document, change the DOM outside a registered element, or reach the network
from a viewer-authored card, that is a security bug — please report it (see
*Reporting* below).

## Trust boundaries

```
  open internet                  this host (loopback only)
  ───────────────                ─────────────────────────────────────────
  YouTube live chat ─poll──▶ ingest ──┬─ moderation gate (regex+rate+LLM)
  (or the simulator)                  ├─ director  → {action, params}
                                      └─ POST /mutate ─▶ streamer ─▶ scene
  moderator ───────tunnel/loopback──▶ dashboard (admin server :8090)
```

- **The control plane is loopback-only by design.** The streamer control API
  (`/mutate`, `/music/*`, `/card`, `/takeover`) and the moderator dashboard
  (`:8090`) bind to `127.0.0.1` and have **no authentication** — because they
  are never meant to face the network. Remote moderators reach them by
  tunnelling (SSH / Tailscale), so the tunnel is the auth. We deliberately do
  **not** hand-roll an auth layer for these. `docker-compose*.yml` publishes
  these ports as `127.0.0.1:PORT`, never `0.0.0.0`.
- **OAuth scope is `youtube.readonly`.** HyperLive reads chat; it never writes
  to YouTube (no posting, no YouTube-side bans). Bans/mutes/kicks are enforced
  **locally** at the directive bus. Acting on YouTube would require a
  `youtube.force-ssl` credential — a documented opt-in, not the default.
- **Secrets live only in `.env`** (gitignored): `YT_STREAM_KEY`,
  `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`. They are never
  committed and never sent to the scene.

## How untrusted input is contained, layer by layer

| Door for untrusted input | What stops an attack |
|---|---|
| **Chat text → directive** | The moderation gate (rate limit → regex blocklist → optional LLM classifier, fail-closed) runs first. The director then maps intent onto an **allowlist** of actions; params are typed and clamped. Unknown actions are refused with a 400. |
| **`mutateElement` (Tier 1)** | Operates only on elements in a **curated registry** (`data-hf-id`), looked up by id — an arbitrary CSS selector or DOM ref can't be smuggled in. Text is `clean()`ed (angle brackets stripped, control chars removed, length-clamped); tweens are clamped to fixed numeric ranges. |
| **Viewer cards (Tier 2) / takeovers (Tier 3)** | Model/operator-authored HTML may enter **only** through `POST /card` and `POST /takeover`, never `/mutate`. Each is **pre-rendered off-air**, screenshotted, and passed through a **vision safety check (fail-closed)** before airing. On the scene it lives in a fully sandboxed `<iframe sandbox="">` (no `allow-scripts`) with `Content-Security-Policy: default-src 'none'` — no script, no network, no parent access. Hard TTL. |
| **Automation params** | An automation is *(event, one vetted action, params)* with `{who}`/`{amount}`-style placeholders. Placeholders substitute event **data** by pure string interpolation — never evaluated. Params are size-capped, count-capped, and the action must be on the automation allowlist (the gated `showCard`/`takeover` are excluded). The scene `clean()`s every param again on arrival. |
| **`/mutate` HTTP endpoint** | Accepts only allowlisted actions; `showCard`/`takeover`/`clearCards` are **not** on that allowlist, so raw markup can't reach the broadcast through the ungated door. |
| **`setStageSource` (overlay mode)** | The one door that loads **remote** content (a YouTube embed / video URL as the stage background). It is **operator-only**: allowlisted on the loopback `/mutate`, but **never emitted by the director**, so a viewer can't set the source. Inputs are strictly whitelisted — a YouTube id must match `[A-Za-z0-9_-]{11}`, other URLs must be `http(s)` — and elements are built with DOM APIs (never `innerHTML`), so neither markup nor a `javascript:`/`data:` source can be smuggled in. The embed loads from `youtube-nocookie.com` and, being cross-origin, is sandboxed by the browser like any third-party iframe. |

The defining choice is **allowlist-first**: nothing is mutable until it's
explicitly registered as mutable, and no markup reaches the screen until it has
survived an off-air render + a vision gate. (This inverts upstream HyperFrames'
"stamp everything" authoring model — see `docs/platform-directions.md` §7.)

## The adversarial test suite

`tests/` turns the claims above into a CI gate (`.github/workflows/ci.yml`):

- **`tests/unit/*.test.js`** (`npm test`) — the validation logic in isolation:
  the moderation gate (blocklist, rate limiter, suno-link allowlist, and that
  markup passes through *as inert text*), bans/mutes (channelId-first matching,
  self-expiring timeouts), and automations (action/event allowlists, size and
  count caps, placeholder substitution, `__proto__` pollution resistance).
- **`tests/adversarial/scene-probe.mjs`** (`npm run test:adversarial`) — loads
  the **real scene in headless Chromium** and fires an injection corpus
  (`<img onerror>`, `<svg onload>`, inline `<script>`, `javascript:` URLs,
  attribute break-outs, `@import` exfil, oversized payloads) at every untrusted
  door. A global tripwire (`window.__pwned`) catches any parent-document
  execution; further checks assert no injected DOM nodes, that the card and
  takeover iframes are fully sandboxed, that clamps/caps hold, and that
  `/mutate` refuses the gated actions. **Exit 0 = the invariant held for every
  payload.**

## Out of scope (and why)

- **Authenticating the control plane / dashboard.** Intentional — it's
  loopback-only; the SSH/Tailscale tunnel is the trust boundary. If you expose
  these ports to a network, that's a deployment misconfiguration, not a
  supported mode.
- **YouTube-side enforcement.** By design (`youtube.readonly`). Local
  enforcement only.
- **The vision gate's model judgement.** It's a fail-closed safety *layer*, not
  a guarantee; the structural sandbox (no `allow-scripts`, CSP `default-src
  'none'`) is what actually contains a card, regardless of the model's verdict.

## Reporting

These are personal/experimental repos. If you find a way to break the invariant
above, please open a GitHub issue describing the payload and the door it took —
a failing addition to `tests/adversarial/` is the ideal report.
