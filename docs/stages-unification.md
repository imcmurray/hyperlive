# Design: Unify Show Controls + Stages (+ editable Themes)

**Status:** Proposed — parked for discussion. Revisit with a fresh review pass.
**Author:** drafted with Claude (Opus 4.8), 2026-06.
**Motivation seed:** "If I have to click GO ON AIR / GO LIVE anyway, why do we have an INTRO button?" → Show Controls predate Stages and the two now overlap. This doc proposes folding Show Controls into the Stages model and making the standby screens (and, later, themes) user-editable.

---

## 1. Context — two systems that answer the same question

Both Show Controls and Stages ultimately decide **"what is on the broadcast right now."** They were built at different times and don't share a model.

### Stages (the newer, cleaner model)
- A stage is a data object: `kind` (`scene` | `youtube` | `video` | `image`) + optional `theme` + overlay titles (`kicker`/`headline`/`subhead`) + `ticker` + per-stage `features`.
- Persisted to `state/stages.json` (`{ custom, active, titleDefault, overrides }`).
- Applied via `buildApplyDirectives(stage, {skipSource})` in `packages/ingest/src/stages.js`, which emits a vetted directive sequence: `setStageSource` → `transitionTheme` → `setKicker`/`setHeadline`/`setSubhead` → `setTitles` → `setTicker` → `setVibe` → feature-cleanup.
- Fully editable in the dashboard STAGES tab (add/edit/delete custom; override builtins; reset).
- Admin endpoints: `GET /admin/stages`, `POST /admin/stages/apply` (live or `{preview:true}`), `POST /admin/stages/custom`, `POST /admin/stages/titles`.
- Builtins live in the `BUILTINS` array in `stages.js`. `featuresOf(stage)` → `setActiveFeatures(...)` reshapes the ingest interaction layer on live apply. `sourceKey(stage)` lets a re-apply skip a source reload when the source is unchanged.

### Show Controls (the older model)
- `POST /admin/show` (in `admin.js`) with `action` of `onair` | `outro` | `standby` (modes `intro`/`break`/`technical`/`off`). Also the `live.sh` verbs `intro`/`onair`/`tech`/`brb`/`resume`/`outro`.
- These call **`setStandby({mode, title?, subtitle?, artists?})`** (in `packages/streamer/scene/scene.js`), which raises a **separate, full-screen, opaque overlay** (`#standby`, markup in `scene/index.html`, CSS `.sb-intro`/`.sb-technical`/`.sb-break`/`.sb-outro` in `styles.css`).
- The overlay layout/animation/colors are **hardcoded per mode**; only `title`/`subtitle` (and `artists` for outro) are data-driven. Preset copy lives in the `presets` map in `setStandby` (e.g. intro = "Stream starting shortly").
- Key behaviour: the standby overlay sits **on top of** the still-running stage source/scene — INTRO doesn't replace the scene, it **covers** it (overlay is opaque; the source keeps playing, muted, underneath).
- Special phase behaviours beyond a screen swap:
  - `onair` → `setCountdown({seconds})`, then after N s: `setStandby({mode:"off"})` + DJ → live queue.
  - `outro` → `setStandby({mode:"outro", artists})` + `setStageSource({kind:"none"})` + music fade to 0 over ~6 s (credits/artist-roll + Suno/GitHub links).

### Themes
- 23 themes, defined as CSS classes in `packages/streamer/scene/styles.css` (`.theme-<name>` with `--c1/--c2/--c3` accent colors + `--bg-grad` + `--grid`).
- The **name list is duplicated in four places** and must be kept in sync by hand: `scene.js` (`THEMES`), `votes.js`, `llm-director.js`, and the dashboard `THEME_COLS` map (which also re-encodes the three accent colors for preview swatches).
- `setTheme`/`transitionTheme` (SceneAPI) crossfade the palette. Per-stage `theme` override already works (a scene stage emits `transitionTheme`). Votes and the LLM director can also drive theme changes.
- **No runtime editability** — adding/editing a theme requires source changes in 4+ files.

---

## 2. Core idea — phases bind to stages; standby is a stage facet

> **A "show phase" should be a binding from a named moment to a stage.** INTRO stops being a hardcoded screen and becomes "apply the stage bound to `intro`."

Two design decisions make this work without losing anything:

1. **Standby becomes an optional *facet* of a stage, not a new `kind`.** Add an optional `standby` block to the stage model. Any stage of any kind can carry it. This is what makes "any of scene/youtube/video/image could be used for show controls" true — a video stage can *also* carry holding-screen copy.
2. **Phase→stage bindings live next to `active`/`titleDefault`** in `state/stages.json`. The Show Control buttons apply the bound stage. Defaults point at builtin standby stages, so behaviour is unchanged out of the box.

This means the INTRO button stays (fast during a live show) but is now backed by an **editable** stage.

---

## 3. Data model changes

