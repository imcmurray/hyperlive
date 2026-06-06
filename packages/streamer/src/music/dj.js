// Auto-DJ: plays audio into the PulseAudio sink that the main ffmpeg captures,
// so songs change live without ever restarting the RTMP push. Plays the request
// QUEUE first, then falls back to the house ROTATION (the operator's own songs).
// Per-song likes are tallied here and surfaced on the now-playing card.
//
// The player is `mpv` streaming the resolved Suno CDN url. When a track ends (or
// is skipped) mpv exits and we start the next one. A track that fails fast is
// re-resolved once (the CDN url may have gone stale) before we move on.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolveSuno } from "./resolve.js";
import { ROTATION } from "./rotation.js";
import { INTRO } from "./intro.js";
import { config } from "../config.js";

// the waiting request queue is persisted here so a streamer restart doesn't drop
// viewer requests (the bind-mounted control/ survives container rebuilds)
const QUEUE_FILE = process.env.MUSIC_QUEUE_FILE || "./control/music-queue.json";
// per-song heart counts, keyed by Suno share URL, persisted so a song resumes its
// like total the next time it plays (and across restarts). Stores the SET of
// likers per song → "one like per author per song" survives replays too.
const SONG_LIKES_FILE = process.env.SONG_LIKES_FILE || "./control/song-likes.json";

