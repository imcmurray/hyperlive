// Audio level meter: taps the SAME PulseAudio sink the music plays into and
// emits a smoothed 0..1 loudness envelope ~20×/sec, so the now-playing eq bars
// can dance to the actual music. A monitor source allows multiple readers, so
// this runs alongside the main capture ffmpeg without disturbing it.

import { spawn } from "node:child_process";
import { config } from "../config.js";

export function createMeter({ onLevel = () => {}, log = () => {} }) {
  let proc = null, stopped = false, level = 0;
  const FLOOR = -48, CEIL = -9; // dB window mapped to 0..1

  function start() {
    if (stopped) return;
    proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "info", "-nostats",
      "-f", "pulse", "-i", config.pulseMonitor,
      // ~2205 samples @44.1k ≈ 20 windows/sec; print the per-window RMS level
      "-af", "asetnsamples=n=2205:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = line.match(/RMS_level=(-?inf|-?\d+(?:\.\d+)?)/i);
        if (!m) continue;
        const db = /inf/i.test(m[1]) ? FLOOR : parseFloat(m[1]);
        const v = Math.max(0, Math.min(1, (db - FLOOR) / (CEIL - FLOOR)));
        // fast attack, slower release → punchy but not jittery
        level = v > level ? v * 0.6 + level * 0.4 : v * 0.28 + level * 0.72;
        onLevel(level);
      }
    });
    proc.on("exit", () => { proc = null; if (!stopped) setTimeout(start, 1000); });
    log("[meter] audio level meter started");
  }

  return { start, stop() { stopped = true; if (proc) proc.kill("SIGKILL"); } };
}
