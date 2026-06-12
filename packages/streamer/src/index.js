import http from "node:http";
import { readFile, watch, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import puppeteer from "puppeteer-core";
import { config, ingestUrl } from "./config.js";
import { startStreamer, startScreencastStreamer } from "./ffmpeg.js";
import { createDJ } from "./music/dj.js";
import { createMeter } from "./music/meter.js";
import { visionCheck, visionEnabled } from "./vision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENE_DIR = path.resolve(__dirname, "../scene");

// Actions the control plane is allowed to invoke. Must match window.SCENE_ACTIONS
// in scene.js. The server NEVER forwards code — only {action, params}.
const ALLOWED_ACTIONS = new Set([
  "setTheme",
  "transitionTheme",
  "setHeadline",
  "setKicker",
  "setSubhead",
  "setHeadlineGradient",
  "addShoutout",
  "burst",
  "setEffect",
  "setTicker",
  "setIntensity",
  "setMood",
  "react",
  "setDelay",
  "voteStart",
  "voteUpdate",
  "voteEnd",
  "setNowPlaying",
  "setEqLevels",
  "setStandby",
  "setCountdown",
  "renderWarning",
  "status",
  "mutateElement", // Tier 1: clamped ops against registry elements only
  "superchatCard", // golden paid-message recognition (deterministic, ingest-fired)
  "setStageSource", // overlay mode: external video/image UNDER the scene. OPERATOR
                    // only — reachable via the loopback /mutate (dashboard), NOT
                    // emitted by the director, so viewers can't set the source.
  "setTitles",      // fly the overlay title block in/out (per-stage or global)
  "setVibe",        // show/hide the mood "vibe" descriptor chip (per-stage)
]);
// NB: showCard/takeover/clearCards are deliberately NOT in this allowlist —
// model-authored markup may only enter through POST /card and /takeover below,
// which pre-render off-air and vision-gate before anything reaches the scene.

let page = null;
let streamer = null;
let browser = null;
let dj = null;        // auto-DJ daemon (music)
let meter = null;     // audio level meter (eq bars)
let renderMode = "?"; // gpu | cpu
let gpuRenderer = "";
let stopping = false; // true during graceful shutdown (silences the watchdog)
let monitorFrame = null;   // latest screencast JPEG (GPU path) — feeds /monitor.mjpeg
let monitorClients = 0;    // cap concurrent live-monitor viewers
// current show phase, tracked from the directives that drive it (see
// applyDirective): "intro" (pre-show) | "countdown" | "onair" | "outro".
// Defaults to onair; set to intro on boot when STANDBY_ON_BOOT is on.
let showState = "onair";

// pull a clean 11-char YouTube id out of an id or any youtube URL
function youtubeId(p = {}) {
  const raw = String(p.id || "");
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const m = String(p.url || p.id || "").match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

// resolve a YouTube id → a direct progressive (audio+video) media URL via
// yt-dlp, so the scene's <video> element plays synced sound. Cached ~1h
// (googlevideo URLs are time-limited and IP-bound; we run on the same host the
// browser fetches from). The id is whitelisted before we ever shell out.
const ytUrlCache = new Map(); // id -> { url, exp }
function resolveYouTube(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.reject(new Error("bad id"));
  const hit = ytUrlCache.get(id);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve, reject) => {
    // best single file that has BOTH audio and video (progressive), mp4-first
    execFile("yt-dlp", [
      "-f", "best[acodec!=none][vcodec!=none][ext=mp4]/best[acodec!=none][vcodec!=none]",
      "--no-playlist", "--no-warnings", "-g", `https://www.youtube.com/watch?v=${id}`,
    ], { timeout: 25000 }, (err, stdout) => {
      if (err) return reject(new Error(err.message.split("\n")[0]));
      const url = String(stdout || "").trim().split("\n")[0];
      if (!/^https?:\/\//.test(url)) return reject(new Error("no url resolved"));
      ytUrlCache.set(id, { url, exp: Date.now() + 60 * 60 * 1000 });
      resolve(url);
    });
  });
}

/**
 * Apply a single directive to the live page by calling the named SceneAPI
 * method with serialised params. page.evaluate marshals args as data, so there
 * is no string-eval / injection path here.
 */
async function applyDirective(directive) {
  if (!page) throw new Error("scene not ready");
  const action = String(directive?.action || "");
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`disallowed action: ${action}`);
  }
  let params = directive?.params && typeof directive.params === "object" ? directive.params : {};
  // Overlay-mode YouTube with audio: the IFrame player won't reliably make
  // sound in headless Chromium, but a plain <video> element does. So when audio
  // capture is on, resolve the id → a direct progressive URL (yt-dlp) and hand
  // the scene a kind:"video" instead. Falls back to the (muted) embed on any
  // failure, so the picture still shows.
  if (action === "setStageSource" && /^(youtube|yt)$/i.test(String(params.kind || "")) && config.captureSink && params.muted === false) {
    const id = youtubeId(params);
    if (id) {
      try {
        const url = await resolveYouTube(id);
        params = { kind: "video", url, muted: false, loop: true };
      } catch (e) {
        console.warn("[stage] yt-dlp resolve failed, falling back to muted embed:", e.message);
      }
    }
  }
  // remember the show phase so /health (and `live.sh status`) can report it.
  // These directives are the single source of truth, whatever calls them.
  if (action === "setStandby") {
    const m = String(params.mode || "off").toLowerCase();
    showState = m === "off" ? "onair" : m; // intro | outro | technical | break
  } else if (action === "setCountdown") {
    showState = "countdown";
  }
  return evalScene(action, params);
}