### 3a. New `standby` facet on a stage
```jsonc
"standby": {
  "mode": "intro" | "break" | "technical" | "outro",  // base styling + default copy
  "title": "",        // blank = mode default ("Stream starting shortly", etc.)
  "subtitle": "",     // blank = mode default
  "scrim": 0.0        // PHASE 2: 0 = source fully visible behind text … 1 = opaque cover (today's look)
}
```
- Absent `standby` ⇒ the stage is a normal live stage (no holding overlay).
- `mode` selects the existing hardcoded base styling (intro pulse bars, technical warning palette, outro credits layout). `title`/`subtitle` override the preset copy (already supported by `setStandby`).
- `scrim` is **Phase 2** — see §5. In Phase 1, standby is always the opaque cover we have today.

### 3b. New `phases` map in `state/stages.json`
```jsonc
"phases": {
  "intro":     "intro-default",
  "break":     "break-default",
  "technical": "tech-default",
  "outro":     "outro-default",
  "live":      "scene"          // what GO ON AIR returns to (NOT a holding screen); null = "last non-standby stage"
}
```
- `live` is special: it is the stage GO ON AIR transitions *to* (clears standby). It carries no `standby` facet.
- Deleting a stage that's bound to a phase ⇒ rebind that phase to its builtin default (never leave a phase dangling).

### 3c. New builtin phase stages (reproduce today exactly — back-compat)
```jsonc
{ "id": "intro-default", "label": "Intro · Starting Soon", "kind": "scene",
  "standby": { "mode": "intro", "title": "Stream starting shortly",
               "subtitle": "sit tight — the show's about to begin" },
  "desc": "pre-show holding screen" }
// + break-default, tech-default, outro-default (mirroring the current presets)
```

### Example custom intro (the payoff)
```jsonc
{ "id": "s7", "label": "Intro · Lofi Loop", "kind": "video",
  "url": "https://…/lofi.mp4", "muted": false,
  "headline": "STARTING SOON", "titleAnim": "fade",
  "standby": { "mode": "intro", "title": "", "subtitle": "", "scrim": 0.4 },
  "features": { "votes": false, "superchats": true, "effects": true } }
```
Rebind `phases.intro → "s7"` and the INTRO button now shows a lofi video loop with "STARTING SOON" over it — no code, just data.

---

## 4. Apply-path changes

- **`normalize()` (stages.js):** accept + validate a `standby` block (clamp `title`/`subtitle` like the other text fields; validate `mode` against the standby modes; clamp `scrim` to 0..1).
- **`buildApplyDirectives()` (stages.js):** if `stage.standby` present, emit `setStandby({mode, title, subtitle, scrim})`; if absent, emit `setStandby({mode:"off"})` so switching from a standby stage to a live stage clears the overlay. Keep the existing source/theme/title/ticker/feature sequence.
- **`POST /admin/show` (admin.js):** rewire to resolve the phase → stage and call the stage-apply path.
  - `standby:intro|break|technical` → apply `phases.intro|break|technical`.
  - `onair` → `setCountdown` then apply `phases.live` (clears standby; keeps the DJ→live-queue switch).
  - `outro` → apply `phases.outro`; keep the outro-specific extras (artist roll, music fade, `setStageSource:none`) layered on top (see open decision §7.2).
- **`setStandby` (scene.js):** already data-driven for copy. Phase 2 adds `scrim`.
- **New endpoint:** `POST /admin/stages/phase { phase, stageId }` to rebind. `GET /admin/stages` also returns `phases`.

---

## 5. Phasing

