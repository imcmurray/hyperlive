import http from "node:http";
import { readFile, watch, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import puppeteer from "puppeteer-core";
import { config, ingestUrl } from "./config.js";
import { startStreamer, startScreencastStreamer } from "./ffmpeg.js";

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
  "renderWarning",
  "status",
]);

let page = null;
let streamer = null;
let browser = null;
let renderMode = "?"; // gpu | cpu
let gpuRenderer = "";

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
  const params = directive?.params && typeof directive.params === "object" ? directive.params : {};
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

function buildControlApp() {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.get("/favicon.ico", (_req, res) => res.status(204).end()); // keep the scene console clean
  app.use(express.static(SCENE_DIR));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      sceneReady: !!page,
      ffmpegUp: streamer ? streamer.isUp() : false,
      ffmpegRestarts: streamer ? streamer.restarts() : 0,
      renderMode,
      gpuRenderer,
      dryRun: config.dryRun,
      ingest: config.dryRun ? null : `${config.rtmpUrl}/<key>`,
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
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction("window.__sceneReady === true", { timeout: 10000 }).catch(() => {
    console.warn("[scene] __sceneReady not observed within 10s; continuing");
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

// tell the scene which render mode it's in (toggles blend modes, fps, warning)
async function applyRenderMode(mode, fps) {
  await page.evaluate((m, f) => window.SceneAPI && window.SceneAPI.setRenderMode && window.SceneAPI.setRenderMode({ mode: m, fps: f }), mode, fps).catch(() => {});
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

  if (config.dryRun) {
    console.log("[stream] DRY_RUN=true → not pushing. Scene is rendering only.");
  } else if (renderMode === "gpu") {
    streamer = startScreencastStreamer({ fps: eff.fps, bitrate: eff.bitrate });
    const cdp = await page.target().createCDPSession();
    let frames = 0;
    cdp.on("Page.screencastFrame", (f) => {
      // ack immediately (fire-and-forget) so the next frame is requested without
      // a round-trip stall, THEN hand the frame to ffmpeg
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      streamer.write(Buffer.from(f.data, "base64"));
      frames++;
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: num(process.env.SCREENCAST_QUALITY, 92), maxWidth: eff.capW, maxHeight: eff.capH, everyNthFrame: 1 });
    setInterval(() => console.log(`[screencast] ${frames} frames delivered so far`), 15000);
    console.log(`[stream] GPU screencast ${eff.capW}x${eff.capH}@${eff.fps} →`, config.outputFile || "RTMP");
  } else {
    streamer = startStreamer({ width: eff.width, height: eff.height, fps: eff.fps, bitrate: eff.bitrate });
    console.log(`[stream] CPU x11grab ${eff.width}x${eff.height}@${eff.fps} → RTMP`);
  }

  watchDirectives(); // fire and forget

  // graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n[shutdown] ${sig} received`);
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