// the raw scene call (no allowlist) — for internal callers that carry their
// own authorization: the card/takeover vision gate and GET /elements. All
// external mutation goes through applyDirective's allowlist above.
async function evalScene(action, params = {}) {
  if (!page) throw new Error("scene not ready");
  return page.evaluate(
    (a, p) => {
      if (!window.SceneAPI || typeof window.SceneAPI[a] !== "function") {
        return { ok: false, error: "scene not ready" };
      }
      try {
        return { ok: true, result: window.SceneAPI[a](p) };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    },
    action,
    params
  );
}

// Off-air pre-render of model-authored markup: a SEPARATE page — the CDP
// screencast only captures the scene page, so this can never leak to the
// broadcast (our analog of hyperframes' createPreviewAdapter). JS is disabled
// and every network request aborted, matching the sandbox+CSP the scene will
// impose; CSS animations still run, so the screenshot is a real frame of what
// would air.
// Off-air SCENE TWIN: a second full copy of the scene in a page the screencast
// never captures — automation previews fire here so test animations are never
// broadcast. Lazy-created, auto-closed after a minute idle (the full scene at
// 30fps GSAP isn't free).
let previewScenePromise = null;
let previewSceneClients = 0;
let previewSceneIdle = null;
function ensurePreviewScene() {
  if (!previewScenePromise) {
    previewScenePromise = (async () => {
      const p = await browser.newPage();
      await p.setViewport({ width: 1280, height: 720 });
      await p.goto(`http://localhost:${config.controlPort}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await p.waitForFunction("window.__sceneReady === true", { timeout: 15000 }).catch(() => {});
      console.log("[preview-scene] off-air scene twin up");
      return p;
    })().catch((e) => { previewScenePromise = null; throw e; });
  }
  return previewScenePromise;
}
function schedulePreviewSceneClose() {
  clearTimeout(previewSceneIdle);
  previewSceneIdle = setTimeout(async () => {
    if (previewSceneClients > 0 || !previewScenePromise) return;
    const p = await previewScenePromise.catch(() => null);
    previewScenePromise = null;
    if (p && !p.isClosed()) { p.close().catch(() => {}); console.log("[preview-scene] closed (idle)"); }
  }, 60000);
}

let previewPage = null;
async function renderPreview(html, w, h) {
  if (!previewPage || previewPage.isClosed()) {
    previewPage = await browser.newPage();
    await previewPage.setJavaScriptEnabled(false);
    await previewPage.setRequestInterception(true);
    previewPage.on("request", (r) => (r.isNavigationRequest() ? r.continue() : r.abort()).catch(() => {}));
  }
  await previewPage.setViewport({ width: w, height: h });
  await previewPage.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#0b0820}</style></head><body>${html}</body></html>`,
    { waitUntil: "load", timeout: 8000 }
  );
  await new Promise((r) => setTimeout(r, 700)); // let CSS animations reach a real frame
  return previewPage.screenshot({ type: "png", clip: { x: 0, y: 0, width: w, height: h }, encoding: "base64" });
}

function buildControlApp() {
  const app = express();
  app.use(express.json({ limit: "96kb" })); // takeover html can be larger than directives
  app.get("/favicon.ico", (_req, res) => res.status(204).end()); // keep the scene console clean
  app.use(express.static(SCENE_DIR));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      sceneReady: !!page,
      showState,
      ffmpegUp: streamer ? streamer.isUp() : false,
      ffmpegRestarts: streamer ? streamer.restarts() : 0,
      renderMode,
      gpuRenderer,
      dryRun: config.dryRun,
      audioMode: config.audioMode,
      audioCapture: config.captureSink, // true → a video source's audio is captured
      ingest: config.dryRun ? null : config.outputFile || `${config.rtmpUrl}/<key>`,
    });
  });

  // POST /mutate  { "action": "setTheme", "params": { "theme": "forest" } }
  app.post("/mutate", async (req, res) => {
    try {
      const out = await applyDirective(req.body);
      res.json({ ok: true, applied: req.body, out });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message) });
    }
  });

  // list of valid actions, for tooling / sanity
  app.get("/actions", (_req, res) => res.json({ actions: [...ALLOWED_ACTIONS] }));

  // Tier 1: the element manifest the director plans mutateElement calls against
  app.get("/elements", async (_req, res) => {
    try { res.json(await evalScene("getElements")); }
    catch (e) { res.status(503).json({ ok: false, error: String(e.message) }); }
  });

  // --- Tier 2/3: model-authored markup — pre-rendered off-air, vision-gated ---
  // The ONLY doors to the broadcast for generated HTML. Flow: validate →
  // render in the off-air preview page → screenshot → vision safety check →
  // only then hand to the scene's sandboxed iframe slot (with TTL).
  const gate = async (req, res, kind) => {
    try {
      const html = String(req.body?.html || "");
      const who = String(req.body?.who || "");
      const source = String(req.body?.source || "operator"); // ingest sends "viewer"
      const seconds = Number(req.body?.seconds) || undefined;
      // preview: run the whole gauntlet OFF-AIR and return the screenshot +
      // vision verdict instead of airing — the moderator hold queue reviews it
      const preview = req.body?.preview === true;
      const max = kind === "card" ? 16384 : 65536;
      if (!html.trim() || html.length > max) return res.status(400).json({ ok: false, error: `html required, <= ${max} bytes` });
      // belt-and-braces: the iframe sandbox + CSP block all of these anyway
      // (verified: an svg onload payload renders inert inside the sandbox)
      if (/<\s*(script|iframe|object|embed|link|meta|base|form)\b|\bon[a-z]+\s*=|url\s*\(/i.test(html)) {
        return res.status(400).json({ ok: false, error: "disallowed construct" });
      }
      // a preview airs nothing, so the no-key 403 and show-phase 409 don't
      // apply — a human reviews ahead of air time
      if (!preview && source !== "operator" && !visionEnabled) {
        return res.status(403).json({ ok: false, error: "viewer-sourced markup needs ANTHROPIC_API_KEY (vision gate)" });
      }
      if (!preview && kind === "takeover" && showState !== "onair") {
        return res.status(409).json({ ok: false, error: `show is in '${showState}' — takeovers only while onair` });
      }
      const [w, h] = kind === "card" ? [360, 250] : [1280, 720];
      const shot = await renderPreview(html, w, h);
      let vision = null;
      if (visionEnabled) {
        vision = await visionCheck(shot, kind === "card" ? `a ${w}x${h} viewer card` : "a full-stage takeover segment");
        if (!preview && !vision.safe) {
          console.log(`[${kind}] REJECTED by vision gate (${vision.reason}) — from ${who || source}`);
          return res.status(422).json({ ok: false, error: `vision gate: ${vision.reason}` });
        }
      }
      if (preview) {
        return res.json({ ok: true, kind, preview: true, screenshot: shot, vision });
      }
      const out = await evalScene(kind === "card" ? "showCard" : "takeover", { html, who, seconds });
      console.log(`[${kind}] live (${html.length}b) from ${who || source}${visionEnabled ? " [vision-checked]" : " [operator, ungated]"}`);
      res.json({ ok: true, kind, out });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  };
  app.post("/card", (req, res) => gate(req, res, "card"));
  app.post("/takeover", (req, res) => gate(req, res, "takeover"));
  // operator kill for everything model-authored (cards + takeover)
  app.post("/cards/clear", async (_req, res) => {
    try { res.json(await evalScene("clearCards")); }
    catch (e) { res.status(503).json({ ok: false, error: String(e.message) }); }
  });

  // --- music control plane: the ingest posts chat requests/likes here ---
  // queue a requested Suno share link (resolved + CDN-allowlisted by the DJ)
  app.post("/music/enqueue", async (req, res) => {
    if (!dj) return res.status(503).json({ ok: false, reason: "music off" });
    const out = await dj.enqueue(String(req.body?.link || ""), String(req.body?.who || ""));
    res.status(out.ok ? 200 : 400).json(out);
  });
  // like the currently-playing song (one per author per song)
  app.post("/music/like", (req, res) => {
    if (!dj) return res.status(503).json({ ok: false });
    res.json(dj.like(String(req.body?.who || "")));
  });
  // operator skip + status
  app.post("/music/skip", (_req, res) => { if (dj) dj.skip(); res.json({ ok: !!dj }); });
  // fade the music volume (outro fade-out / onair fade-in). { to: 0..100, ms }
  app.post("/music/fade", (req, res) => {
    if (!dj) return res.status(503).json({ ok: false });
    const to = Number(req.body?.to), ms = Number(req.body?.ms);
    dj.fade(Number.isFinite(to) ? to : 0, Number.isFinite(ms) ? ms : 4000);
    res.json({ ok: true, to, ms });
  });
  app.get("/music/status", (_req, res) => res.json(dj ? dj.status() : { ok: false, music: false }));
  // full up-next: requested songs + the house rotation
  app.get("/music/queue", (_req, res) => res.json(dj ? dj.queueInfo() : { ok: false, music: false }));
  // switch the DJ playlist: "intro" (pre-show loop) ⇄ "live" (queue + rotation)
  app.post("/music/mode", (req, res) => {
    if (!dj) return res.status(503).json({ ok: false, reason: "music off" });
    res.json(dj.setMode(String(req.body?.mode || "live")));
  });

  // go ON AIR: run the on-screen countdown, then reveal the show + switch the DJ
  // from intro music to the live queue. The timing lives here (not the operator's
  // shell) so the visual countdown and the music handoff stay in lock-step.
  app.post("/onair", async (req, res) => {
    const secs = Math.max(3, Math.min(30, Number(req.body?.seconds) || 10));
    await applyDirective({ action: "setCountdown", params: { seconds: secs } }).catch(() => {});
    res.json({ ok: true, seconds: secs });
    setTimeout(() => {
      applyDirective({ action: "setStandby", params: { mode: "off" } }).catch(() => {});
      if (dj) dj.setMode("live"); // fades intro out → first queued/rotation track up
    }, secs * 1000);
  });

  // sign-off: outro screen crediting every Suno artist played since we went on
  // air (a thank-you), plus the repo + Suno links, then fade the music out.
  app.post("/outro", async (req, res) => {
    const artists = dj ? dj.artists() : [];
    await applyDirective({ action: "setStandby", params: { mode: "outro", artists } }).catch(() => {});
    // the show's over: stop any stage source (overlay video/image/YouTube) still
    // running UNDERNEATH the outro screen — otherwise it keeps playing, and its
    // audio keeps sounding, off-camera behind the sign-off.
    await applyDirective({ action: "setStageSource", params: { kind: "none" } }).catch(() => {});
    if (dj) dj.fade(0, 6000); // gentle sign-off fade
    res.json({ ok: true, artists });
  });

  // report the WebGL renderer (proxy for whether the GPU is hardware-accelerated)
  app.get("/gpu", async (_req, res) => {
    if (!page) return res.status(503).json({ ok: false, error: "scene not ready" });
    try {
      const info = await page.evaluate(() => {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (!gl) return { webgl: false };
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          webgl: true,
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        };
      });
      res.json({ ok: true, ...info });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });

  // measure the page's real requestAnimationFrame rate (render-side fps)
  app.get("/fps", async (_req, res) => {
    if (!page) return res.status(503).json({ ok: false, error: "scene not ready" });
    try {
      const fps = await page.evaluate(() => new Promise((resolve) => {
        let n = 0; const t0 = performance.now();
        (function tick() {
          n++;
          const dt = performance.now() - t0;
          if (dt < 1500) requestAnimationFrame(tick);
          else resolve(Math.round((n * 1000) / dt));
        })();
      }));
      res.json({ ok: true, rafFps: fps });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });

  // --- off-air preview twin: apply a directive + watch it, zero broadcast risk ---
  app.post("/preview/mutate", async (req, res) => {
    try {
      const action = String(req.body?.action || "");
      if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ ok: false, error: `disallowed action: ${action}` });
      const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
      const p = await ensurePreviewScene();
      const out = await p.evaluate((a, pr) => {
        if (!window.SceneAPI || typeof window.SceneAPI[a] !== "function") return { ok: false, error: "twin not ready" };
        try { return { ok: true, result: window.SceneAPI[a](pr) }; } catch (e) { return { ok: false, error: String(e && e.message) }; }
      }, action, params);
      schedulePreviewSceneClose();
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });
  app.get("/preview.mjpeg", async (req, res) => {
    let p;
    try { p = await ensurePreviewScene(); }
    catch { return res.status(503).json({ ok: false, error: "preview scene failed to start" }); }
    previewSceneClients++;
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=hlframe", "cache-control": "no-store" });
    let alive = true;
    req.on("close", () => { alive = false; });
    try {
      while (alive && !stopping && !p.isClosed()) {
        const buf = Buffer.from(await p.screenshot({ type: "jpeg", quality: 65 }));
        if (res.writableLength < 4 * 1024 * 1024) {
          res.write(`--hlframe\r\ncontent-type: image/jpeg\r\ncontent-length: ${buf.length}\r\n\r\n`);
          res.write(buf);
          res.write("\r\n");
        }
        await new Promise((r) => setTimeout(r, 160)); // ~6fps — preview, not broadcast
      }
    } catch { /* twin closed / client gone */ }
    previewSceneClients--;
    schedulePreviewSceneClose();
    res.end();
  });

  // live monitor: MJPEG stream of the scene — on the GPU path these are the
  // EXACT frames going to ffmpeg (shared screencast buffer); on the CPU path
  // it falls back to ~3fps page screenshots. Video only — renders natively
  // in an <img>, no client libs. The dashboard's pop-out monitor uses this.
  app.get("/monitor.mjpeg", async (req, res) => {
    if (!page) return res.status(503).json({ ok: false, error: "scene not ready" });
    if (monitorClients >= 3) return res.status(503).json({ ok: false, error: "monitor busy (3 viewers max)" });
    monitorClients++;
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=hlframe", "cache-control": "no-store" });
    let alive = true;
    req.on("close", () => { alive = false; });
    try {
      while (alive && !stopping) {
        let buf = monitorFrame;
        if (!buf) {
          try { buf = Buffer.from(await page.screenshot({ type: "jpeg", quality: 70 })); }
          catch { break; }
        }
        // slow client → drop frames rather than buffer unbounded (same rule
        // as the ffmpeg stdin pump)
        if (res.writableLength < 4 * 1024 * 1024) {
          res.write(`--hlframe\r\ncontent-type: image/jpeg\r\ncontent-length: ${buf.length}\r\n\r\n`);
          res.write(buf);
          res.write("\r\n");
        }
        await new Promise((r) => setTimeout(r, monitorFrame ? 100 : 350)); // ~10fps shared / ~3fps fallback
      }
    } catch { /* client gone */ }
    monitorClients--;
    res.end();
  });

  // PNG screenshot of the current live scene — handy for visual QA
  app.get("/screenshot", async (_req, res) => {
    if (!page) return res.status(503).json({ ok: false, error: "scene not ready" });
    try {
      const buf = await page.screenshot({ type: "png" });
      // puppeteer returns a Uint8Array; wrap so Express sends raw bytes, not JSON
      res.set("content-type", "image/png").send(Buffer.from(buf));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });

  return app;
}

async function launchBrowser(url, opts) {
  const { headless, width, height, dsf } = opts;
  const { chromiumPath } = config;
  // GPU flags only matter in headless mode (the render node is reached via EGL).
  const gpuArgs = process.env.GPU_ARGS
    ? process.env.GPU_ARGS.split(",")
    : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan"];
  const useGpu = headless && process.env.ENABLE_GPU === "true";

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: headless ? true : false, // puppeteer 23 `true` = new headless
    defaultViewport: { width, height, deviceScaleFactor: dsf || 1 },
    ignoreDefaultArgs: ["--enable-automation"], // drop the automation infobar
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      ...(useGpu ? gpuArgs : ["--disable-gpu"]),
      "--no-first-run",
      "--autoplay-policy=no-user-gesture-required",
      // Overlay-mode HLS sources (a resolved YouTube live stream, or any .m3u8)
      // are served from googlevideo, which sends no CORS headers — hls.js can't
      // fetch them from our origin without this. Safe on THIS browser: it's a
      // capture-only rig whose top frame runs only our own trusted JS (scene,
      // gsap, hls.js); the only untrusted content (viewer cards) is isolated in
      // sandboxed iframes with their own CSP, which this flag doesn't touch.
      // Gated to source-audio mode so it's off unless overlay sound is in use.
      ...(config.captureSink ? ["--disable-web-security", "--user-data-dir=/tmp/hl-chrome"] : []),
      // Keep a long-lived, offscreen capture page running at FULL speed. Chrome
      // aggressively throttles backgrounded/occluded renderers: rAF (the GSAP
      // ticker) drops toward ~1fps, IntensiveWakeUpThrottling clamps timers to
      // ~once/minute after ~5min, and IPC-flooding protection delays our high-
      // rate page.evaluate() pushes (eq bars ~28/s + directives). In the GPU
      // screencast path the page is truly offscreen and the frame pump is a
      // setTimeout loop — without these the stream's motion + pump quietly
      // collapse minutes in. (Mirrors hyperframes' headless-capture flag set.)
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-media-suspend",
      "--disable-ipc-flooding-protection",
      "--disable-features=IntensiveWakeUpThrottling",
      `--window-size=${width},${height}`,
      // headful-only window chrome (irrelevant/unwanted in headless)
      ...(headless ? [] : ["--kiosk", "--start-fullscreen", "--hide-scrollbars", "--disable-infobars", "--window-position=0,0"]),
    ],
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  await page.setViewport({ width, height, deviceScaleFactor: dsf || 1 });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[scene console]", m.text());
  });
  // domcontentloaded, not networkidle2: the scene is fully local, and we gate
  // on the explicit __sceneReady handshake below anyway — waiting for network
  // idle only adds boot latency (and a hang risk if the page ever fetches
  // something remote). Mirrors hyperframes' capture-navigation fix.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.__sceneReady === true", { timeout: 15000 }).catch(() => {
    console.warn("[scene] __sceneReady not observed within 15s; continuing (boot directives will retry)");
  });
  console.log(`[browser] scene loaded (${headless ? "headless" : "headful"} ${width}x${height}@${dsf || 1}x):`, url);
}