**Phase 1 — Unify show controls into stages.** (High value, contained, no scene rewrite.)
`standby` facet + `phases` map + builtin phase stages + rewired `POST /admin/show` + dashboard editor "STANDBY" section + bind-to-phase control. Standby remains the opaque cover (today's look). Back-compat guaranteed by the builtin phase stages.

**Phase 2 — Scrim standby.** (Small scene change, big visual payoff.)
Add `standby.scrim`/backdrop so the holding text sits over a *visible*, dimmed source instead of an opaque cover. Touches `setStandby` (scene.js) + a CSS class in `styles.css`. Unlocks "text over a lofi loop" intros. Depends on Phase 1's facet.

**Phase 3 — Editable themes.** (Independent track, heavier.)
- `state/themes.json` custom-theme registry: `{ name, c1, c2, c3, bgGrad? }`.
- New SceneAPI `defineTheme` action that injects a `.theme-<name>` rule (or sets CSS vars) at runtime.
- Dashboard theme editor: 3 accent-color pickers; gradient auto-derived from the accents (matching how `sceneSwatch` already previews).
- **Collapse the 4 duplicated theme lists into one served list** (builtins + customs) so `votes.js`/`llm-director.js`/`THEME_COLS` stop drifting — worth doing regardless of the editor.

Recommended order: **1 → 2 → 3.**

---

## 6. Dashboard UX

### Editor gains a STANDBY section + bind control
```
EDIT STAGE — Intro · Lofi Loop
  [Intro · Lofi Loop        ]  [video ▾]
  [https://…/lofi.mp4                      ]   ☐ mute audio
  ── overlay — shown on top of the stage ──
  ☑ titles  anim[fade ▾]   ☑ ticker   ☑ vibe
  headline [STARTING SOON                  ]
  ── standby — holding-screen treatment ──            ← NEW
  ☑ use as a standby screen
     mode [intro ▾]  (intro/break/technical/outro)
     title    [ blank = mode default        ]
     subtitle [ blank = mode default        ]
     backdrop ( ) solid cover  (•) scrim over source  dim[40%]   ← PHASE 2
  bind to show phase: [⏮ INTRO ▾]                     ← NEW
  ── features — chat-driven behaviours ──
  ☑ votes  ☑ superchats  ☐ effects  …
  [cancel]  [✓ SAVE]
```
A bound stage in the list shows a phase chip, e.g. `Intro · Lofi Loop  [video]  [⏮ INTRO]`, with the standby copy in its subline. The left-rail SHOW CONTROL buttons are unchanged — they just apply these editable stages now.

### OPEN: where do the phase→stage bindings surface? (three candidate layouts)

**Option A — Phases strip in the STAGES tab** (recommended): a binding map pinned to the top of STAGES; phase chips on bound rows.
```
SHOW PHASES — what each control button shows
⏮ INTRO → Intro · Starting Soon  [change▾]
⏸ BREAK → Break · BRB            [change▾]
⚠ TECH  → Tech · Difficulties    [change▾]
⏹ OUTRO → Outro · Credits Roll   [change▾]
▶ LIVE  → HyperLive Scene ●on air[change▾]
```

**Option B — On the SHOW CONTROL buttons:** each left-rail button shows its bound stage + a ✎ that jumps to that stage's editor. STAGES tab unchanged except a small chip on bound rows.

**Option C — Dedicated PHASES sub-tab:** a new top-level view (FEED/USERS/AUTOS/STAGES/PHASES) devoted to the 5 phase slots.

These aren't strictly exclusive (A + B compose well). **No decision made yet.**

---

## 7. Open decisions (to settle on revisit)

1. **Left-rail buttons:** keep the quick-access SHOW CONTROL buttons (recommended — fast mid-show), or move everything into STAGES?
2. **Outro specialness:** keep credits/artist-roll/links as outro-only behaviour (recommended for v1), or make them editable stage fields?
3. **Themes scope (Phase 3):** 3-accent-colors + auto-gradient (recommended, safe) vs. full gradient/grid editing.
4. **Bindings UI:** Option A / B / C (or A+B) from §6.
5. **Can one stage bind to multiple phases?** (e.g. same screen for break + technical.) Probably yes — bindings are a map *to* stages, many-to-one is fine.

---

## 8. Risks & back-compat

- **No regression:** builtin phase stages reproduce the current standby modes; default `phases` map points at them. Existing `setStandby` calls and `live.sh` verbs keep working.
- **Scrim (Phase 2)** is the only scene-render change; gate it behind the new `scrim` field so opaque remains the default.
- **Theme injection (Phase 3)** is the riskiest piece (runtime CSS into the live scene) — validate color inputs hard; keep builtins immutable; customs are additive.
- **Quota / perf:** none — all of this is local control-plane + scene directives; no new YouTube API usage.

---

## 9. File-by-file change checklist (for execution later)

**Phase 1**
- `packages/ingest/src/stages.js` — `normalize()` (standby facet), `buildApplyDirectives()` (emit `setStandby` / `off`), `BUILTINS` (+4 phase stages), state shape (+`phases`), `listStages()` (return `phases`), helpers to get/set a phase binding + dangling-rebind on delete.
- `packages/ingest/src/admin.js` — rewire `POST /admin/show` to resolve phase→stage→apply; add `POST /admin/stages/phase`; include `phases` in `GET /admin/stages`.
- `packages/dashboard/index.html` — STAGES editor "STANDBY" section + bind-to-phase control; phase chips on rows; the chosen bindings-UI layout (§6).

**Phase 2**
- `packages/streamer/scene/scene.js` — `setStandby` honors `scrim`/backdrop.
- `packages/streamer/scene/styles.css` — scrim variant of the standby layer.
- `stages.js` normalize/build — pass `scrim` through.

**Phase 3**
- `state/themes.json` (new) + a themes module (load/list/add/edit/persist).
- `packages/streamer/src/index.js` — allow + wire a `defineTheme` action.
- `packages/streamer/scene/scene.js` — `defineTheme` injects the rule / sets vars; merge custom themes into `THEMES`.
- Replace the 4 hardcoded theme lists with a single served list; dashboard fetches it (kills `THEME_COLS` drift); add the theme editor UI.

---

## 10. Tests to add
- `chooseBroadcast`-style pure-unit coverage for: standby normalize (clamps, mode validation, scrim range), `buildApplyDirectives` emitting `setStandby` on/off correctly, phase rebind + dangling-delete rebind, and (Phase 3) custom-theme validation + merge.
