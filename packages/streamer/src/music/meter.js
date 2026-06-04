// Audio spectrum meter: taps the SAME PulseAudio sink the music plays into and
// emits 4 frequency-band levels (0..1) ~30×/sec, so the now-playing eq bars are
// a real little spectrum that tracks the music — bass drives the low bar, etc.
// A monitor source allows multiple readers, so this runs alongside the main
// capture ffmpeg without disturbing it.
//
// ffmpeg splits the signal into 4 bands, joins them as a 4-channel stream, and
// astats then reports per-CHANNEL RMS (one channel == one band). Each band is
// auto-normalized against its own slowly-decaying peak so quiet bands still
// move and every bar uses its full height.

import { spawn } from "node:child_process";
import { config } from "../config.js";

const N = 4;
// FIXED dB→0..1 mapping per band, spanning each band's MEASURED dynamic range so
// the bars use their full travel (lively) while true quiet still maps to 0 (no
// auto-gain pumping). floor = empty at/below; ceil = full at/above. Tunable via
// EQ_FLOOR / EQ_CEIL (comma-separated dB) without a code change.
const envNums = (s, d) => (s ? s.split(",").map(Number) : d);
const FLOOR = envNums(process.env.EQ_FLOOR, [-50, -45, -33, -32]);
const CEIL = envNums(process.env.EQ_CEIL, [-18, -18, -14, -15]);
const GAMMA = Number(process.env.EQ_GAMMA || 1.0); // 1 = linear (max movement)

export function createMeter({ onLevels = () => {}, log = () => {} }) {
  let proc = null, stopped = false;
  const level = [0, 0, 0, 0];
  let cur = [null, null, null, null];

  function emit() {
    for (let i = 0; i < N; i++) {
      const db = Number.isFinite(cur[i]) ? cur[i] : -120; // null/inf/NaN → silence
      let v = (db - FLOOR[i]) / (CEIL[i] - FLOOR[i]);
      v = Math.pow(Math.max(0, Math.min(1, v)), GAMMA);
      if (!Number.isFinite(v)) v = 0; // never let NaN poison the smoothed level
      // INSTANT attack (the bar jumps on the beat — no smoothing lag), quick release
      level[i] = v > level[i] ? v : v * 0.6 + level[i] * 0.4;
    }
    onLevels(level.slice());
    cur = [null, null, null, null];
  }

  function start() {
    if (stopped) return;
    proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "info", "-nostats",
      "-f", "pulse", "-i", config.pulseMonitor,
      "-af", [
        "asplit=4[a][b][c][d]",
        "[a]lowpass=f=140[w]",        // sub/bass (kick)
        "[b]bandpass=f=500[x]",       // low-mid
        "[c]bandpass=f=2500[y]",      // high-mid (vocals/snare)
        "[d]highpass=f=6000[z]",      // treble (hats/cymbals)
        "[w][x][y][z]join=inputs=4:channel_layout=4.0[m]",
        // ~1470 samples @44.1k ≈ 30 windows/sec
        "[m]asetnsamples=n=1470:p=0,astats=metadata=1:reset=1,ametadata=print",
      ].join(";"),
      "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const band = line.match(/astats\.([1-4])\.RMS_level=(-?inf|-?\d+(?:\.\d+)?)/i);
        if (band) {
          cur[+band[1] - 1] = /inf/i.test(band[2]) ? -120 : parseFloat(band[2]); // scalar, not the array
        } else if (/astats\.Overall\.RMS_level=/i.test(line)) {
          emit(); // Overall is the last key of each window → flush
        }
      }
    });
    proc.on("exit", () => { proc = null; if (!stopped) setTimeout(start, 1000); });
    log("[meter] 4-band spectrum meter started");
  }

  return { start, stop() { stopped = true; if (proc) proc.kill("SIGKILL"); } };
}
