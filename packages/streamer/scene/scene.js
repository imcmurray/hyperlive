/* ===========================================================================
   SceneAPI — the ONLY surface through which the scene can be mutated.

   Safe-template rule: the outside world sends a named action + plain params,
   never HTML/code. Each method sanitises input and drives GSAP/DOM. Visuals are
   layered + lightweight (software-render friendly): radial-gradient auras,
   transforms, opacity crossfades, a capped canvas particle field — no big blur
   filters, no WebGL.
=========================================================================== */
(() => {
  "use strict";

  const gsap = window.gsap;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const THEMES = [
    "synthwave", "sunrise", "mono", "forest", "aurora", "ember",
    "midnight", "vapor", "matrix", "gold", "crimson",
    "neon", "dusk", "ocean", "lava", "frost", "glitch", "retro", "void", "plasma", "noir", "solar", "holo",
  ];
  const TIERS = ["small", "medium", "large"];
  const EFFECTS = [
    "particles", "rays", "scanlines", "grain", "vignette", "bokeh", "bars", "fog", "sweep",
    "grid", "chroma", "holoscan", "dust", "datarain", "sparks", "lightning", "filmburn", "ripple",
  ];

  const clampNum = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  function clean(text, max = 180) {
    return String(text ?? "")
      // fold "fancy" Unicode (Mathematical Alphanumeric Symbols, fullwidth, etc.)
      // to plain ASCII — e.g. 𝓙𝓸𝓼𝓲𝓮 → Josie — so names render as letters instead
      // of tofu blocks (the container's fonts don't cover U+1D400…). NFKC keeps
      // real accents, ✓, and emoji intact.
      .normalize("NFKC")
      .replace(/[\x00-\x1f]/g, " ")
      .replace(/[<>]/g, "")
      .slice(0, max)
      .trim();
  }
  function setStatus(text, show = true) {
    const el = $("#status");
    if (!el) return;
    el.textContent = clean(text, 80);
    el.dataset.show = show ? "true" : "false";
  }

  function showWarning(on) {
    const el = $("#render-warning");
    if (el) el.dataset.show = on ? "true" : "false";
  }

  // the subtle "current vibe" chip (Mood Engine descriptor), fade-swapped
  function showVibe(text) {
    const el = $("#vibe");
    if (!el) return;
    const t = clean(text, 48);
    if (!t) { el.dataset.show = "false"; return; }
    el.dataset.show = "true";
    if (!gsap) { el.textContent = t; return; }
    gsap.killTweensOf(el, "opacity,y");
    gsap.to(el, { opacity: 0, y: -6, duration: 0.25, ease: "power2.in", onComplete: () => {
      el.textContent = t;
      gsap.fromTo(el, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
    } });
  }

  // ---- collective theme vote panel ----------------------------------------
  // The engine owns the ballot state; the scene only renders. Options arrive
  // pre-validated (known theme keys + labels); we clean() defensively anyway.
  let voteTickerFn = null;   // per-frame countdown updater (real-time based)
  let voteGraceTimer = null; // auto-dismiss fallback if voteEnd never arrives
  let voteHideTl = null;
  let voteActive = false;    // a round is on screen (until its countdown + result finish)
  let voteEndsAt = 0;        // when the current countdown is due (for stale-round recovery)
  let voteKeys = "";         // the live round's locked option keys — reject foreign updates
  let npBgTween = null;      // now-playing cover Ken Burns drift
  let coverLayer = 0;        // which full-stage cover layer is visible (0=a, 1=b)
  let npImg = "";            // current cover url (restart the drift only on track change)
  let countdownCalls = [];   // the running "going live" countdown's scheduled ticks

  // ---- full-stage cover backdrop: crossfade between songs, slow drift + a
  // gentle focus pull (unblur → reblur) for life. Two layers crossfade.
  function startCoverDrift(el) {
    if (!gsap || !el) return;
    gsap.killTweensOf(el, "scale,x,y");
    gsap.fromTo(el, { scale: 1.06, x: -16, y: 9 },
      { scale: 1.18, x: 16, y: -11, duration: 30, ease: "sine.inOut", yoyo: true, repeat: -1 });
    if (el._blur) el._blur.kill();
    const f = { b: 17 };
    const apply = () => { el.style.filter = `blur(${f.b.toFixed(1)}px) saturate(1.2) brightness(0.85)`; };
    apply();
    el._blur = gsap.to(f, { b: 8, duration: 13, ease: "sine.inOut", yoyo: true, repeat: -1, onUpdate: apply });
  }
  function setStageCover(img) {
    const a = $("#cover-bg-a"), b = $("#cover-bg-b");
    if (!a || !b || !gsap) return;
    document.body.classList.toggle("has-cover", !!img);
    const layers = [a, b];
    const cur = layers[coverLayer];
    if (!img) { // no cover → fade both out, stop their drifts
      for (const el of layers) { gsap.killTweensOf(el, "scale,x,y"); if (el._blur) { el._blur.kill(); el._blur = null; } gsap.to(el, { opacity: 0, duration: 1.3, ease: "sine.inOut" }); }
      return;
    }
    const next = layers[coverLayer ^ 1];
    next.style.backgroundImage = `url("${img}")`;
    startCoverDrift(next);
    gsap.fromTo(next, { opacity: 0 }, { opacity: 0.6, duration: 1.6, ease: "sine.inOut" });
    // fade the outgoing layer out + stop its drift/blur (no point re-blurring it)
    gsap.killTweensOf(cur, "scale,x,y"); if (cur._blur) { cur._blur.kill(); cur._blur = null; }
    gsap.to(cur, { opacity: 0, duration: 1.5, ease: "sine.inOut" });
    coverLayer ^= 1;
  }
  function voteShow(on) {
    const el = $("#vote");
    if (!el) return;
    el.dataset.show = on ? "true" : "false";
  }
  // tear down a round cleanly (used by voteEnd and the no-voteEnd safety fallback)
  function voteTeardown() {
    if (voteTickerFn && window.gsap) { window.gsap.ticker.remove(voteTickerFn); voteTickerFn = null; }
    if (voteGraceTimer) { clearTimeout(voteGraceTimer); voteGraceTimer = null; }
    voteActive = false; voteKeys = "";
  }
  // Render/update the option rows IN PLACE keyed by theme, so a round's locked
  // options keep stable rows — only counts, bars, and the leader highlight
  // change (bars tween from their current width, never rebuild from 0).
  function renderVoteOptions(options, leaderKey) {
    const wrap = $("#vote-options");
    if (!wrap) return;
    const opts = (Array.isArray(options) ? options : [])
      .filter((o) => o && THEMES.includes(o.key))
      .slice(0, 3); // a vote shows at most 3 options (engine guarantees at least 2)
    const max = Math.max(1, ...opts.map((o) => Number(o.votes) || 0));
    const seen = new Set();
    for (const o of opts) {
      const votes = Math.max(0, Math.round(Number(o.votes) || 0));
      const pct = Math.round((votes / max) * 100);
      seen.add(o.key);
      let row = wrap.querySelector('.vote-opt[data-key="' + o.key + '"]');
      if (!row) {
        row = document.createElement("div");
        row.className = "vote-opt";
        row.dataset.key = o.key;
        const name = document.createElement("span");
        name.className = "vote-name";
        name.textContent = clean(o.label || o.key, 18);
        const count = document.createElement("span");
        count.className = "vote-count";
        const bar = document.createElement("div");
        bar.className = "vote-opt-bar";
        const fill = document.createElement("i");
        fill.style.width = "0%";
        bar.appendChild(fill);
        row.append(name, count, bar);
        wrap.appendChild(row);
      }
      row.classList.toggle("leader", o.key === leaderKey);
      const count = row.querySelector(".vote-count");
      if (count) count.textContent = String(votes);
      const fill = row.querySelector(".vote-opt-bar i");
      if (fill) {
        if (gsap) gsap.to(fill, { width: pct + "%", duration: 0.45, ease: "power2.out", overwrite: "auto" });
        else fill.style.width = pct + "%";
      }
    }
    // drop any stale rows (locked rounds won't hit this; defensive across rounds)
    for (const row of Array.from(wrap.querySelectorAll(".vote-opt"))) {
      if (!seen.has(row.dataset.key)) row.remove();
    }
  }

  // ---- background crossfade state -----------------------------------------
  const layers = [$("#bg-a"), $("#bg-b")];
  let active = 0;            // index of the visible layer
  let currentTheme = "synthwave";
  let transitioning = false;

  // ---- particle field (canvas, only runs while enabled) -------------------
  const particles = { canvas: null, ctx: null, items: [], on: false, raf: 0, rgb: "182,255,94" };

  // ---- live intensity (0..1): a single eased scalar the render loops read
  // each frame, so "energy" changes drift smoothly with no re-seed pops. Driven
  // by setIntensity / setMood (the Collective Mood Engine). ---------------------
  const intensity = { v: 0.5 };
  let ambientBurstTimer = null; // setMood's gentle recurring burst scheduler
  const moodFxOn = {};          // last on/off the mood engine set per effect (hysteresis)

  function hexToRgb(hex) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return "182,255,94";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  function retint() {
    const c3 = getComputedStyle(document.body).getPropertyValue("--c3");
    particles.rgb = hexToRgb(c3);
  }
  function seedParticles() {
    const W = 1280, H = 720;
    particles.items = Array.from({ length: 80 }, () => ({ // pool; how many draw scales with intensity
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.6 + Math.random() * 2,
      vy: 0.15 + Math.random() * 0.55,
      drift: (Math.random() - 0.5) * 0.4,
      ph: Math.random() * Math.PI * 2,
      a: 0.15 + Math.random() * 0.5,
    }));
  }
  function tickParticles() {
    if (!particles.on || !particles.ctx) return;
    const { ctx } = particles, W = 1280, H = 720;
    ctx.clearRect(0, 0, W, H);
    // intensity drives both how many particles draw and how fast they rise
    const activeN = Math.round(18 + intensity.v * 62);   // 18..80
    const vMul = 0.5 + intensity.v * 1.3;                 // 0.5..1.8
    for (let i = 0; i < activeN && i < particles.items.length; i++) {
      const p = particles.items[i];
      p.y -= p.vy * vMul;
      p.ph += 0.01;
      p.x += Math.sin(p.ph) * 0.3 + p.drift;
      if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
      if (p.x < -4) p.x = W + 4; else if (p.x > W + 4) p.x = -4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${particles.rgb},${p.a})`;
      ctx.fill();
    }
    particles.raf = requestAnimationFrame(tickParticles);
  }
  // "on" opacity per effect, and where each lives in the DOM
  const FX_OPACITY = {
    particles: 1, rays: 0.7, scanlines: 0.3, grain: 0.06, vignette: 1,
    bokeh: 0.6, bars: 0.9, fog: 0.5, sweep: 0.5,
    grid: 0.5, chroma: 0.6, holoscan: 0.5, dust: 0.5,
  };
  const FX_SEL = {
    rays: "#fx-rays", scanlines: ".ovl-scanlines", grain: ".ovl-grain", vignette: ".ovl-vignette",
    bokeh: "#fx-bokeh", bars: "#fx-bars", fog: "#fx-fog", sweep: "#fx-sweep",
    grid: "#fx-grid", chroma: ".ovl-chroma", holoscan: ".ovl-holoscan", dust: "#fx-dust",
  };
  // effects driven by timers that spawn transient flashes (not steady elements)
  const PERIODIC = new Set(["sparks", "lightning", "filmburn", "ripple"]);
  const periodicTimers = {};

  // build the decorative children for the richer effects (kept out of HTML)
  function buildDecor() {
    const bokeh = $("#fx-bokeh");
    if (bokeh && !bokeh.childElementCount) {
      for (let i = 0; i < 9; i++) {
        const o = document.createElement("span");
        o.className = "orb";
        const s = 60 + Math.random() * 130;
        o.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${s}px;height:${s}px`;
        bokeh.appendChild(o);
      }
    }
    const fog = $("#fx-fog");
    if (fog && !fog.childElementCount) for (let i = 0; i < 3; i++) { const b = document.createElement("span"); b.className = "fog-band"; fog.appendChild(b); }
    const bars = $("#fx-bars");
    if (bars && !bars.childElementCount) for (let i = 0; i < 28; i++) { const b = document.createElement("span"); b.className = "bar"; bars.appendChild(b); }
    const dust = $("#fx-dust");
    if (dust && !dust.childElementCount) {
      for (let i = 0; i < 16; i++) {
        const d = document.createElement("span");
        d.className = "dustmote";
        const s = 1.5 + Math.random() * 2.5;
        d.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${s}px;height:${s}px`;
        dust.appendChild(d);
      }
    }
  }

  // ---- data rain (matrix-style canvas) ------------------------------------
  const rain = { canvas: null, ctx: null, cols: [], on: false, raf: 0 };
  const GLYPHS = "ｱｲｳｴｵｶｷｸｹ0123456789ABCDEF#$%&";
  function seedRain() {
    const step = 30; // px between columns
    rain.cols = [];
    for (let x = 0; x < 1280; x += step) rain.cols.push({ x, y: Math.random() * -720, sp: 6 + Math.random() * 10 });
  }
  function tickRain() {
    if (!rain.on || !rain.ctx) return;
    const { ctx } = rain;
    ctx.fillStyle = "rgba(0,0,0,0.12)"; // trail fade
    ctx.fillRect(0, 0, 1280, 720);
    const c3 = getComputedStyle(document.body).getPropertyValue("--c3").trim() || "#c8ff00";
    ctx.font = "16px 'Liberation Mono', monospace";
    ctx.fillStyle = c3;
    for (const col of rain.cols) {
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillText(ch, col.x, col.y);
      col.y += col.sp * (0.6 + intensity.v); // intensity speeds the fall
      if (col.y > 740) { col.y = Math.random() * -200; col.sp = 6 + Math.random() * 10; }
    }
    rain.raf = requestAnimationFrame(tickRain);
  }
  function setDataRain(on, dur) {
    const c = rain.canvas;
    if (!c) return;
    if (on) {
      rain.on = true; seedRain(); if (rain.ctx) rain.ctx.clearRect(0, 0, 1280, 720);
      c.classList.remove("is-off");
      cancelAnimationFrame(rain.raf); tickRain();
      if (gsap) { gsap.killTweensOf(c, "opacity"); gsap.fromTo(c, { opacity: 0 }, { opacity: 1, duration: dur, ease: "power2.out", overwrite: "auto" }); }
    } else if (gsap) {
      gsap.killTweensOf(c, "opacity");
      gsap.to(c, { opacity: 0, duration: dur, ease: "power2.in", overwrite: "auto",
        onComplete: () => { rain.on = false; cancelAnimationFrame(rain.raf); rain.ctx && rain.ctx.clearRect(0, 0, 1280, 720); c.classList.add("is-off"); } });
    } else { rain.on = false; cancelAnimationFrame(rain.raf); c.classList.add("is-off"); }
  }

  // ---- periodic transient effects -----------------------------------------
  function spawnSpark() {
    const host = $("#fx-sparks"); if (!host || !gsap) return;
    const cx = 100 + Math.random() * 1080, cy = 100 + Math.random() * 480;
    for (let i = 0; i < 12; i++) {
      const s = document.createElement("span"); s.className = "spark";
      s.style.left = cx + "px"; s.style.top = cy + "px"; host.appendChild(s);
      const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 70;
      gsap.to(s, { x: Math.cos(a) * d, y: Math.sin(a) * d, opacity: 0, scale: 0.4, duration: 0.6 + Math.random() * 0.5, ease: "power2.out", onComplete: () => s.remove() });
    }
  }
  function spawnLightning() {
    const host = $("#fx-lightning"); if (!host || !gsap) return;
    const bolt = document.createElement("span"); bolt.className = "bolt";
    bolt.style.left = (10 + Math.random() * 80) + "%";
    bolt.style.height = (40 + Math.random() * 45) + "%";
    bolt.style.transform = `skewX(${(Math.random() * 20 - 10)}deg)`;
    host.appendChild(bolt);
    gsap.fromTo(bolt, { opacity: 0.95 }, { opacity: 0, duration: 0.28, ease: "power2.in", onComplete: () => bolt.remove() });
  }
  function flashFilmburn() {
    const el = $(".ovl-filmburn"); if (!el || !gsap) return;
    el.classList.remove("is-off");
    gsap.fromTo(el, { opacity: 0 }, { opacity: 0.7, duration: 0.4, ease: "power2.out", yoyo: true, repeat: 1 });
  }
  function spawnRipple() {
    const host = $("#fx-ripple"); if (!host || !gsap) return;
    const r = document.createElement("span"); r.className = "ring";
    const size = 40; r.style.width = size + "px"; r.style.height = size + "px";
    r.style.left = (Math.random() * 1100) + "px"; r.style.top = (Math.random() * 560) + "px";
    host.appendChild(r);
    gsap.fromTo(r, { scale: 0.2, opacity: 0.5 }, { scale: 10, opacity: 0, duration: 2.2, ease: "power1.out", onComplete: () => r.remove() });
  }
  const PERIODIC_FN = { sparks: spawnSpark, lightning: spawnLightning, filmburn: flashFilmburn, ripple: spawnRipple };
  const PERIODIC_GAP = { sparks: [1.5, 4], lightning: [2.5, 6], filmburn: [4, 9], ripple: [2, 5] };

  function setPeriodic(effect, on) {
    if (periodicTimers[effect]) { periodicTimers[effect].kill(); delete periodicTimers[effect]; }
    const host = $(FX_SEL_PERIODIC[effect]);
    if (host) host.classList.toggle("is-off", !on);
    if (!on || !gsap) return;
    const [lo, hi] = PERIODIC_GAP[effect];
    const loop = () => {
      PERIODIC_FN[effect]();
      const scale = Math.max(0.4, 1.5 - intensity.v); // higher intensity → shorter gaps (more frequent)
      periodicTimers[effect] = gsap.delayedCall((lo + Math.random() * (hi - lo)) * scale, loop);
    };
    loop();
  }
  const FX_SEL_PERIODIC = { sparks: "#fx-sparks", lightning: "#fx-lightning", filmburn: ".ovl-filmburn", ripple: "#fx-ripple" };

  // fade a DOM-based effect in/out (display none ⇄ tweened opacity)
  function fadeEffect(node, on, target, dur) {
    if (!node) return;
    if (!gsap) { node.classList.toggle("is-off", !on); if (on) node.style.opacity = target; return; }
    gsap.killTweensOf(node, "opacity");
    if (on) {
      node.classList.remove("is-off");
      gsap.fromTo(node, { opacity: 0 }, { opacity: target, duration: dur, ease: "power2.out", overwrite: "auto" });
    } else {
      gsap.to(node, { opacity: 0, duration: dur, ease: "power2.in", overwrite: "auto",
        onComplete: () => node.classList.add("is-off") });
    }
  }

  function setParticles(on, dur) {
    const c = particles.canvas;
    if (!c) return;
    if (on) {
      particles.on = true;
      retint(); seedParticles();
      c.classList.remove("is-off");
      cancelAnimationFrame(particles.raf); tickParticles();
      if (gsap) { gsap.killTweensOf(c, "opacity"); gsap.fromTo(c, { opacity: 0 }, { opacity: 1, duration: dur, ease: "power2.out", overwrite: "auto" }); }
    } else if (gsap) {
      // keep drawing while it fades, then stop the RAF + clear
      gsap.killTweensOf(c, "opacity");
      gsap.to(c, { opacity: 0, duration: dur, ease: "power2.in", overwrite: "auto",
        onComplete: () => { particles.on = false; cancelAnimationFrame(particles.raf); particles.ctx && particles.ctx.clearRect(0, 0, 1280, 720); c.classList.add("is-off"); } });
    } else {
      particles.on = false; cancelAnimationFrame(particles.raf); particles.ctx && particles.ctx.clearRect(0, 0, 1280, 720); c.classList.add("is-off");
    }
  }

  // ---- charming viewer reactions (emoji → instant micro-effects) ----------
  function reactHost() { return $("#fx-react"); }
  function floatName(text, x, y, color) {
    const host = reactHost(); if (!host || !gsap) return;
    const t = clean(text, 28); if (!t) return;
    const el = document.createElement("span"); el.className = "react-name";
    el.textContent = t; el.style.left = x + "px"; el.style.top = y + "px";
    if (color) el.style.color = color;
    host.appendChild(el);
    gsap.fromTo(el, { opacity: 0, y: 6, scale: 0.85 }, { opacity: 1, y: -6, scale: 1, duration: 0.45, ease: "back.out(2)" });
    gsap.to(el, { opacity: 0, y: -42, duration: 1.5, delay: 1.1, ease: "power1.in", onComplete: () => el.remove() });
  }
  // a circular avatar: real profile image, else a deterministic colored-initial circle
  function avatarColor(name) {
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 58%, 46%)`;
  }
  // strict: only plain https URLs (no quotes/parens/spaces) — safe for url() interpolation
  function safeAvatarUrl(u) { return typeof u === "string" && /^https:\/\/[^\s"')<>]+$/i.test(u) ? u : ""; }
  function avatarEl(who, url, size) {
    const el = document.createElement("span"); el.className = "avatar";
    el.style.width = el.style.height = size + "px";
    const name = (clean(who, 24) || "?").replace(/^@/, "");
    const safe = safeAvatarUrl(url);
    if (safe) {
      const img = document.createElement("img");
      img.referrerPolicy = "no-referrer"; img.alt = "";
      img.onerror = () => { img.remove(); el.style.background = avatarColor(name); el.style.fontSize = Math.round(size * 0.45) + "px"; el.textContent = name.charAt(0).toUpperCase(); };
      img.src = safe; el.appendChild(img);
    } else {
      el.style.background = avatarColor(name); el.style.fontSize = Math.round(size * 0.45) + "px";
      el.textContent = name.charAt(0).toUpperCase();
    }
    return el;
  }
  function rspark(cx, cy, n, cls, spread, up) {
    const host = reactHost(); if (!host || !gsap) return;
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span"); s.className = "rspark" + (cls ? " " + cls : "");
      s.style.left = cx + "px"; s.style.top = cy + "px"; host.appendChild(s);
      const a = Math.random() * Math.PI * 2, d = spread * (0.4 + Math.random());
      gsap.to(s, { x: Math.cos(a) * d, y: Math.sin(a) * d - (up || 0), opacity: 0, scale: 0.35, duration: 0.7 + Math.random() * 0.5, ease: "power2.out", onComplete: () => s.remove() });
    }
  }
  function spawnFire() { rspark(200 + Math.random() * 880, 280 + Math.random() * 220, 14, "fire", 90, 30); }
  function spawnHearts(who) {
    const host = reactHost(); if (!host || !gsap) return;
    const cx = 220 + Math.random() * 840;
    for (let i = 0; i < 6; i++) {
      const h = document.createElement("span"); h.className = "heart"; h.textContent = "❤";
      h.style.left = (cx + (Math.random() - 0.5) * 150) + "px"; h.style.top = "640px"; host.appendChild(h);
      gsap.fromTo(h, { opacity: 0, scale: 0.4 }, { opacity: 0.92, scale: 0.7 + Math.random() * 0.6, duration: 0.3, ease: "back.out(2)", delay: i * 0.06 });
      gsap.to(h, { y: -(240 + Math.random() * 200), x: "+=" + ((Math.random() - 0.5) * 70), opacity: 0, duration: 2.1 + Math.random(), delay: 0.1 + i * 0.06, ease: "power1.out", onComplete: () => h.remove() });
    }
    if (who) floatName(who, cx, 600, "#ff8ac0");
  }
  function spawnSparkle() {
    const host = reactHost(); if (!host || !gsap) return;
    for (let i = 0; i < 9; i++) {
      const s = document.createElement("span"); s.className = "sparkle"; s.textContent = "✦";
      s.style.left = (Math.random() * 1180 + 50) + "px"; s.style.top = (Math.random() * 560 + 80) + "px"; host.appendChild(s);
      gsap.fromTo(s, { opacity: 0, scale: 0, rotation: -30 }, { opacity: 1, scale: 0.6 + Math.random() * 0.8, rotation: 30, duration: 0.35, ease: "back.out(3)", delay: Math.random() * 0.4 });
      gsap.to(s, { opacity: 0, scale: 0, duration: 0.5, delay: 0.55 + Math.random() * 0.5, ease: "power2.in", onComplete: () => s.remove() });
    }
  }
  const CONFETTI = ["#ff5ec4", "#5ec8ff", "#ffd25e", "#7dff8e", "#b07eff"];
  function spawnConfetti() {
    const host = reactHost(); if (!host || !gsap) return;
    const cx = 220 + Math.random() * 840;
    for (let i = 0; i < 20; i++) {
      const c = document.createElement("span"); c.className = "confetti-bit";
      c.style.background = CONFETTI[i % CONFETTI.length]; c.style.left = cx + "px"; c.style.top = "300px"; host.appendChild(c);
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 170;
      gsap.fromTo(c, { opacity: 1, scale: 1 }, { x: Math.cos(a) * d, y: Math.sin(a) * d + 140, rotation: Math.random() * 360, opacity: 0, duration: 1.3 + Math.random() * 0.8, ease: "power1.out", onComplete: () => c.remove() });
    }
  }
  function spawnWelcome(who, url) {
    const host = reactHost(); if (!host || !gsap) return;
    const cx = 340 + Math.random() * 600, cy = 250 + Math.random() * 190;
    const g = document.createElement("span"); g.className = "react-glow"; g.style.left = cx + "px"; g.style.top = cy + "px"; host.appendChild(g);
    gsap.fromTo(g, { scale: 0.2, opacity: 0.5 }, { scale: 2.4, opacity: 0, duration: 1.7, ease: "power2.out", onComplete: () => g.remove() });
    rspark(cx, cy, 7, "", 55, 0);
    // stacked + centered on the glow: avatar over "welcome" over the name
    const box = document.createElement("div"); box.className = "welcome-pop";
    box.style.left = cx + "px"; box.style.top = cy + "px";
    box.appendChild(avatarEl(who, url, 58));
    const w = document.createElement("div"); w.className = "welcome-word"; w.textContent = "welcome";
    box.appendChild(w);
    const nm = clean(who, 28);
    if (nm) { const n = document.createElement("div"); n.className = "welcome-name"; n.textContent = nm; box.appendChild(n); }
    host.appendChild(box);
    gsap.set(box, { xPercent: -50, yPercent: -50 }); // center the stack on (cx,cy) without fighting gsap's transform
    gsap.fromTo(box, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(2)" });
    gsap.to(box, { y: -28, opacity: 0, duration: 1.1, delay: 1.9, ease: "power1.in", onComplete: () => box.remove() });
  }
  const REACT_FN = {
    fire: () => spawnFire(), love: (who) => spawnHearts(who), sparkle: () => spawnSparkle(),
    laugh: () => spawnConfetti(), wow: () => spawnSparkle(),
    calm: () => rspark(200 + Math.random() * 880, 300 + Math.random() * 200, 6, "", 40, 0),
    welcome: (who, url) => spawnWelcome(who, url),
  };

  // ambient gentle burst scheduler driven by the mood's burst_frequency (0..1)
  function setBurstRate(rate) {
    if (ambientBurstTimer) { ambientBurstTimer.kill(); ambientBurstTimer = null; }
    rate = clampNum(rate, 0, 1, 0);
    if (rate <= 0.03 || !gsap) return;
    const schedule = () => {
      const gap = (10 - rate * 8) + Math.random() * 2; // rate 1 → ~2-4s; rate 0.1 → ~9-11s
      ambientBurstTimer = gsap.delayedCall(gap, () => { SceneAPI.burst({ intensity: 0.18 + rate * 0.35 }); schedule(); });
    };
    schedule();
  }

  // ---- bottom rotating cards (replaces the scrolling ticker) --------------
  // Discrete pop-in / hold / drop-off cards avoid the constant-velocity capture
  // judder a scrolling marquee suffers. Each card carries a progress line that
  // fills over the hold time so viewers see when the next one is coming.
  let tickerItems = [
    "👋 new here? just say hi",
    "drop a 🔥 — your emojis change the scene",
    "the whole chat is conducting the visuals",
    "react with ❤️ ✨ 😂 — try it",
  ];
  let tickIdx = 0;
  let tickTimer = null;
  const TICK_HOLD = 4.5; // seconds a card stays before it drops off
  let headlineGradTween = null; // the optional headline gradient pan

  function showTickCard() {
    const host = $("#ticker-cards");
    if (!host || !tickerItems.length) return;
    const text = tickerItems[tickIdx % tickerItems.length];
    tickIdx++;

    const card = document.createElement("div");
    card.className = "tcard";
    const label = document.createElement("span");
    label.className = "tcard-label";
    label.textContent = text;
    const DOTS = 5;
    const dotsWrap = document.createElement("div");
    dotsWrap.className = "tcard-dots";
    const dotEls = [];
    for (let i = 0; i < DOTS; i++) { const d = document.createElement("span"); d.className = "tcard-dot"; dotsWrap.appendChild(d); dotEls.push(d); }
    card.append(label, dotsWrap);
    host.appendChild(card);

    if (gsap) {
      gsap.fromTo(card, { y: 80, opacity: 0, scale: 0.9 },
        { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.7)" });
      // countdown: light one dot at a time across the hold (discrete pops, no
      // continuous motion → nothing to judder)
      const step = TICK_HOLD / DOTS;
      dotEls.forEach((d, i) => {
        gsap.delayedCall(0.45 + step * (i + 1), () => {
          d.classList.add("on");
          gsap.fromTo(d, { scale: 1 }, { scale: 1.35, duration: 0.4, ease: "back.out(4)" });
        });
      });
      gsap.to(card, { y: 120, opacity: 0, rotateZ: 3, duration: 0.55, delay: 0.5 + TICK_HOLD, ease: "power2.in",
        onComplete: () => card.remove() });
      tickTimer = gsap.delayedCall(0.5 + TICK_HOLD + 0.45, showTickCard);
    } else {
      setTimeout(() => card.remove(), (TICK_HOLD + 1) * 1000);
      tickTimer = setTimeout(showTickCard, (TICK_HOLD + 1.4) * 1000);
    }
  }

  function startTickerCards(items) {
    if (Array.isArray(items) && items.length) { tickerItems = items.slice(); tickIdx = 0; }
    if (tickTimer) { if (tickTimer.kill) tickTimer.kill(); else clearTimeout(tickTimer); tickTimer = null; }
    const host = $("#ticker-cards");
    if (host) host.textContent = "";
    showTickCard();
    return { ok: true, count: tickerItems.length };
  }

  // ---- ambient / secondary motion -----------------------------------------
  function startAmbient() {
    if (!gsap) return;
    window.__timelines = window.__timelines || {};

    // parallax drift on every aura (both layers always exist)
    gsap.to("#bg .aura-1", { x: 110, y: 70, duration: 13, yoyo: true, repeat: -1, ease: "sine.inOut" });
    gsap.to("#bg .aura-2", { x: -90, y: -60, duration: 16, yoyo: true, repeat: -1, ease: "sine.inOut" });
    gsap.to("#bg .aura-3", { x: 70, y: -80, duration: 10, yoyo: true, repeat: -1, ease: "sine.inOut", scale: 1.08 });

    // slow light-ray rotation
    gsap.to("#fx-rays", { rotation: 360, duration: 140, repeat: -1, ease: "none" });

    // spotlight sweep (always animating; only visible when toggled on)
    gsap.to("#fx-sweep", { rotation: 360, duration: 26, repeat: -1, ease: "none" });

    // bokeh orbs: independent slow drift + breathe
    $$("#fx-bokeh .orb").forEach((o) => {
      gsap.to(o, {
        x: Math.random() * 140 - 70, y: Math.random() * 140 - 70,
        scale: 0.7 + Math.random() * 0.8, opacity: 0.25 + Math.random() * 0.45,
        duration: 6 + Math.random() * 7, yoyo: true, repeat: -1, ease: "sine.inOut", delay: Math.random() * 3,
      });
    });

    // drifting fog bands
    $$("#fx-fog .fog-band").forEach((b, i) => {
      gsap.fromTo(b, { xPercent: -16 }, { xPercent: 16, duration: 18 + i * 6, yoyo: true, repeat: -1, ease: "sine.inOut" });
    });

    // equalizer bars (transform scaleY only — compositor friendly)
    $$("#fx-bars .bar").forEach((b) => {
      gsap.to(b, {
        scaleY: 0.2 + Math.random() * 0.85, duration: 0.32 + Math.random() * 0.5,
        yoyo: true, repeat: -1, ease: "sine.inOut", delay: Math.random() * 0.6,
      });
    });

    // holographic scan line sweeping top→bottom
    gsap.fromTo("#overlays .ovl-holoscan", { y: -90 }, { y: 720, duration: 5.5, repeat: -1, ease: "none" });

    // dust motes: slow tiny drift
    $$("#fx-dust .dustmote").forEach((d) => {
      gsap.to(d, {
        x: Math.random() * 80 - 40, y: Math.random() * 80 - 40, opacity: 0.1 + Math.random() * 0.3,
        duration: 8 + Math.random() * 8, yoyo: true, repeat: -1, ease: "sine.inOut", delay: Math.random() * 4,
      });
    });

    // scanline drift (compositor-cheap)
    gsap.to(".ovl-scanlines", { y: 3, duration: 2.2, yoyo: true, repeat: -1, ease: "none" });

    // ticker is set up separately (renderTicker) so it can rebuild seamlessly

    // secondary motion: slow headline float (transform only — kicker
    // letter-spacing animation removed; it caused per-frame layout reflow)
    gsap.to("#headline", { y: 6, duration: 4.5, yoyo: true, repeat: -1, ease: "sine.inOut" });

    // entrance
    gsap.from("#kicker", { opacity: 0, y: -20, duration: 0.8, ease: "power3.out" });
    gsap.from("#headline-inner", { opacity: 0, y: 40, duration: 1.0, delay: 0.15, ease: "power3.out" });
    gsap.from("#subhead", { opacity: 0, y: 24, duration: 1.0, delay: 0.35, ease: "power3.out" });
  }

  // ---- the crossfade ------------------------------------------------------
  // a crossfade requested mid-crossfade (e.g. a vote winner landing during a
  // showcase transition) is queued and applied when the current one completes —
  // dropping it would mean "X wins!" followed by… nothing
  let pendingTheme = null;
  function crossfade(theme, duration) {
    if (!THEMES.includes(theme)) theme = currentTheme;
    if (theme === currentTheme && !transitioning) return { theme: currentTheme };
    if (transitioning) { pendingTheme = { theme, duration }; return { theme: currentTheme, busy: true, queued: theme }; }
    const dur = clampNum(duration, 0.3, 4, 1.2);

    const incoming = layers[1 - active];
    const outgoing = layers[active];
    incoming.className = "bg-layer theme-" + theme;

    if (!gsap) {
      // no-anim fallback
      outgoing.classList.add("is-hidden");
      document.body.className = "theme-" + theme;
      active = 1 - active; currentTheme = theme; retint();
      return { theme };
    }

    // capture current vs target accent colors so the FOREGROUND (headline,
    // kicker, ticker, bars) crossfades in lock-step with the background instead
    // of popping at a midpoint class swap
    const cs = getComputedStyle;
    const i1 = gsap.utils.interpolate(cs(document.body).getPropertyValue("--c1").trim(), cs(incoming).getPropertyValue("--c1").trim());
    const i2 = gsap.utils.interpolate(cs(document.body).getPropertyValue("--c2").trim(), cs(incoming).getPropertyValue("--c2").trim());
    const i3 = gsap.utils.interpolate(cs(document.body).getPropertyValue("--c3").trim(), cs(incoming).getPropertyValue("--c3").trim());

    gsap.set(incoming, { opacity: 0, scale: 1.06 });
    gsap.set(outgoing, { opacity: 1, scale: 1 });
    transitioning = true;

    const prog = { p: 0 };
    const tl = gsap.timeline({
      onComplete() {
        outgoing.classList.add("is-hidden");
        // class now supplies the final colors; drop the inline tween overrides
        document.body.className = "theme-" + theme;
        ["--c1", "--c2", "--c3"].forEach((v) => document.body.style.removeProperty(v));
        active = 1 - active;
        currentTheme = theme;
        transitioning = false;
        retint();
        if (pendingTheme) { const p = pendingTheme; pendingTheme = null; crossfade(p.theme, p.duration); }
      },
    });
    tl.to(incoming, { opacity: 1, scale: 1, duration: dur, ease: "power2.inOut" }, 0);
    tl.to(outgoing, { opacity: 0, duration: dur, ease: "power2.inOut" }, 0);
    // interpolate the accent colors across the same window as the bg fade
    tl.to(prog, {
      p: 1, duration: dur, ease: "power1.inOut",
      onUpdate() {
        document.body.style.setProperty("--c1", i1(prog.p));
        document.body.style.setProperty("--c2", i2(prog.p));
        document.body.style.setProperty("--c3", i3(prog.p));
      },
    }, 0);
    return { theme, duration: dur };
  }

  // fill the outro credit roll with the unique Suno artists played this session
  function renderOutroCredits(artists) {
    const wrap = $("#sb-artists-wrap");
    const list = $("#sb-artists");
    const names = (Array.isArray(artists) ? artists : [])
      .map((a) => clean(a, 40)).filter(Boolean).slice(0, 48);
    if (list) list.textContent = names.join("   •   ");
    if (wrap) wrap.dataset.show = names.length ? "true" : "false";
  }

  // ---- Tier 1: director-mutable elements (data-hf-id + vetted ops) ---------
  // Upstream HyperFrames mints data-hf-id over every parsed element so tools
  // and models can target nodes by stable identity (#1269–#1299). The live-
  // broadcast translation is allowlist-FIRST: only elements registered here
  // are mutable, each with its own clamps. The director gets a manifest of
  // these (getElements), never a free DOM handle.
  const MUTABLES = [
    { role: "headline", sel: "#headline-inner", maxText: 90 },
    { role: "kicker", sel: "#kicker", maxText: 40, upper: true },
    { role: "subhead", sel: "#subhead", maxText: 160 },
  ];
  const TWEEN_CLAMPS = { x: [-200, 200], y: [-120, 120], scale: [0.5, 2], rotation: [-25, 25], opacity: [0.15, 1] };
  const TWEEN_EASES = ["power2.out", "power2.inOut", "sine.inOut", "back.out", "elastic.out"];
  const hfIndex = new Map(); // "hf-xxxx" AND role → registry entry
  function ensureHfIds() {
    for (const m of MUTABLES) {
      const el = $(m.sel);
      if (!el) continue;
      // deterministic mint from the role (stable across restarts — a director's
      // remembered ids stay valid), in upstream's hf- format
      let h = 0;
      for (const c of m.role) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      let id = "hf-" + h.toString(36).slice(-4).padStart(4, "0");
      while (hfIndex.has(id)) id += "x";
      el.dataset.hfId = id;
      const entry = { ...m, el, hfId: id };
      hfIndex.set(id, entry);
      hfIndex.set(m.role, entry); // the role is a friendlier alias
    }
  }

  // ---- Tier 2/3: sandboxed model-authored markup ---------------------------
  // Card/takeover html is MODEL-GENERATED and NEVER touches the stage DOM: it
  // renders inside <iframe sandbox> (no allow-scripts, no allow-same-origin →
  // opaque origin, nothing can script or escape) with CSP default-src 'none'
  // (no network, no external images/fonts; inline CSS only). The streamer
  // pre-renders + vision-checks BEFORE these methods are ever called.
  const CARD_W = 360, CARD_H = 250, CARD_HTML_MAX = 16384;
  let takeoverTimer = null;
  function sandboxedFrame(html, w, h) {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", ""); // fully sandboxed
    f.style.cssText = `width:${w}px;height:${h}px;border:0;display:block;background:transparent;`;
    f.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}</style></head><body>${html}</body></html>`;
    return f;
  }

  // ---- the action table ---------------------------------------------------
  const SceneAPI = {
    // Tier 1: the element manifest the director plans against
    getElements() {
      const out = [], seen = new Set();
      for (const e of hfIndex.values()) {
        if (seen.has(e.hfId)) continue;
        seen.add(e.hfId);
        out.push({
          id: e.hfId, role: e.role, text: clean(e.el.textContent, 60),
          ops: { setText: { maxLen: e.maxText }, tween: TWEEN_CLAMPS, reset: true },
        });
      }
      return { elements: out, eases: TWEEN_EASES, maxOpsPerCall: 4 };
    },

    // Tier 1: vetted, clamped ops against ONE registered element
    mutateElement(p = {}) {
      const entry = hfIndex.get(String(p.id || ""));
      if (!entry) return { ok: false, error: "unknown element — see getElements" };
      const el = entry.el;
      const ops = (Array.isArray(p.ops) ? p.ops : []).slice(0, 4);
      const applied = [];
      for (const op of ops) {
        const kind = String(op?.op || "");
        if (kind === "setText") {
          let text = clean(op.text, entry.maxText);
          if (!text) continue;
          if (entry.upper) text = text.toUpperCase();
          if (gsap) {
            gsap.killTweensOf(el, "opacity"); // preserve transform + gradient tweens
            const tl = gsap.timeline();
            tl.to(el, { opacity: 0, duration: 0.3, ease: "power2.in" });
            tl.add(() => { el.textContent = text; });
            tl.to(el, { opacity: 1, duration: 0.45, ease: "power2.out" });
          } else el.textContent = text;
          applied.push({ op: "setText", text });
        } else if (kind === "tween" && gsap) {
          const t = {
            duration: clampNum(op.duration, 0.2, 4, 1),
            ease: TWEEN_EASES.includes(op.ease) ? op.ease : "power2.inOut",
            overwrite: "auto",
          };
          for (const [prop, [lo, hi]] of Object.entries(TWEEN_CLAMPS)) {
            const v = Number(op[prop]);
            if (Number.isFinite(v)) t[prop] = Math.max(lo, Math.min(hi, v));
          }
          const rep = Math.round(clampNum(op.repeat, 0, 3, 0));
          if (rep) { t.repeat = rep; t.yoyo = op.yoyo !== false; }
          gsap.to(el, t);
          applied.push({ op: "tween" });
        } else if (kind === "reset") {
          if (gsap) {
            gsap.killTweensOf(el, "x,y,scale,rotation,opacity");
            gsap.to(el, { x: 0, y: 0, scale: 1, rotation: 0, duration: 0.5, ease: "power2.inOut",
              onComplete: () => gsap.set(el, { clearProps: "transform,opacity" }) });
          }
          applied.push({ op: "reset" });
        }
      }
      return applied.length
        ? { ok: true, id: entry.hfId, role: entry.role, applied }
        : { ok: false, error: "no valid ops" };
    },

    // Tier 2: show a (pre-vetted) viewer card in the sandboxed slot
    showCard(p = {}) {
      const html = String(p.html || "");
      if (!html.trim() || html.length > CARD_HTML_MAX) return { ok: false, error: "html missing or too large" };
      const slot = $("#card-slot");
      if (!slot) return { ok: false, error: "no card slot" };
      const ttl = clampNum(p.seconds, 4, 120, 20);
      slot.replaceChildren(); // one card at a time
      const wrap = document.createElement("div");
      wrap.className = "viewer-card";
      const label = document.createElement("div");
      label.className = "viewer-card-label";
      label.textContent = p.who ? `✦ card by ${clean(p.who, 24)}` : "✦ viewer card";
      wrap.appendChild(label);
      const frame = sandboxedFrame(html, CARD_W, CARD_H);
      wrap.appendChild(frame);
      slot.appendChild(wrap);
      if (gsap) {
        // sandboxed srcdoc iframes are out-of-process and paint lazily — start
        // the entrance only once the subdocument has loaded, or the card fades
        // in over blank pixels
        gsap.set(wrap, { opacity: 0, x: 46, scale: 0.92 });
        let revealed = false;
        const reveal = () => {
          if (revealed) return;
          revealed = true;
          gsap.to(wrap, { opacity: 1, x: 0, scale: 1, duration: 0.7, ease: "back.out(1.4)" });
        };
        frame.addEventListener("load", reveal, { once: true });
        gsap.delayedCall(1.5, reveal); // fallback if load never fires
        gsap.delayedCall(ttl, () => {
          gsap.to(wrap, { opacity: 0, x: 46, duration: 0.6, ease: "power2.in", onComplete: () => wrap.remove() });
        });
      }
      return { ok: true, seconds: ttl };
    },

    // operator kill for everything model-authored
    clearCards() {
      const s = $("#card-slot");
      if (s) s.replaceChildren();
      SceneAPI.endTakeover();
      return { ok: true };
    },

    // Tier 3: full-stage sandboxed takeover with a hard TTL
    takeover(p = {}) {
      const html = String(p.html || "");
      if (!html.trim() || html.length > CARD_HTML_MAX * 4) return { ok: false, error: "html missing or too large" };
      const host = $("#takeover");
      if (!host) return { ok: false, error: "no takeover layer" };
      const secs = clampNum(p.seconds, 5, 90, 20);
      const frame = sandboxedFrame(html, 1280, 720);
      host.replaceChildren(frame);
      host.dataset.show = "true";
      if (takeoverTimer) { takeoverTimer.kill(); takeoverTimer = null; }
      if (gsap) {
        // HARD CUT on load (TV-style). An animated opacity fade composites
        // sluggishly over the out-of-process sandboxed frame on the iGPU —
        // the cut both looks better for a takeover and sidesteps that.
        gsap.set(host, { opacity: 0 });
        let revealed = false;
        const reveal = () => {
          if (revealed) return;
          revealed = true;
          gsap.set(host, { opacity: 1 });
        };
        frame.addEventListener("load", reveal, { once: true });
        gsap.delayedCall(1.5, reveal); // fallback if load never fires
        takeoverTimer = gsap.delayedCall(secs, () => SceneAPI.endTakeover());
      }
      return { ok: true, seconds: secs };
    },

    endTakeover() {
      const host = $("#takeover");
      if (!host || host.dataset.show !== "true") return { ok: true, active: false };
      if (takeoverTimer) { takeoverTimer.kill(); takeoverTimer = null; }
      const done = () => { host.dataset.show = "false"; host.replaceChildren(); host.style.opacity = ""; };
      if (gsap) gsap.to(host, { opacity: 0, duration: 0.6, ease: "power2.in", onComplete: done });
      else done();
      return { ok: true, active: true };
    },
    // smooth by default now (back-compatible with existing setTheme callers)
    setTheme(p = {}) {
      const theme = THEMES.includes(p.theme) ? p.theme : "synthwave";
      crossfade(theme);
      return { theme };
    },

    // explicit smooth transition with optional duration (seconds)
    transitionTheme(p = {}) {
      const theme = THEMES.includes(p.theme) ? p.theme : currentTheme;
      return crossfade(theme, p.duration);
    },

    // Collective Mood Engine: ease the single "energy" scalar (0..1) toward a target
    setIntensity(p = {}) {
      const value = clampNum(p.value, 0, 1, 0.5);
      const dur = clampNum(p.duration, 0, 8, 2.5);
      if (gsap) { gsap.killTweensOf(intensity, "v"); gsap.to(intensity, { v: value, duration: dur, ease: "sine.inOut", overwrite: "auto" }); }
      else intensity.v = value;
      return { value };
    },

    // composite "vibe" directive emitted by the Mood Conductor once per tick.
    // Everything eases / rate-limits so the atmosphere DRIFTS, never jars.
    setMood(p = {}) {
      const out = {};
      const dur = clampNum(p.duration, 0.3, 8, 3);
      if (p.intensity !== undefined) out.intensity = SceneAPI.setIntensity({ value: p.intensity, duration: dur }).value;
      // theme: crossfade only if different + not mid-transition (engine paces cadence)
      if (p.theme && THEMES.includes(p.theme) && p.theme !== currentTheme && !transitioning) {
        crossfade(p.theme, clampNum(p.duration, 0.3, 4, 2));
        out.theme = p.theme;
      }
      // effect emphasis { name: -1..1 } → on/off with hysteresis (no strobing)
      if (p.effects && typeof p.effects === "object") {
        out.effects = {};
        for (const [fx, val] of Object.entries(p.effects)) {
          if (!EFFECTS.includes(fx)) continue;
          const e = clampNum(val, -1, 1, 0);
          const want = moodFxOn[fx] ? e > -0.05 : e > 0.25; // on>0.25, off<-0.05
          if (want !== !!moodFxOn[fx]) { SceneAPI.setEffect({ effect: fx, on: want, duration: 1.2 }); moodFxOn[fx] = want; out.effects[fx] = want; }
        }
      }
      if (p.burstRate !== undefined) setBurstRate(p.burstRate);
      if (p.headline) out.headline = SceneAPI.setHeadline({ text: p.headline }).text;
      if (p.subhead) out.subhead = SceneAPI.setSubhead({ text: p.subhead }).text;
      if (p.descriptor) { showVibe(p.descriptor); out.descriptor = clean(p.descriptor, 48); }
      return out;
    },

    setHeadline(p = {}) {
      const text = clean(p.text, 90) || "Hyperframes Live";
      const el = $("#headline-inner");
      if (!el) return { text };
      if (!gsap) { el.textContent = text; return { text }; }
      // kill only transform/opacity tweens (preserve the gradient pan tween)
      gsap.killTweensOf(el, "opacity,y");
      const tl = gsap.timeline();
      tl.to(el, { opacity: 0, y: -20, duration: 0.36, ease: "power2.inOut" });
      tl.add(() => { el.textContent = text; });
      tl.fromTo(el, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" });
      return { text };
    },

    // the small kicker label above the headline
    setKicker(p = {}) {
      const text = (clean(p.text, 40) || "HYPERFRAMES LIVE").toUpperCase();
      const el = $("#kicker");
      if (!el) return { text };
      if (!gsap) { el.textContent = text; return { text }; }
      gsap.killTweensOf(el);
      gsap.to(el, { opacity: 0, y: -8, duration: 0.25, ease: "power2.in",
        onComplete: () => {
          el.textContent = text;
          gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
        } });
      return { text };
    },

    // toggle a slow back-and-forth pan of the headline's gradient
    setHeadlineGradient(p = {}) {
      const el = $("#headline-inner");
      if (!el || !gsap) return { ok: false };
      if (headlineGradTween) { headlineGradTween.kill(); headlineGradTween = null; }
      const on = p.animate !== false;
      if (on) {
        const speed = clampNum(p.speed, 2, 30, 8); // seconds per sweep
        headlineGradTween = gsap.fromTo(el,
          { backgroundPosition: "0% 0%" },
          { backgroundPosition: "100% 0%", duration: speed, yoyo: true, repeat: -1, ease: "sine.inOut" });
      } else {
        gsap.set(el, { backgroundPosition: "0% 0%" });
      }
      return { animate: on };
    },

    setSubhead(p = {}) {
      const text = clean(p.text, 160);
      const el = $("#subhead");
      if (!el) return { text };
      if (!gsap) { el.textContent = text; return { text }; }
      gsap.to(el, {
        opacity: 0, y: 12, duration: 0.28, ease: "power2.in",
        onComplete: () => {
          el.textContent = text;
          gsap.fromTo(el, { opacity: 0, y: -10 }, { opacity: 0.8, y: 0, duration: 0.5, ease: "power2.out" });
        },
      });
      return { text };
    },

    addShoutout(p = {}) {
      const tier = TIERS.includes(p.tier) ? p.tier : "small";
      const who = clean(p.who, 40) || "viewer";
      const msg = clean(p.text, 140);
      const wrap = $("#shoutouts");
      if (!wrap) return { ok: false };

      const card = document.createElement("div");
      card.className = "shoutout tier-" + tier;
      // VIP: large-tier supporters get their photo as the card background + a
      // rainbow border (the border + legibility overlay come from CSS .vip)
      const vipUrl = tier === "large" ? safeAvatarUrl(p.avatar) : "";
      if (vipUrl) {
        card.classList.add("vip");
        card.style.setProperty("--vip-photo", `url("${vipUrl}")`); // CSS composes photo + rainbow border
      }
      const accent = document.createElement("span"); accent.className = "accent";
      const av = avatarEl(who, p.avatar, 42); av.classList.add("sc-avatar");
      const col = document.createElement("div"); col.className = "sc-col";
      const whoEl = document.createElement("div"); whoEl.className = "who"; whoEl.textContent = who.toUpperCase();
      const msgEl = document.createElement("div"); msgEl.className = "msg"; msgEl.textContent = msg;
      col.append(whoEl, msgEl);
      card.append(accent, av, col);
      wrap.prepend(card);

      const hold = { small: 8, medium: 16, large: 30 }[tier];
      if (gsap) {
        gsap.set(accent, { scaleY: 0, transformOrigin: "top" });
        const tl = gsap.timeline();
        tl.fromTo(card, { opacity: 0, x: 70, rotateZ: 2.5, scale: 0.9 },
          { opacity: 1, x: 0, rotateZ: 0, scale: 1, duration: 0.55, ease: "back.out(1.6)" });
        tl.to(accent, { scaleY: 1, duration: 0.5, ease: "power2.out" }, 0.1);
        tl.fromTo([whoEl, msgEl], { opacity: 0, x: 14 },
          { opacity: 1, x: 0, duration: 0.4, stagger: 0.08, ease: "power2.out" }, 0.18);
        if (tier === "large") {
          SceneAPI.burst({ intensity: 0.55 });
          gsap.to(card, { boxShadow: "0 0 50px var(--c1)", duration: 0.6, yoyo: true, repeat: 3, ease: "sine.inOut" });
        }
        gsap.to(card, { opacity: 0, x: 44, scale: 0.96, duration: 0.5, delay: hold, ease: "power2.in",
          onComplete: () => card.remove() });
      } else {
        setTimeout(() => card.remove(), hold * 1000);
      }

      const cards = wrap.querySelectorAll(".shoutout");
      for (let i = 8; i < cards.length; i++) cards[i].remove();
      return { ok: true, tier };
    },

    // golden recognition card for paid messages — deterministic (the ingest
    // fires this on EVERY superchat, before the director), scaled by tier
    superchatCard(p = {}) {
      const wrap = $("#superchats");
      if (!wrap) return { ok: false };
      const tier = TIERS.includes(p.tier) ? p.tier : "small";
      const who = clean(p.who, 40) || "supporter";
      const msg = clean(p.text, 140);
      const amount = /^[\d\s.,$€£¥]{1,12}$/.test(String(p.amount || "")) ? String(p.amount) : "";

      const card = document.createElement("div");
      card.className = "sc-card tier-" + tier;
      const shimmer = document.createElement("div"); shimmer.className = "sc-shimmer";
      const badge = document.createElement("div"); badge.className = "sc-badge";
      const label = document.createElement("div"); label.className = "sc-label"; label.textContent = "SUPER CHAT";
      const amt = document.createElement("div"); amt.className = "sc-amount"; amt.textContent = amount || "★";
      badge.append(label, amt);
      const av = avatarEl(who, p.avatar, 46);
      const body = document.createElement("div"); body.className = "sc-body";
      const whoEl = document.createElement("div"); whoEl.className = "sc-who"; whoEl.textContent = who;
      body.appendChild(whoEl);
      if (msg) { const m = document.createElement("div"); m.className = "sc-msg"; m.textContent = msg; body.appendChild(m); }
      card.append(shimmer, badge, av, body);
      wrap.prepend(card);
      while (wrap.children.length > 3) wrap.lastChild.remove(); // cap the stack

      const hold = { small: 9, medium: 14, large: 22 }[tier];
      if (gsap) {
        gsap.fromTo(card, { opacity: 0, y: -46, scale: 0.85 },
          { opacity: 1, y: 0, scale: 1, duration: 0.65, ease: "back.out(1.7)" });
        // shimmer sweep, repeating gently while the card holds
        gsap.fromTo(shimmer, { xPercent: -120 }, { xPercent: 120, duration: 1.6, ease: "power1.inOut", repeat: Math.ceil(hold / 3), repeatDelay: 1.2 });
        // festive burst scaled by tier
        spawnConfetti(); spawnSparkle();
        if (tier !== "small") { spawnConfetti(); SceneAPI.burst({ intensity: tier === "large" ? 0.7 : 0.45 }); }
        gsap.to(card, { opacity: 0, y: -30, scale: 0.94, duration: 0.6, delay: hold, ease: "power2.in", onComplete: () => card.remove() });
      } else {
        setTimeout(() => card.remove(), hold * 1000);
      }
      return { ok: true, tier, amount };
    },

    burst(p = {}) {
      const intensity = clampNum(p.intensity, 0, 1, 0.5);
      let flash = $("#flash");
      if (!flash) { flash = document.createElement("div"); flash.id = "flash"; $("#stage").appendChild(flash); }
      if (gsap) {
        gsap.fromTo(flash, { opacity: intensity }, { opacity: 0, duration: 0.6, ease: "power2.out" });
        // expanding shockwave ring
        const ring = document.createElement("div");
        ring.className = "burst-ring";
        $("#stage").appendChild(ring);
        gsap.fromTo(ring, { scale: 0, opacity: 0.15 + intensity * 0.5 },
          { scale: 1, opacity: 0, duration: 0.9, ease: "power2.out", onComplete: () => ring.remove() });
      }
      return { intensity };
    },

    // rewrite the scrolling ticker messages (sanitised, capped) — seamless
    setTicker(p = {}) {
      const items = (Array.isArray(p.items) ? p.items : [])
        .map((s) => clean(s, 60)).filter(Boolean).slice(0, 8);
      if (!items.length) return { ok: false };
      return startTickerCards(items);
    },

    // toggle a named effect on/off — fades in/out (no hard cut)
    setEffect(p = {}) {
      const effect = EFFECTS.includes(p.effect) ? p.effect : null;
      if (!effect) return { ok: false, error: "unknown effect" };
      const on = p.on !== false;
      const dur = clampNum(p.duration, 0.1, 3, 0.8);
      if (effect === "particles") setParticles(on, dur);
      else if (effect === "datarain") setDataRain(on, dur);
      else if (PERIODIC.has(effect)) setPeriodic(effect, on);
      else fadeEffect($(FX_SEL[effect]), on, FX_OPACITY[effect], dur);
      return { effect, on, duration: dur };
    },

    status(p = {}) { setStatus(p.text ?? "", p.show !== false); return { ok: true }; },

    // set by the streamer: "gpu" = full blend-mode richness + 60fps;
    // "cpu" = lite (blends off) + 30fps + on-screen performance warning
    setRenderMode(p = {}) {
      const mode = p.mode === "gpu" ? "gpu" : "cpu";
      // motion fps MUST match the capture/output fps, or constant-velocity
      // scrolling (the ticker) judders. The streamer passes the target fps.
      const fps = Number(p.fps) > 0 ? Number(p.fps) : 30;
      if (gsap) gsap.ticker.fps(fps);
      if (mode === "cpu") { document.body.classList.add("lite-render"); showWarning(true); }
      else { document.body.classList.remove("lite-render"); showWarning(false); }
      return { mode, fps };
    },

    // charming instant viewer reaction (emoji → micro-effect). who: optional name
    react(p = {}) {
      const kind = String(p.kind || "");
      const who = p.who ? clean(p.who, 24) : "";
      const avatar = typeof p.avatar === "string" && /^https:\/\//i.test(p.avatar) ? p.avatar : "";
      const fn = REACT_FN[kind];
      if (!fn) return { ok: false, kind };
      if (kind === "fire" || kind === "wow") SceneAPI.burst({ intensity: kind === "wow" ? 0.5 : 0.28 });
      fn(who, avatar);
      return { ok: true, kind, who };
    },

    // show the typed→on-scene latency readout (seconds)
    setDelay(p = {}) {
      const ms = clampNum(p.ms, 0, 600000, 0);
      const el = $("#latency");
      if (el) { el.textContent = "delay " + (ms / 1000).toFixed(1) + "s"; el.dataset.show = "true"; }
      return { ms };
    },

    // ---- collective theme vote (engine-driven rounds) --------------------
    // open a round: render options + run the countdown bar/timer for durationMs
    voteStart(p = {}) {
      const el = $("#vote");
      if (!el) return { ok: false };
      // ONE vote at a time: ignore a new round while one is live so a second
      // engine/late call can't open a duplicate panel or cut the countdown
      // short. The stale guard recovers if a round's result never arrived.
      if (voteActive && Date.now() < voteEndsAt + 5000) return { ok: false, ignored: "vote already active" };
      voteActive = true;
      const ms = clampNum(p.durationMs, 2000, 300000, 30000);
      voteEndsAt = Date.now() + ms;
      const title = $(".vote-title");
      if (title) title.textContent = clean(p.title, 28) || "VOTE THE NEXT THEME";
      if (voteHideTl) { voteHideTl.kill(); voteHideTl = null; }
      el.classList.remove("vote-won");
      const wrap = $("#vote-options"); // fresh slate per round (clears the prior round's rows)
      if (wrap) wrap.innerHTML = "";
      renderVoteOptions(p.options, p.leader);
      voteKeys = (Array.isArray(p.options) ? p.options : []).map((o) => o && o.key).filter(Boolean).sort().join(",");
      voteShow(true);
      if (gsap) {
        gsap.killTweensOf(el, "opacity,y,scale");
        gsap.fromTo(el, { opacity: 0, y: 24, scale: 0.94 },
          { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.5)" });
      }
      // Countdown driven by REAL elapsed time (not a GSAP tween): GSAP's lag
      // smoothing slows tweens on render hiccups, which would let the visual
      // countdown drift behind the engine's wall-clock timer and make the theme
      // swap look early. Reading performance.now() each frame stays true to the
      // same clock the engine ends the round on.
      const fill = $("#vote-progress-fill");
      const timer = $("#vote-timer");
      if (voteTickerFn && gsap) { gsap.ticker.remove(voteTickerFn); voteTickerFn = null; }
      if (voteGraceTimer) { clearTimeout(voteGraceTimer); voteGraceTimer = null; }
      const now0 = (window.performance ? performance.now() : Date.now());
      const endsAtClock = now0 + ms;
      const tick = () => {
        const t = (window.performance ? performance.now() : Date.now());
        const remain = Math.max(0, endsAtClock - t);
        if (fill) fill.style.width = ((remain / ms) * 100).toFixed(1) + "%";
        if (timer) timer.textContent = Math.ceil(remain / 1000) + "s";
        if (remain <= 0) {
          if (voteTickerFn && gsap) { gsap.ticker.remove(voteTickerFn); voteTickerFn = null; }
          // safety: if the engine's voteEnd never lands, don't hang at 0s —
          // auto-dismiss after a grace period (voteEnd clears this first normally)
          if (!voteGraceTimer) voteGraceTimer = setTimeout(() => {
            voteGraceTimer = null;
            if (!voteActive) return;
            if (gsap) gsap.to(el, { opacity: 0, y: 16, scale: 0.96, duration: 0.4, ease: "power2.in",
              onComplete: () => { voteShow(false); el.classList.remove("vote-won"); } });
            else voteShow(false);
            voteTeardown();
          }, 6000);
        }
      };
      tick();
      if (gsap) { voteTickerFn = tick; gsap.ticker.add(tick); }
      return { ok: true, durationMs: ms };
    },

    // live tally update during a round — only for the live round's own options
    // (a different/duplicate engine's update with other themes is rejected, so
    // it can't swap the options out from under a vote in progress)
    voteUpdate(p = {}) {
      if (!voteActive) return { ok: false, ignored: "no active vote" };
      const keys = (Array.isArray(p.options) ? p.options : []).map((o) => o && o.key).filter(Boolean).sort().join(",");
      if (voteKeys && keys && keys !== voteKeys) return { ok: false, ignored: "foreign vote update" };
      renderVoteOptions(p.options, p.leader);
      return { ok: true };
    },

    // close a round: flash the winner, then fade the panel out
    voteEnd(p = {}) {
      const el = $("#vote");
      if (!el) return { ok: false };
      if (voteGraceTimer) { clearTimeout(voteGraceTimer); voteGraceTimer = null; } // we're closing it cleanly
      if (voteTickerFn && gsap) { gsap.ticker.remove(voteTickerFn); voteTickerFn = null; }
      const winner = THEMES.includes(p.winner) ? p.winner : null;
      const timer = $("#vote-timer");
      if (winner) {
        const label = clean(p.winnerLabel, 18) || winner;
        if (timer) timer.textContent = label + " wins!";
        el.classList.add("vote-won");
        renderVoteOptions(p.options || [{ key: winner, label, votes: p.votes || 1 }], winner);
        if (gsap) SceneAPI.burst({ intensity: 0.4 });
      }
      // hold the result on screen, then dismiss (voteActive clears only once the
      // panel is fully gone → the next round can't start until this one finishes)
      if (gsap) {
        voteHideTl = gsap.timeline({ delay: winner ? 2.6 : 0.2 });
        voteHideTl.to(el, { opacity: 0, y: 16, scale: 0.96, duration: 0.5, ease: "power2.in",
          onComplete: () => { voteShow(false); el.classList.remove("vote-won"); voteActive = false; voteKeys = ""; } });
      } else {
        voteShow(false); voteActive = false; voteKeys = "";
      }
      return { ok: true, winner };
    },

    // ---- now-playing card (auto-DJ) -------------------------------------
    // title/artist/who from the DJ; likes + queue count from chat. Empty title
    // hides the card (e.g. nothing resolved yet).
    setNowPlaying(p = {}) {
      const el = $("#nowplaying");
      if (!el) return { ok: false };
      const title = clean(p.title, 60);
      if (!title) { el.dataset.show = "false"; el.classList.remove("playing"); return { ok: true, show: false }; }
      const artist = clean(p.artist, 40);
      const who = clean(p.who, 40);
      const likes = clampNum(p.likes, 0, 1e6, 0) | 0;
      const queue = clampNum(p.queue, 0, 1e6, 0) | 0;
      // cover art (Suno og:image) — https-only, like avatars
      const art = el.querySelector(".np-art");
      const img = typeof p.image === "string" && /^https:\/\/[^\s"')<>]+$/i.test(p.image) ? p.image : "";
      if (art) {
        if (img) { art.style.backgroundImage = `url("${img}")`; art.dataset.show = "true"; }
        else { art.style.backgroundImage = ""; art.dataset.show = "false"; }
      }
      // dim cover behind the card, with a slow Ken Burns drift — only (re)start
      // when the track's cover actually changes (not on every like/queue update)
      if (img !== npImg) {
        npImg = img;
        const bg = el.querySelector(".np-bg");
        if (bg) {
          bg.style.backgroundImage = img ? `url("${img}")` : "";
          if (npBgTween) { npBgTween.kill(); npBgTween = null; }
          if (gsap && img) {
            npBgTween = gsap.fromTo(bg, { scale: 1.05, x: -8, y: 5 },
              { scale: 1.16, x: 10, y: -6, duration: 16, ease: "sine.inOut", yoyo: true, repeat: -1 });
          }
        }
        // the same cover as a dim, crossfading, drifting full-stage backdrop
        setStageCover(img);
      }
      const set = (sel, txt) => { const n = el.querySelector(sel); if (n) n.textContent = txt; };
      set(".np-title", title);
      set(".np-artist", artist);
      set(".np-by", who ? "  ·  req by " + who : "");
      set(".np-like-count", String(likes));
      set(".np-queue-count", String(queue));
      const q = el.querySelector(".np-queue");
      if (q) q.dataset.show = queue > 0 ? "true" : "false";
      const first = el.dataset.show !== "true";
      el.dataset.show = "true";
      el.classList.add("playing");
      if (gsap && first) gsap.fromTo(el, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" });
      return { ok: true, title, likes, queue };
    },

    // drive the now-playing eq bars from the LIVE music spectrum. p.bands is a
    // 4-element 0..1 array (one frequency band per bar); each bar = its band, so
    // the bass bar moves on kicks, the treble bar on hats, etc.
    setEqLevels(p = {}) {
      const el = $("#nowplaying");
      if (!el) return { ok: false };
      const bars = el.querySelectorAll(".np-eq i");
      if (!bars.length) return { ok: false };
      const bands = Array.isArray(p.bands) ? p.bands : null;
      el.classList.add("reactive"); // swap the idle keyframe for live-driven heights
      bars.forEach((b, i) => {
        const v = bands ? clampNum(bands[i], 0, 1, 0) : clampNum(p.level, 0, 1, 0);
        b.style.height = (Math.max(0.08, Math.min(1, v)) * 100).toFixed(0) + "%";
      });
      return { ok: true, bands: bands || [] };
    },

    // standby / landing screen.
    //   mode: "intro" | "outro" | "technical" | "break" | "off"
    // (custom title/subtitle override the preset). "off" reveals the live show.
    // outro additionally shows the credit roll (p.artists), disclaimer, + links.
    setStandby(p = {}) {
      const el = $("#standby");
      if (!el) return { ok: false };
      const mode = String(p.mode || "off").toLowerCase();
      const extras = $("#sb-extras");
      el.classList.remove("sb-intro", "sb-outro", "sb-technical", "sb-break");
      if (mode === "off") {
        el.dataset.show = "false";
        if (extras) extras.dataset.show = "false";
        return { ok: true, mode };
      }
      const presets = {
        intro:     { title: "Stream starting shortly", sub: "sit tight — the show's about to begin" },
        outro:     { title: "Thanks for listening", sub: "see you next time 👋" },
        technical: { title: "Technical difficulties", sub: "we're on it — hang tight, back in a moment" },
        break:     { title: "We'll be right back", sub: "grabbing a quick break — don't go anywhere" },
      };
      const key = presets[mode] ? mode : "intro";
      const d = presets[key];
      el.classList.add("sb-" + key);
      const t = $(".sb-title"), s = $(".sb-sub");
      if (t) t.textContent = clean(p.title, 60) || d.title;
      if (s) s.textContent = clean(p.subtitle, 90) || d.sub;
      // outro-only credits + disclaimer + links
      if (extras) {
        if (key === "outro") { renderOutroCredits(p.artists); extras.dataset.show = "true"; }
        else extras.dataset.show = "false";
      }
      el.dataset.show = "true";
      return { ok: true, mode: key };
    },

    // "going live in 10…" countdown shown during the intro→on-air handoff. Each
    // second pops a big number; at 0 it flashes "LIVE", bursts, and clears itself.
    // Sits ABOVE the standby screen so it reads while the pre-show is still up.
    setCountdown(p = {}) {
      const el = $("#countdown");
      if (!el) return { ok: false };
      const secs = Math.round(clampNum(p.seconds, 1, 60, 10));
      const numEl = el.querySelector(".cd-num");
      const labelEl = el.querySelector(".cd-label");
      // clear any countdown already running (a re-trigger restarts cleanly)
      countdownCalls.forEach((c) => c && c.kill && c.kill());
      countdownCalls = [];
      if (labelEl) labelEl.textContent = clean(p.label, 24) || "GOING LIVE IN";
      el.dataset.show = "true";
      if (!gsap) {
        if (numEl) numEl.textContent = String(secs);
        setTimeout(() => { el.dataset.show = "false"; }, secs * 1000);
        return { ok: true, seconds: secs };
      }
      gsap.set(el, { opacity: 1 });
      const pop = (txt) => {
        if (!numEl) return;
        numEl.textContent = txt;
        gsap.killTweensOf(numEl);
        gsap.fromTo(numEl, { scale: 0.45, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.34, ease: "back.out(2.4)" });
        gsap.to(numEl, { scale: 1.18, opacity: 0, duration: 0.5, delay: 0.5, ease: "power2.in" });
      };
      for (let i = 0; i < secs; i++) countdownCalls.push(gsap.delayedCall(i, () => pop(String(secs - i))));
      countdownCalls.push(gsap.delayedCall(secs, () => {
        if (labelEl) labelEl.textContent = "";
        if (numEl) {
          numEl.textContent = "LIVE";
          gsap.killTweensOf(numEl);
          gsap.fromTo(numEl, { scale: 0.5, opacity: 0 }, { scale: 1.2, opacity: 1, duration: 0.4, ease: "back.out(2)" });
        }
        SceneAPI.burst({ intensity: 0.7 });
        countdownCalls.push(gsap.delayedCall(1.15, () => {
          gsap.to(el, { opacity: 0, duration: 0.5, ease: "power2.in",
            onComplete: () => { el.dataset.show = "false"; el.style.opacity = ""; if (numEl) numEl.textContent = ""; } });
        }));
      }));
      return { ok: true, seconds: secs };
    },

    // show/hide the CPU-rendering warning banner (operator can dismiss it)
    renderWarning(p = {}) { showWarning(p.show !== false); return { show: p.show !== false }; },

    // ---- Overlay mode: put an external source UNDER the scene -------------
    // OPERATOR action (not viewer-reachable): pick what's on the main stage —
    // a YouTube video, a direct video/image URL, or none (back to the themed
    // background). The HyperLive scene becomes a transparent overlay on top.
    // Elements are built with DOM APIs + a strict id/URL whitelist, never
    // innerHTML, so even this operator door can't smuggle markup into the page.
    setStageSource(p = {}) {
      const host = $("#stage-source");
      if (!host) return { ok: false, error: "no stage-source layer" };
      const kind = String(p.kind || "none").toLowerCase();
      const scrim = host.querySelector(".src-scrim");
      // tear down any previous source (stops a playing iframe/video cleanly)
      for (const el of [...host.children]) { if (el !== scrim) el.remove(); }

      if (kind === "none" || kind === "off" || kind === "clear") {
        document.body.classList.remove("stage-sourced");
        return { ok: true, kind: "none" };
      }

      const httpUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null; } catch { return null; } };

      if (kind === "youtube" || kind === "yt") {
        // accept a bare 11-char id or any youtube URL we can pull the id from
        let id = String(p.id || "");
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
          const m = String(p.url || p.id || "").match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/);
          id = m ? m[1] : "";
        }
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { ok: false, error: "youtube id/url required" };
        const mute = p.muted === false ? 0 : 1; // muted by default (browser audio isn't captured yet)
        const f = document.createElement("iframe");
        f.setAttribute("allow", "autoplay; encrypted-media");
        f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        f.setAttribute("frameborder", "0");
        // params are fixed/clamped — id is the only variable and it's whitelisted
        const qs = new URLSearchParams({
          autoplay: "1", mute: String(mute), controls: "0", modestbranding: "1",
          rel: "0", iv_load_policy: "3", disablekb: "1", fs: "0", playsinline: "1",
          loop: "1", playlist: id, // single-video loop requires playlist=id
        });
        f.src = `https://www.youtube-nocookie.com/embed/${id}?${qs.toString()}`;
        host.appendChild(f);
        document.body.classList.add("stage-sourced");
        return { ok: true, kind: "youtube", id, muted: !!mute };
      }

      if (kind === "video") {
        const url = httpUrl(p.url);
        if (!url) return { ok: false, error: "http(s) video url required" };
        const v = document.createElement("video");
        v.src = url;
        v.autoplay = true; v.loop = p.loop !== false; v.playsInline = true;
        v.muted = p.muted !== false; // muted by default → reliable autoplay
        v.play?.().catch(() => {});
        host.appendChild(v);
        document.body.classList.add("stage-sourced");
        return { ok: true, kind: "video", url, muted: v.muted };
      }

      if (kind === "image") {
        const url = httpUrl(p.url);
        if (!url) return { ok: false, error: "http(s) image url required" };
        const d = document.createElement("div");
        d.className = "src-img";
        d.style.backgroundImage = `url("${encodeURI(url)}")`;
        host.appendChild(d);
        document.body.classList.add("stage-sourced");
        return { ok: true, kind: "image", url };
      }

      return { ok: false, error: "kind must be none|youtube|video|image" };
    },
  };

  window.SceneAPI = SceneAPI;
  window.SCENE_ACTIONS = Object.keys(SceneAPI);

  function boot() {
    // Pin animation updates to an even 30fps. Software rendering can't hold a
    // rock-solid 60, and uneven frame pacing is what reads as "jerky". A steady
    // 30 (with render headroom to spare) matched to a 30fps capture is smooth.
    if (gsap) gsap.ticker.fps(30);
    // scale the 1280-design stage to fill the actual viewport (720p→1x, 1080p→1.5x)
    document.documentElement.style.setProperty("--sscale", String((window.innerWidth || 1280) / 1280));
    particles.canvas = $("#fx-particles");
    particles.ctx = particles.canvas && particles.canvas.getContext("2d");
    rain.canvas = $("#fx-datarain");
    rain.ctx = rain.canvas && rain.canvas.getContext("2d");
    ensureHfIds();
    buildDecor();
    retint();
    startAmbient();
    startTickerCards();
    setStatus("live", false); // the "live" bubble is hidden (kept for operator use)
    window.__sceneReady = true;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
