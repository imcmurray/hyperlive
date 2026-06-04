// Auto-DJ: plays audio into the PulseAudio sink that the main ffmpeg captures,
// so songs change live without ever restarting the RTMP push. Plays the request
// QUEUE first, then falls back to the house ROTATION (the operator's own songs).
// Per-song likes are tallied here and surfaced on the now-playing card.
//
// The player is `mpv` streaming the resolved Suno CDN url. When a track ends (or
// is skipped) mpv exits and we start the next one. A track that fails fast is
// re-resolved once (the CDN url may have gone stale) before we move on.

import { spawn } from "node:child_process";
import { resolveSuno } from "./resolve.js";
import { ROTATION } from "./rotation.js";
import { config } from "../config.js";

export function createDJ({ onUpdate = () => {}, log = () => {} }) {
  const rotation = [];        // resolved house tracks {audioUrl,title,artist,share}
  const queue = [];           // resolved requests {..., who}
  let current = null;         // the playing track (+ .likes Set, .who)
  let player = null;          // mpv child
  let rotIdx = 0;
  let stopped = false;
  let updateTimer = null;

  function status() {
    return {
      title: current?.title || "",
      artist: current?.artist || "",
      image: current?.image || "",         // cover art (Suno og:image)
      who: current?.who || "",            // who requested it ("" = house rotation)
      source: current?.source || "",       // "request" | "rotation"
      likes: current ? current.likes.size : 0,
      queue: queue.length,
    };
  }
  // coalesce rapid updates (likes can arrive in bursts) into one scene push
  function pushUpdate() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => { updateTimer = null; onUpdate(status()); }, 120);
  }

  async function resolveAll(links, who) {
    const out = [];
    for (const link of links) {
      const r = await resolveSuno(link).catch(() => ({ ok: false }));
      if (r.ok) out.push({ audioUrl: r.audioUrl, image: r.image, title: r.title, artist: r.artist, share: link, who: who || "" });
      else log(`  ♪ resolve failed: ${link} (${r.error || "?"})`);
    }
    return out;
  }

  function nextTrack() {
    if (queue.length) return { ...queue.shift(), source: "request" };
    if (!rotation.length) return null;
    const t = rotation[rotIdx % rotation.length];
    rotIdx += 1;
    return { ...t, who: "", source: "rotation" };
  }

  function play(track) {
    if (stopped) return;
    current = { ...track, likes: new Set() };
    const started = Date.now();
    log(`  ♪ now playing: ${track.title} — ${track.artist}${track.who ? ` (req ${track.who})` : ""}`);
    pushUpdate();
    // mpv: stream the url into our pulse sink, no video, no user config
    player = spawn("mpv", [
      "--no-video", "--no-config", "--really-quiet", "--cache=yes",
      "--ao=pulse", `--audio-device=pulse/${config.pulseSink}`, "--volume=100",
      track.audioUrl,
    ], { stdio: "ignore" });

    player.on("exit", async () => {
      player = null;
      if (stopped) return;
      const ranMs = Date.now() - started;
      // failed fast → the CDN url may be stale; re-resolve the share once
      if (ranMs < 2500 && track.share) {
        const r = await resolveSuno(track.share).catch(() => ({ ok: false }));
        if (r.ok && r.audioUrl !== track.audioUrl) {
          log(`  ♪ re-resolved stale url for ${track.title}`);
          return play({ ...track, audioUrl: r.audioUrl });
        }
        // still bad → small delay so a broken track can't hot-loop the player
        await new Promise((res) => setTimeout(res, 800));
      }
      play(nextTrack() || { title: "", artist: "", audioUrl: "", who: "", source: "" });
    });
  }

  return {
    async start() {
      log(`[dj] resolving ${ROTATION.length} rotation tracks…`);
      rotation.push(...(await resolveAll(ROTATION)));
      log(`[dj] rotation ready: ${rotation.length}/${ROTATION.length} tracks`);
      const first = nextTrack();
      if (first) play(first); else log("[dj] no playable rotation tracks — idle");
    },

    // add a requested Suno share link to the queue (resolved + validated here)
    async enqueue(shareUrl, who) {
      if (queue.length >= config.queueMax) return { ok: false, reason: "queue full" };
      if (queue.some((t) => t.share === shareUrl) || current?.share === shareUrl) {
        return { ok: false, reason: "already queued" };
      }
      const r = await resolveSuno(shareUrl).catch(() => ({ ok: false, error: "resolve error" }));
      if (!r.ok) return { ok: false, reason: r.error || "could not resolve" };
      queue.push({ audioUrl: r.audioUrl, image: r.image, title: r.title, artist: r.artist, share: shareUrl, who: who || "" });
      log(`  ♪ queued: ${r.title} — ${r.artist} (req ${who || "?"}) [${queue.length} in queue]`);
      pushUpdate();
      return { ok: true, title: r.title, artist: r.artist, position: queue.length };
    },

    // like the CURRENT song (one per author per song); returns the new count
    like(author) {
      if (!current || !current.title) return { ok: false, likes: 0 };
      const a = String(author || "anon");
      const had = current.likes.has(a);
      current.likes.add(a);
      if (!had) pushUpdate();
      return { ok: true, likes: current.likes.size, fresh: !had };
    },

    skip() { if (player) { log("  ♪ skip"); player.kill("SIGTERM"); } },
    status,
    stop() { stopped = true; if (player) player.kill("SIGKILL"); },
  };
}
