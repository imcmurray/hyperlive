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

  // ---- background crossfade state -----------------------------------------
  const layers = [$("#bg-a"), $("#bg-b")];
  let active = 0;            // index of the visible layer
  let currentTheme = "synthwave";
  let transitioning = false;

  // ---- particle field (canvas, only runs while enabled) -------------------
  const particles = { canvas: null, ctx: null, items: [], on: false, raf: 0, rgb: "182,255,94" };

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
    particles.items = Array.from({ length: 60 }, () => ({
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
    for (const p of particles.items) {
      p.y -= p.vy;
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
      col.y += col.sp;
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
    const loop = () => { PERIODIC_FN[effect](); periodicTimers[effect] = gsap.delayedCall(lo + Math.random() * (hi - lo), loop); };
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

  // ---- bottom rotating cards (replaces the scrolling ticker) --------------
  // Discrete pop-in / hold / drop-off cards avoid the constant-velocity capture
  // judder a scrolling marquee suffers. Each card carries a progress line that
  // fills over the hold time so viewers see when the next one is coming.
  let tickerItems = ["stream is live", "themes crossfade smoothly", "effects toggle via directives"];
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
  function crossfade(theme, duration) {
    if (!THEMES.includes(theme)) theme = currentTheme;
    if (transitioning || theme === currentTheme) return { theme: currentTheme, busy: transitioning };
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

  // ---- the action table ---------------------------------------------------
  const SceneAPI = {
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
      const accent = document.createElement("span"); accent.className = "accent";
      const whoEl = document.createElement("div"); whoEl.className = "who"; whoEl.textContent = who.toUpperCase();
      const msgEl = document.createElement("div"); msgEl.className = "msg"; msgEl.textContent = msg;
      card.append(accent, whoEl, msgEl);
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
      for (let i = 5; i < cards.length; i++) cards[i].remove();
      return { ok: true, tier };
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

    // show/hide the CPU-rendering warning banner (operator can dismiss it)
    renderWarning(p = {}) { showWarning(p.show !== false); return { show: p.show !== false }; },
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
    buildDecor();
    retint();
    startAmbient();
    startTickerCards();
    setStatus("live", true);
    window.__sceneReady = true;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