// returns { hardware:boolean, renderer:string } — is Chromium GPU-accelerated?
async function probeGPU() {
  try {
    const renderer = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return "";
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || "";
    });
    const software = /llvmpipe|swiftshader|software/i.test(renderer);
    return { hardware: !!renderer && !software, renderer };
  } catch (e) {
    return { hardware: false, renderer: "" };
  }
}

// Boot directives MUST land, but the scene may still be initializing when we
// fire them — a miss used to be silently swallowed (no intro screen, wrong fps
// hints). Retry until SceneAPI accepts. (Our analog of hyperframes' "replay
// bridge state on iframe ready" handshake-race fix.)
async function applyWhenReady(label, attempt, tries = 24, delayMs = 500) {
  for (let i = 0; i < tries; i++) {
    const ok = await attempt().catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn(`[boot] ${label} never applied — scene did not become ready in ${(tries * delayMs) / 1000}s`);
  return false;
}

// tell the scene which render mode it's in (toggles blend modes, fps, warning)
async function applyRenderMode(mode, fps) {
  return applyWhenReady("setRenderMode", () =>
    page.evaluate((m, f) => {
      if (!window.SceneAPI || typeof window.SceneAPI.setRenderMode !== "function") return false;
      window.SceneAPI.setRenderMode({ mode: m, fps: f });
      return true;
    }, mode, fps));
}

/**
 * Watch a directives file. Each time it changes we read it and apply it.
 * Lets you drive the live scene by writing JSON to a file (great for testing
 * inside the container, and a stand-in for the Phase 2 Director's output).
 */
async function watchDirectives() {
  const file = config.directivesFile;
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  let lastRaw = "";
  console.log("[watch] watching directives file:", file);
  try {
    const watcher = watch(path.dirname(file));
    for await (const _evt of watcher) {
      if (!existsSync(file)) continue;
      let raw;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (!raw.trim() || raw === lastRaw) continue;
      lastRaw = raw;
      try {
        const directive = JSON.parse(raw);
        const out = await applyDirective(directive);
        console.log("[watch] applied:", JSON.stringify(directive), "→", JSON.stringify(out));
      } catch (e) {
        console.error("[watch] bad directive:", e.message);
      }
    }
  } catch (e) {
    console.error("[watch] watcher stopped:", e.message);
  }
}

async function main() {
  if (!config.dryRun && !config.streamKey && !config.outputFile) {
    console.error("FATAL: YT_STREAM_KEY is empty and DRY_RUN is false. Set one or the other.");
    process.exit(1);
  }

  const app = buildControlApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(config.controlPort, r));
  const localUrl = `http://localhost:${config.controlPort}/`;
  console.log(`[control] listening on ${localUrl} (POST /mutate, GET /health)`);

  // Render targets: GPU → 1080p60 (1280x720 viewport @1.5 DSF = 1920x1080 device);
  // CPU fallback → 720p30. Xvfb (for the CPU path) is 1280x720 from start.sh.
  // GPU output is env-tunable (default 720p30 = smooth, since screencast can't
  // evenly deliver 1080p60). Bump GPU_W/H/FPS in .env + restart to try higher.
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  const gW = num(process.env.GPU_W, 1280), gH = num(process.env.GPU_H, 720);
  const GPU = { headless: true, width: gW, height: gH, dsf: 1, fps: num(process.env.GPU_FPS, 30), bitrate: process.env.GPU_BITRATE || "4500k", capW: gW, capH: gH };
  const CPU = { headless: false, width: 1280, height: 720, dsf: 1, fps: 30, bitrate: "4500k" };

  let eff;
  if (config.capture === "screencast") {
    eff = GPU;
    await launchBrowser(localUrl, eff);
    const probe = await probeGPU();
    if (probe.hardware) {
      renderMode = "gpu"; gpuRenderer = probe.renderer;
      console.log("[gpu] hardware renderer:", probe.renderer);
    } else {
      console.warn(`[gpu] no hardware GPU (${probe.renderer || "none"}) — falling back to CPU (x11grab, 720p30)`);
      await browser.close().catch(() => {});
      renderMode = "cpu"; eff = CPU;
      await launchBrowser(localUrl, eff);
    }
  } else {
    renderMode = "cpu"; eff = CPU;
    await launchBrowser(localUrl, eff);
  }

  // tell the scene its mode + target fps (so motion fps == capture fps)
  await applyRenderMode(renderMode, eff.fps);

  // WATCHDOG: a crashed Chromium doesn't kill ffmpeg — the pump just duplicates
  // the last frame forever, so the stream freezes while /health still says ok.
  // Exit instead and let `restart: unless-stopped` bring the pipeline back
  // clean. Registered only now, AFTER the GPU-probe fallback may have closed
  // and relaunched the browser (that close is intentional, not a crash).
  browser.on("disconnected", () => {
    if (stopping) return;
    console.error("[watchdog] browser disconnected — exiting for a clean container restart");
    process.exit(1);
  });
  // and a liveness ping: a hung/crashed renderer can leave the browser process
  // up but the page frozen. NB: a quiet screencast is NOT a crash signal (static
  // scenes legitimately stop repainting) — only an unresponsive page is.
  let pingFails = 0;
  setInterval(async () => {
    if (stopping) return;
    const ok = await Promise.race([
      page.evaluate("1").then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
    pingFails = ok ? 0 : pingFails + 1;
    if (!ok) console.warn(`[watchdog] scene ping failed (${pingFails}/3)`);
    if (pingFails >= 3) {
      console.error("[watchdog] scene page unresponsive ~90s — exiting for a clean container restart");
      process.exit(1);
    }
  }, 30000).unref();

  // optionally come up on the "starting shortly" standby screen — retried,
  // because booting straight into the bare show (directive lost while the
  // scene initialized) is exactly what an operator can't notice from logs
  if (config.standbyOnBoot) {
    await applyWhenReady("setStandby(intro)", async () => {
      const out = await applyDirective({ action: "setStandby", params: { mode: "intro" } });
      return !!out?.ok;
    });
  }

  if (config.dryRun) {
    console.log("[stream] DRY_RUN=true → not pushing. Scene is rendering only.");
  } else if (renderMode === "gpu") {
    streamer = startScreencastStreamer({ fps: eff.fps, bitrate: eff.bitrate });
    const cdp = await page.target().createCDPSession();
    let frames = 0, captured = 0;
    let latestFrame = null;
    // Chromium screencasts faster than the output fps and unevenly. We keep only
    // the LATEST frame and PUMP it to ffmpeg at EXACTLY the output fps, on a
    // self-correcting wall-clock timer. That gives ffmpeg an even CFR stream
    // (smooth — no resample against the 30fps GSAP motion) whose frame count
    // tracks real time (so the -framerate timestamps never drift from audio).
    cdp.on("Page.screencastFrame", (f) => {
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); // keep frames flowing
      latestFrame = Buffer.from(f.data, "base64");
      monitorFrame = latestFrame; // share with /monitor.mjpeg (same frames ffmpeg gets)
      captured++;
    });
    const frameIntervalMs = 1000 / eff.fps;
    let nextTick = Date.now();
    const pump = () => {
      nextTick += frameIntervalMs;
      if (latestFrame) { streamer.write(latestFrame); frames++; } // dup latest if capture stalled (CFR held)
      setTimeout(pump, Math.max(0, nextTick - Date.now())); // self-correct → exact fps, no drift
    };
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: num(process.env.SCREENCAST_QUALITY, 92), maxWidth: eff.capW, maxHeight: eff.capH, everyNthFrame: 1 });
    pump();
    setInterval(() => console.log(`[screencast] pumped ${frames} / captured ${captured} frames (@${eff.fps} wall-locked)`), 15000);
    console.log(`[stream] GPU screencast ${eff.capW}x${eff.capH}@${eff.fps} →`, config.outputFile || "RTMP");
  } else {
    streamer = startStreamer({ width: eff.width, height: eff.height, fps: eff.fps, bitrate: eff.bitrate });
    console.log(`[stream] CPU x11grab ${eff.width}x${eff.height}@${eff.fps} → RTMP`);
  }

  watchDirectives(); // fire and forget

  // auto-DJ: resolves the rotation, plays into the pulse sink ffmpeg captures,
  // and pushes now-playing/likes/queue to the scene. Only when AUDIO_MODE=music.
  if (config.music) {
    dj = createDJ({
      // boot into intro music when we come up on the standby screen, so the
      // pre-show has its own loop until the operator runs `live.sh onair`
      mode: config.standbyOnBoot ? "intro" : "live",
      onUpdate: (st) => { applyDirective({ action: "setNowPlaying", params: st }).catch(() => {}); },
      log: console.log,
    });
    dj.start().catch((e) => console.error("[dj] start failed:", e.message));
    console.log("[music] auto-DJ enabled (AUDIO_MODE=music)");

    // audio-reactive eq bars: tap the sink loudness, push to the scene (~18fps)
    let lastEq = 0;
    meter = createMeter({
      onLevels: (bands) => {
        const now = Date.now();
        if (now - lastEq < 36) return; // cap at ~28fps of page evaluates
        lastEq = now;
        const push = () => applyDirective({ action: "setEqLevels", params: { bands } }).catch(() => {});
        if (config.barDelayMs > 0) setTimeout(push, config.barDelayMs); else push();
      },
      log: console.log,
    });
    meter.start();
  }

  // graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n[shutdown] ${sig} received`);
    stopping = true;
    if (meter) meter.stop();
    if (dj) dj.stop();
    if (streamer) streamer.stop();
    if (browser) await browser.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
