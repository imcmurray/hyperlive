import { spawn } from "node:child_process";
import { config, ingestUrl } from "./config.js";

const RENDER_NODE = process.env.RENDER_NODE || "/dev/dri/renderD128";

// audio source (YouTube requires an audio track even when silent).
//  music → capture the PulseAudio sink the auto-DJ plays into (live, switchable)
//  tone  → a test sine; silent → anullsrc
function audioInput() {
  if (config.audioMode === "music")
    return ["-thread_queue_size", "1024", "-f", "pulse", "-i", config.pulseMonitor];
  return config.audioMode === "tone"
    ? ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100"]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
}

function audioEncode() {
  // The eq bars travel a slow path (meter → browser → capture) while the audio
  // is near-direct, so the bars lag the beat. Delaying the audio by ~that lag
  // realigns them in the output. Tunable via AUDIO_DELAY_MS.
  const ms = config.audioMode === "music" ? config.audioDelayMs : 0;
  const delay = ms > 0 ? ["-af", `adelay=${ms}:all=1`] : [];
  return [...delay, "-c:a", "aac", "-b:a", "128k", "-ar", "44100"];
}

// software H.264 (libx264). CBR by default: PAD to the target bitrate so YouTube
// always gets its recommended rate even on calm/near-static scenes — a plain
// -b:v cap under-shoots hard there (that's the "stream bitrate too low" warning).
// Set X264_RC=vbr to cap-not-pad (smaller, variable — e.g. for OUTPUT_FILE tests).
function x264Video(fps, bitrate) {
  const gop = fps * 2;
  const kbps = parseInt(bitrate);
  const cbr = (process.env.X264_RC || "cbr").toLowerCase() !== "vbr";
  return [
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main",
    "-pix_fmt", "yuv420p", "-r", String(fps), "-vsync", "cfr",
    "-g", String(gop), "-keyint_min", String(fps), "-sc_threshold", "0",
    "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", `${kbps * 2}k`,
    ...(cbr ? ["-minrate", bitrate, "-x264-params", "nal-hrd=cbr:force-cfr=1"] : []),
  ];
}

function sink() {
  return config.outputFile ? ["-y", config.outputFile] : ["-f", "flv", ingestUrl()];
}

/**
 * x11grab pipeline (software / CPU path). settings: { width, height, fps, bitrate }
 */
function buildX11Args(s) {
  return [
    "-loglevel", "warning", "-fflags", "+genpts",
    "-thread_queue_size", "512", "-probesize", "32M",
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(s.fps), "-video_size", `${s.width}x${s.height}`, "-i", config.display,
    ...audioInput(),
    ...x264Video(s.fps, s.bitrate),
    ...audioEncode(),
    ...sink(),
  ];
}

/**
 * Screencast pipeline (GPU path): JPEG frames from stdin (CDP), normalize to CFR.
 * HW_ENCODE=true → encode H.264 on the iGPU (VAAPI) instead of x264, freeing the
 * CPU so Chromium's JPEG screencast can deliver more frames. settings: { fps, bitrate }
 */
function buildScreencastArgs(s) {
  const hw = process.env.HW_ENCODE === "true";
  if (hw) {
    return [
      "-loglevel", "warning",
      "-vaapi_device", RENDER_NODE,
      // The node side PUMPS the pipe at EXACTLY s.fps locked to wall-clock, so
      // declaring it CFR here gives even timestamps (smooth, no resample) that
      // also track real time (no A/V drift).
      "-framerate", String(s.fps), "-f", "image2pipe", "-i", "pipe:0",
      ...audioInput(),
      "-vf", "format=nv12,hwupload",
      // This iGPU exposes only the low-power H264 encoder (VAEntrypointEncSliceLP),
      // which ONLY supports CQP — no VBR/CBR, so we can't target a bitrate on the
      // GPU. QP is the only lever: LOWER qp ⇒ higher quality + higher bitrate (the
      // fix for "bitrate too low" on calm scenes). For a GUARANTEED bitrate, use
      // the CPU path instead (HW_ENCODE=false → libx264 CBR, padded to target).
      "-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", String(parseInt(process.env.GPU_QP || "20")),
      "-g", String(s.fps * 2), "-r", String(s.fps), "-vsync", "cfr",
      ...audioEncode(),
      "-shortest",
      ...sink(),
    ];
  }
  return [
    "-loglevel", "warning",
    // pumped at exactly s.fps (wall-clock locked) → even CFR timestamps, no drift
    "-framerate", String(s.fps), "-f", "image2pipe", "-i", "pipe:0",
    ...audioInput(),
    ...x264Video(s.fps, s.bitrate),
    ...audioEncode(),
    "-shortest",
    ...sink(),
  ];
}

// if ffmpeg stops reading stdin (RTMP stall), Node buffers writes in memory
// without bound — cap the buffer and DROP frames past it. Dropping is free
// here: the pump re-sends the latest frame every tick anyway. ~8MB ≈ 2s of
// frames at 30fps, plenty to ride out a hiccup without risking an OOM kill.
const MAX_STDIN_BUFFER = 8 * 1024 * 1024;

// generic supervisor: respawns ffmpeg on exit (reconnect)
function supervise(label, argsFn, withStdin) {
  let child = null, stopping = false, restarts = 0, lastDropLog = 0;
  function spawnOnce() {
    if (stopping) return;
    console.log(`[${label}] starting → ${config.outputFile || config.rtmpUrl + "/<key>"} (${restarts} restarts)`);
    child = spawn("ffmpeg", argsFn(), { stdio: [withStdin ? "pipe" : "ignore", "inherit", "inherit"] });
    if (withStdin) child.stdin.on("error", () => {}); // ignore EPIPE during respawn
    child.on("exit", (code, signal) => {
      if (stopping) return;
      restarts += 1;
      console.error(`[${label}] exited code=${code} signal=${signal}; respawning in 2s`);
      setTimeout(spawnOnce, 2000);
    });
    child.on("error", (err) => console.error(`[${label}] spawn error:`, err.message));
  }
  spawnOnce();
  return {
    write(buf) {
      if (!withStdin || !child || !child.stdin.writable) return;
      if (child.stdin.writableLength > MAX_STDIN_BUFFER) {
        const now = Date.now();
        if (now - lastDropLog > 5000) { lastDropLog = now; console.error(`[${label}] stdin backed up (${Math.round(child.stdin.writableLength / 1048576)}MB) — dropping frames`); }
        return;
      }
      try { child.stdin.write(buf); } catch {}
    },
    isUp: () => !!child && child.exitCode === null,
    restarts: () => restarts,
    stop() { stopping = true; if (child) child.kill("SIGTERM"); },
  };
}

export function startStreamer(settings) {
  return supervise("ffmpeg", () => buildX11Args(settings), false);
}

export function startScreencastStreamer(settings) {
  return supervise("ffmpeg-sc", () => buildScreencastArgs(settings), true);
}
