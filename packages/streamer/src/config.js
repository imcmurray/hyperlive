// Central config, all from env so nothing secret is committed.
const int = (v, d) => (v === undefined || v === "" ? d : parseInt(v, 10));

export const config = {
  // --- output / encode ---
  width: int(process.env.VIDEO_WIDTH, 1280),
  height: int(process.env.VIDEO_HEIGHT, 720),
  fps: int(process.env.VIDEO_FPS, 30),
  videoBitrate: process.env.VIDEO_BITRATE || "4500k",
  // silent | tone | music | source
  //   music  → run the auto-DJ AND capture the pulse sink it plays into
  //   source → capture the pulse sink (the BROWSER's audio — a video stage
  //            source's sound) WITHOUT the DJ. This is what overlay mode uses.
  audioMode: (process.env.AUDIO_MODE || "silent").toLowerCase(),

  // --- music (auto-DJ → PulseAudio sink → captured by ffmpeg) ---
  // AUDIO_MODE=music makes ffmpeg capture the sink AND starts the DJ daemon.
  music: (process.env.AUDIO_MODE || "silent").toLowerCase() === "music",
  // capture the pulse sink monitor (music OR source mode). When on, start.sh
  // brings the sink up as Chromium's DEFAULT output, so a video stage source's
  // audio is captured automatically — and ffmpeg pulls from the sink monitor.
  captureSink: ["music", "source"].includes((process.env.AUDIO_MODE || "silent").toLowerCase()),
  pulseSink: process.env.PULSE_SINK || "hyperlive",                    // null-sink name
  pulseMonitor: (process.env.PULSE_SINK || "hyperlive") + ".monitor", // ffmpeg pulse source
  queueMax: int(process.env.MUSIC_QUEUE_MAX, 20),                     // max requests waiting
  // delay output audio to line up with the eq bars' render/capture lag (ms)
  audioDelayMs: int(process.env.AUDIO_DELAY_MS, 150),
  // delay the eq-bar updates themselves (ms) — for sync testing
  barDelayMs: int(process.env.BAR_DELAY_MS, 0),

  // --- YouTube RTMP ---
  rtmpUrl: process.env.YT_RTMP_URL || "rtmp://a.rtmp.youtube.com/live2",
  streamKey: process.env.YT_STREAM_KEY || "",

  // --- local ---
  controlPort: int(process.env.CONTROL_PORT, 8080),
  display: process.env.DISPLAY || ":99",
  chromiumPath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",

  // file the streamer watches for directives (one JSON object per write)
  directivesFile: process.env.DIRECTIVES_FILE || "/app/control/directives.json",

  // when true, run the scene + control server + browser but DON'T push RTMP
  // (handy for local visual testing without a YouTube key)
  dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",

  // show the "starting shortly" standby screen on boot (operator reveals the
  // show with `live.sh onair`). Default off → boots straight into the live scene.
  standbyOnBoot: (process.env.STANDBY_ON_BOOT || "false").toLowerCase() === "true",

  // capture path: "x11grab" (headful + Xvfb, software) | "screencast" (headless + GPU via CDP)
  capture: (process.env.CAPTURE || "x11grab").toLowerCase(),
  // if set, screencast encoder writes to this file instead of RTMP (for safe testing)
  outputFile: process.env.OUTPUT_FILE || "",
};

export function ingestUrl() {
  const base = config.rtmpUrl.replace(/\/+$/, "");
  return `${base}/${config.streamKey}`;
}
