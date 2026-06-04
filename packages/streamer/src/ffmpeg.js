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
  return ["-c:a", "aac", "-b:a", "128k", "-ar", "44100"];
}

// software H.264 (libx264)
function x264Video(fps, bitrate) {
  const gop = fps * 2;
  return [
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main",
    "-pix_fmt", "yuv420p", "-r", String(fps), "-vsync", "cfr",
    "-g", String(gop), "-keyint_min", String(fps), "-sc_threshold", "0",
    "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", `${parseInt(bitrate) * 2}k`,
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
      "-f", "image2pipe", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
      ...audioInput(),
      "-vf", "format=nv12,hwupload",
      // iHD low-power encoder only supports CQP (constant quality) rate control
      "-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", String(parseInt(process.env.GPU_QP || "24")),
      "-g", String(s.fps * 2), "-r", String(s.fps), "-vsync", "cfr",
      ...audioEncode(),
      "-shortest",
      ...sink(),
    ];
  }
  return [
    "-loglevel", "warning",
    "-f", "image2pipe", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
    ...audioInput(),
    ...x264Video(s.fps, s.bitrate),
    ...audioEncode(),
    "-shortest",
    ...sink(),
  ];
}

// generic supervisor: respawns ffmpeg on exit (reconnect)
function supervise(label, argsFn, withStdin) {
  let child = null, stopping = false, restarts = 0;
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
    write(buf) { if (withStdin && child && child.stdin.writable) { try { child.stdin.write(buf); } catch {} } },
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