export function createDJ({ onUpdate = () => {}, log = () => {}, mode: initialMode = "live" }) {
  const rotation = [];        // resolved house tracks {audioUrl,title,artist,share}
  const intro = [];           // resolved pre-show intro tracks (looped in "intro" mode)
  const queue = [];           // resolved requests {..., who}
  let current = null;         // the playing track (+ .likes Set, .who)
  let player = null;          // mpv child
  let rotIdx = 0;
  let introIdx = 0;
  // "intro" = loop the pre-show INTRO tracks (under the standby screen);
  // "live"  = play the request queue, then the house rotation. Going on air
  // flips intro → live (see setMode).
  let mode = initialMode === "intro" ? "intro" : "live";
  // unique Suno creators whose tracks have played since we went on air — shown
  // on the outro as a thank-you credit (reset each time we go live; see setMode)
  const liveArtists = new Set();
  const songLikes = new Map(); // share URL → Set<author> (persisted; survives replays + restarts)
  let songLikesTimer = null;
  let stopped = false;
  let updateTimer = null;

  async function saveQueue() {
    try { await writeFile(QUEUE_FILE, JSON.stringify(queue)); } catch { /* non-fatal */ }
  }
  async function loadSongLikes() {
    try {
      const obj = JSON.parse(await readFile(SONG_LIKES_FILE, "utf8"));
      if (obj && typeof obj === "object") {
        for (const [share, likers] of Object.entries(obj)) {
          if (Array.isArray(likers)) songLikes.set(share, new Set(likers.map(String)));
        }
      }
    } catch { /* none yet */ }
  }
  function saveSongLikes() { // debounced — likes can arrive in bursts
    if (songLikesTimer) return;
    songLikesTimer = setTimeout(async () => {
      songLikesTimer = null;
      const obj = {};
      for (const [share, set] of songLikes) obj[share] = [...set];
      try { await writeFile(SONG_LIKES_FILE, JSON.stringify(obj)); } catch { /* non-fatal */ }
    }, 1000);
  }
  // the persistent liker set for a track (created on first play), so likes added
  // while it plays write straight back into the map → restored next time it plays
  function likeSetFor(track) {
    if (!track || !track.share) return new Set();
    let set = songLikes.get(track.share);
    if (!set) { set = new Set(); songLikes.set(track.share, set); }
    return set;
  }
  async function loadQueue() {
    try {
      const saved = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
      if (Array.isArray(saved)) return saved.filter((t) => t && t.share && t.audioUrl);
    } catch { /* none */ }
    return [];
  }

  // --- volume fade (ramp the pulse sink volume → what ffmpeg captures) ---
  let sinkVol = 100;          // current sink volume %
  let fadeTimer = null;
  let skipping = false;       // a deliberate skip (don't treat as a fast-fail)
  let fadeInPending = false;  // fade the next track up once it starts (skip segue)
  function applySinkVol(pct) {
    sinkVol = Math.max(0, Math.min(100, Math.round(pct)));
    try { spawn("pactl", ["set-sink-volume", config.pulseSink, sinkVol + "%"], { stdio: "ignore" }); } catch { /* no pulse */ }
  }
  function fade(target, ms) {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    target = Math.max(0, Math.min(100, Number(target)));
    const dur = Math.max(100, Number(ms) || 4000);
    const steps = Math.max(1, Math.round(dur / 120));
    const start = sinkVol, delta = (target - start) / steps;
    let i = 0;
    log(`  ♪ fade ${start}% → ${target}% over ${dur}ms`);
    fadeTimer = setInterval(() => {
      i += 1;
      applySinkVol(i >= steps ? target : start + delta * i);
      if (i >= steps) { clearInterval(fadeTimer); fadeTimer = null; }
    }, 120);
  }

  function status() {
    return {
      title: current?.title || "",
      artist: current?.artist || "",
      image: current?.image || "",         // cover art (Suno og:image)
      who: current?.who || "",            // who requested it ("" = house rotation)
      source: current?.source || "",       // "intro" | "request" | "rotation"
      likes: current ? current.likes.size : 0,
      queue: queue.length,
      mode,                                // "intro" (pre-show) | "live"
    };
  }
  // full up-next picture: requested songs, then the house rotation (ordered so
  // the one that plays next is first) — which fills in when no requests are queued
  function queueInfo() {
    const n = rotation.length;
    const i = n ? rotIdx % n : 0;
    const rot = n ? rotation.slice(i).concat(rotation.slice(0, i)) : [];
    const lite = (t) => ({ title: t.title, artist: t.artist, image: t.image || "", who: t.who || "" });
    return {
      current: current?.title ? { ...lite(current), source: current.source || "", likes: current.likes.size } : null,
      queue: queue.map(lite),
      rotation: rot.map((t) => ({ title: t.title, artist: t.artist, image: t.image || "" })),
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
    // pre-show: loop the intro tracks until we go on air (falls through to the
    // queue/rotation if no intro track resolved, so the show is never silent)
    if (mode === "intro" && intro.length) {
      const t = intro[introIdx % intro.length];
      introIdx += 1;
      return { ...t, who: "", source: "intro" };
    }
    if (queue.length) { const t = queue.shift(); saveQueue(); return { ...t, source: "request" }; }
    if (!rotation.length) return null;
    const t = rotation[rotIdx % rotation.length];
    rotIdx += 1;
    return { ...t, who: "", source: "rotation" };
  }

  function play(track) {
    if (stopped) return;
    // restore this song's accumulated likers so the heart count resumes where it
    // left off (and the same author can't double-like across plays)
    current = { ...track, likes: likeSetFor(track) };
    // credit live (non-intro) artists for the outro thank-you
    if (track.source !== "intro" && track.artist) liveArtists.add(track.artist);
    const started = Date.now();
    log(`  ♪ now playing: ${track.title} — ${track.artist}${track.who ? ` (req ${track.who})` : ""}`);
    pushUpdate();
    // mpv: stream the url into our pulse sink, no video, no user config
    player = spawn("mpv", [
      "--no-video", "--no-config", "--really-quiet", "--cache=yes",
      "--ao=pulse", `--audio-device=pulse/${config.pulseSink}`, "--volume=100",
      track.audioUrl,
    ], { stdio: "ignore" });

    // skip segue: the prior track faded out, so fade THIS one up once it's
    // (likely) started buffering — a clean cross-through-silence transition
    if (fadeInPending) { fadeInPending = false; setTimeout(() => { if (!stopped) fade(100, 900); }, 550); }

    player.on("exit", async () => {
      player = null;
      if (stopped) return;
      const ranMs = Date.now() - started;
      const wasSkip = skipping; skipping = false;
      // failed fast → the CDN url may be stale; re-resolve the share once (but a
      // deliberate skip isn't a failure — just advance)
      if (!wasSkip && ranMs < 2500 && track.share) {
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
      log(`[dj] resolving ${INTRO.length} intro tracks…`);
      intro.push(...(await resolveAll(INTRO)));
      log(`[dj] intro ready: ${intro.length}/${INTRO.length} tracks (boot mode=${mode})`);
      // restore accumulated per-song heart counts (resume likes on replay)
      await loadSongLikes();
      if (songLikes.size) log(`[dj] restored heart counts for ${songLikes.size} song(s)`);
      // restore any persisted request queue (survives a streamer restart)
      const saved = await loadQueue();
      if (saved.length) { queue.push(...saved); log(`[dj] restored ${saved.length} queued request(s)`); }
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
      saveQueue();
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
      if (!had) { pushUpdate(); saveSongLikes(); } // persist so the count resumes on replay
      return { ok: true, likes: current.likes.size, fresh: !had };
    },

    // skip with a smooth segue: fade the current track out, then swap, then the
    // next track fades up (see fadeInPending in play). Plain SIGTERM would cut.
    skip() {
      if (!player) return;
      log("  ♪ skip (fade segue)");
      fade(0, 700);
      setTimeout(() => { skipping = true; fadeInPending = true; if (player) player.kill("SIGTERM"); }, 720);
    },
    // switch the playlist: "intro" (pre-show loop) ⇄ "live" (queue + rotation).
    // A real change segues through silence — fade the current track out, swap to
    // the new mode's first track, fade it up — the same clean transition skip()
    // uses (and the exit handler treats it as a skip, not a fast-fail).
    setMode(newMode) {
      const next = newMode === "intro" ? "intro" : "live";
      if (next === mode) return { ok: true, mode, changed: false };
      mode = next;
      if (mode === "intro") introIdx = 0;
      else liveArtists.clear(); // fresh credit list for this on-air session
      log(`[dj] mode → ${mode}`);
      if (player) {
        fade(0, 700);
        setTimeout(() => { skipping = true; fadeInPending = true; if (player) player.kill("SIGTERM"); }, 720);
      } else if (!stopped) {
        play(nextTrack() || { title: "", artist: "", audioUrl: "", who: "", source: "" });
      }
      pushUpdate();
      return { ok: true, mode, changed: true };
    },
    fade,                       // fade(targetPct, ms) — outro fade-out / onair fade-in
    artists: () => Array.from(liveArtists), // unique creators played since on air (outro credits)
    status,
    queueInfo,                  // { current, queue:[requests], rotation:[house] }
    stop() { stopped = true; if (fadeTimer) clearInterval(fadeTimer); if (songLikesTimer) clearTimeout(songLikesTimer); if (player) player.kill("SIGKILL"); },
  };
}
