#!/usr/bin/env bash
# Control the LIVE ingest — the loop that reads YouTube chat, moderates it, and
# tells the stream how to react (themes, votes, music, reactions, Super Chats).
#
#   scripts/live.sh boot      # turn it ALL on: streamer container + chat ingest
#   scripts/live.sh down      # turn it ALL off: ingest + container
#   scripts/live.sh up        # start just the streamer container
#   scripts/live.sh build     # rebuild + start the container (after code changes)
#   scripts/live.sh start     # (re)start just the chat ingest — single-instance
#   scripts/live.sh stop      # stop just the chat ingest
#   scripts/live.sh restart   # stop + start the ingest
#   scripts/live.sh status    # is it running? + stream health + now-playing
#   scripts/live.sh logs      # tail the ingest log
#   scripts/live.sh now       # what's playing (title/artist/cover/likes/queue)
#   scripts/live.sh queue     # list the waiting request queue
#   scripts/live.sh queue URL # operator: queue a Suno song directly (shows cover)
#   scripts/live.sh next      # operator: move onto the next song (alias: skip)
#   scripts/live.sh intro     # "starting shortly" screen + intro-music loop
#   scripts/live.sh onair [N] # N-sec on-screen countdown (default 10) → live queue
#   scripts/live.sh tech      # "technical difficulties" screen (music keeps playing)
#   scripts/live.sh brb       # "we'll be right back" break screen
#   scripts/live.sh resume    # back to the live show from tech/brb/outro (no countdown)
#   scripts/live.sh outro     # sign-off: artist credits + repo/Suno links, fade out
#   scripts/live.sh json '<json>'  # JSON in/out for other systems (see scripts/live-api.mjs)
#
# It runs SOURCE=youtube; OAuth creds + tunables come from .env (see
# docs/youtube-oauth.md). Override any of these via the environment:
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

LOG="${LIVE_LOG:-/tmp/hyperlive-ingest.log}"
MUTATE_URL="${MUTATE_URL:-http://localhost:8080/mutate}"
CONTROL="${CONTROL_BASE:-http://localhost:8080}"
MOOD_TICK_MS="${MOOD_TICK_MS:-6000}"
ENTRY="packages/ingest/src/index.js"
QUEUE_FILE="${MUSIC_QUEUE_FILE_HOST:-control/music-queue.json}" # DJ persists the waiting queue here
USAGE_FILE="${YT_USAGE_FILE_HOST:-state/yt-usage.json}"          # ingest writes today's API usage here
QUOTA_LIMIT="${YT_QUOTA_LIMIT:-9000}"                            # stop polling at this many units (10k/day cap)

# PIDs of the actual node ingest. pgrep -f also matches this script, the wrapper,
# greps, and pgrep itself if their cmdline mentions the entry — so require the
# process to BE a node process (comm starts "node"; Node's is "node-MainThread")
# AND have the entry in its cmdline.
ingest_pids() {
  local p cmd comm
  for p in $(pgrep -f "$ENTRY" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    comm=$(cat "/proc/$p/comm" 2>/dev/null) || continue
    case "$comm" in node*) ;; *) continue ;; esac
    cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) || continue
    case "$cmd" in *"$ENTRY"*) echo "$p" ;; esac
  done
}

stop() {
  local p; p=$(ingest_pids)
  if [ -z "$p" ]; then echo "[live] not running"; return 0; fi
  echo "[live] stopping pid(s): $p"
  # shellcheck disable=SC2086
  kill $p 2>/dev/null || true
  sleep 1
  p=$(ingest_pids); [ -n "$p" ] && { echo "[live] force kill: $p"; kill -9 $p 2>/dev/null || true; }
  return 0
}

start() {
  stop >/dev/null            # guarantee single instance
  echo "[live] starting YouTube-chat ingest → $MUTATE_URL  (log: $LOG)"
  echo "[live] mod dashboard → http://127.0.0.1:${ADMIN_PORT:-8090}/  (loopback; tunnel in for remote mods)"
  nohup env \
    SOURCE=youtube \
    MUTATE_URL="$MUTATE_URL" \
    MOOD_TICK_MS="$MOOD_TICK_MS" \
    YT_QUOTA_LIMIT="$QUOTA_LIMIT" \
    node "$ENTRY" >> "$LOG" 2>&1 &   # append — don't wipe the evidence of a prior crash
  disown
  sleep 4
  status
}

# --- streamer container (Xvfb + Chromium + ffmpeg + DJ) ---
wait_healthy() {
  printf "[live] waiting for the streamer"
  for _ in $(seq 1 45); do
    if curl -s "$CONTROL/health" 2>/dev/null | grep -q '"ffmpegUp":true'; then echo " — up"; return 0; fi
    printf "."; sleep 1
  done
  echo " — not healthy yet (try: $0 status)"; return 1
}
up()    { echo "[live] starting streamer container…";    docker compose up -d 2>&1 | tail -2;          wait_healthy; }
build() { echo "[live] rebuilding streamer container…";  docker compose up -d --build 2>&1 | tail -2;  wait_healthy; }
boot()  { up && start; }                                 # container + chat ingest in one go
down_all() {                                             # stop everything for the day
  stop
  echo "[live] stopping streamer container…"
  docker compose down 2>&1 | tail -2
}

status() {
  local p; p=$(ingest_pids)
  if [ -n "$(docker compose ps -q 2>/dev/null)" ]; then echo "[container] up"; else echo "[container] DOWN  (run: $0 up)"; fi
  if [ -n "$p" ]; then echo "[ingest] RUNNING (pid $p)"; else echo "[ingest] not running  (run: $0 start)"; fi
  grep -iE 'source=|connected|resumed' "$LOG" 2>/dev/null | tail -2
  printf '[stream] '; curl -s "$CONTROL/health" 2>/dev/null | grep -oE '"ffmpegUp":[a-z]+|"ffmpegRestarts":[0-9]+|"renderMode":"[a-z]+"' | tr '\n' ' '; echo
  printf '[show]   '; show_state
  printf '[music]  '; now_playing
  printf '[quota]  '; quota_usage
  echo "[queue]"; queue_list
}

# current show phase (intro / countdown / onair / outro) from the streamer
show_state() {
  local s; s=$(curl -s "$CONTROL/health" 2>/dev/null | grep -oE '"showState":"[a-z]+"' | sed 's/.*:"//;s/"//')
  case "$s" in
    intro)     echo "⏸  INTRO — pre-show landing screen + intro music" ;;
    countdown) echo "⏳  GOING LIVE — on-air countdown running" ;;
    onair)     echo "🔴 ON AIR — live show" ;;
    technical) echo "⚠  TECHNICAL DIFFICULTIES screen up" ;;
    break)     echo "☕ BREAK — \"we'll be right back\" screen up" ;;
    outro)     echo "⏹  OUTRO — sign-off screen (music fading out)" ;;
    "")        echo "(unknown — streamer down, or rebuild needed for showState)" ;;
    *)         echo "$s" ;;
  esac
}

# pretty-print whatever's playing (title/artist/requester/likes/queue/cover)
now_playing() {
  local j title artist who likes queue cover
  j=$(curl -s "$CONTROL/music/status" 2>/dev/null)
  title=$(echo "$j" | grep -oE '"title":"[^"]*"' | sed 's/"title":"//;s/"$//')
  [ -z "$title" ] && { echo "(nothing playing)"; return; }
  artist=$(echo "$j" | grep -oE '"artist":"[^"]*"' | sed 's/"artist":"//;s/"$//')
  who=$(echo "$j" | grep -oE '"who":"[^"]*"' | sed 's/"who":"//;s/"$//')
  likes=$(echo "$j" | grep -oE '"likes":[0-9]+' | grep -oE '[0-9]+')
  queue=$(echo "$j" | grep -oE '"queue":[0-9]+' | grep -oE '[0-9]+')
  echo "$j" | grep -q '"image":"https' && cover="cover ✓" || cover="no cover"
  echo "♪ $title — $artist   ${who:+(req $who) }♥ ${likes:-0}  ▶ ${queue:-0} queued  $cover"
}

# today's YouTube API usage vs the daily cap + our cutoff (read from the ingest)
quota_usage() {
  node -e '
    const fs = require("fs");
    let u = {}; try { u = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
    const limit = parseInt(process.argv[2] || "9000", 10);
    if (typeof u.units !== "number") { console.log("(no usage yet)"); process.exit(0); }
    const bar = Math.round((u.units / 10000) * 20);
    const flag = u.units >= limit ? "  ⛔ CUTOFF REACHED" : (u.units >= limit * 0.8 ? "  ⚠ near cutoff" : "");
    console.log("~" + u.units + " / 10000 units  (" + u.calls + " calls)  cutoff " + limit
      + "  [" + "#".repeat(bar) + "-".repeat(20 - bar) + "]  " + u.date + flag);
  ' "$USAGE_FILE" "$QUOTA_LIMIT"
}

# list up-next: requested songs + the house rotation (from the running DJ);
# falls back to the persisted request file when the streamer is down.
queue_list() {
  local j; j=$(curl -s "$CONTROL/music/queue" 2>/dev/null)
  if echo "$j" | grep -q '"rotation"'; then
    echo "$j" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => { try {
        const q = JSON.parse(s), reqs = q.queue || [], rot = q.rotation || [];
        if (reqs.length) reqs.forEach((t, i) => console.log("  " + (i + 1) + ". " + t.title + " — " + t.artist + (t.who ? "  (req " + t.who + ")" : "") + (t.image ? "  cover ✓" : "")));
        else console.log("  (no requests — playing the house rotation)");
        if (rot.length) { console.log("  house rotation (" + rot.length + "):"); rot.forEach((t, i) => console.log("    " + (i === 0 ? "→ " : "  ") + t.title + " — " + t.artist)); }
      } catch (e) { console.log("  (queue unavailable)"); } });
    '
  else
    node -e '
      const fs = require("fs"); let q = []; try { q = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
      if (!Array.isArray(q) || !q.length) { console.log("  (no queued requests — streamer down)"); process.exit(0); }
      q.forEach((t, i) => console.log("  " + (i + 1) + ". " + (t.title || "?") + " — " + (t.artist || "?") + (t.who ? "  (req " + t.who + ")" : "")));
    ' "$QUEUE_FILE" 2>/dev/null || echo "  (queue unavailable)"
  fi
}

# operator: queue a Suno song directly. Resolve host-side first so we can show
# the title/artist/cover (the streamer also resolves it on enqueue — that's what
# grabs the cover the scene shows).
queue_song() {
  local url="${1:-}" who="${2:-@operator}" info resp pos
  [ -n "$url" ] || { echo "usage: $0 queue <suno-share-url> [who]"; return 1; }
  info=$(node --input-type=module -e '
    import { resolveSuno } from "./packages/streamer/src/music/resolve.js";
    const r = await resolveSuno(process.argv[1]);
    process.stdout.write(r.ok ? `OK\t${r.title}\t${r.artist}\t${r.image ? "cover ✓" : "no cover"}` : `ERR\t${r.error}`);
  ' "$url" 2>/dev/null)
  case "$info" in
    OK*) IFS=$'\t' read -r _ t a c <<<"$info"; echo "  ♪ $t — $a   ($c)" ;;
    *)   echo "  ✗ could not resolve: $url"; return 1 ;;
  esac
  resp=$(curl -s -X POST "$CONTROL/music/enqueue" -H 'content-type: application/json' -d "{\"link\":\"$url\",\"who\":\"$who\"}")
  case "$resp" in
    *'"ok":true'*) pos=$(echo "$resp" | grep -oE '"position":[0-9]+' | grep -oE '[0-9]+'); echo "  ✓ queued at #${pos:-?} (req $who)" ;;
    *) echo "  ✗ enqueue rejected: $resp" ;;
  esac
}

# operator: move onto the next song
next_song() {
  curl -s -X POST "$CONTROL/music/skip" >/dev/null
  echo "[live] ⏭  skipped — next up:"
  sleep 3
  printf '  '; now_playing
}

# sign-off: outro screen — credits every Suno artist played since on air + the
# repo/Suno links, and fades the music out (all handled by the /outro endpoint).
outro_show() {
  local resp; resp=$(curl -s -X POST "$CONTROL/outro" -H 'content-type: application/json' -d '{}')
  case "$resp" in
    *'"ok":true'*) echo "[live] outro up — crediting artists + links, music fading out…" ;;
    *) echo "[live] outro failed (is the streamer up?): ${resp:-no response}"; return 1 ;;
  esac
}

# technical-difficulties screen (music keeps playing underneath it)
tech_show() {
  curl -s -X POST "$MUTATE_URL" -H 'content-type: application/json' \
    -d '{"action":"setStandby","params":{"mode":"technical"}}' >/dev/null \
    || { echo "[live] failed (is the streamer up?)"; return 1; }
  echo "[live] ⚠ technical-difficulties screen up"
}

# "we'll be right back" break screen (music keeps playing underneath it)
brb_show() {
  curl -s -X POST "$MUTATE_URL" -H 'content-type: application/json' \
    -d '{"action":"setStandby","params":{"mode":"break"}}' >/dev/null \
    || { echo "[live] failed (is the streamer up?)"; return 1; }
  echo "[live] break screen up — back shortly"
}

# pre-show: "starting shortly" landing screen + the intro-music loop (the DJ
# loops the INTRO tracks until `onair`). Music is brought up in case a prior
# outro had faded it down.
intro_show() {
  curl -s -X POST "$MUTATE_URL" -H 'content-type: application/json' \
    -d '{"action":"setStandby","params":{"mode":"intro"}}' >/dev/null \
    || { echo "[live] failed (is the streamer up?)"; return 1; }
  curl -s -X POST "$CONTROL/music/mode" -H 'content-type: application/json' -d '{"mode":"intro"}' >/dev/null
  curl -s -X POST "$CONTROL/music/fade" -H 'content-type: application/json' -d '{"to":100,"ms":1800}' >/dev/null
  echo "[live] intro screen up + intro music looping"
}

# go ON AIR: a ${1:-10}s on-screen countdown, then reveal the show and switch the
# DJ from intro music to the live request queue / rotation. The streamer owns the
# timing so the countdown and the music handoff stay in lock-step.
onair_show() {
  local secs="${1:-10}" resp
  resp=$(curl -s -X POST "$CONTROL/onair" -H 'content-type: application/json' -d "{\"seconds\":$secs}")
  case "$resp" in
    *'"ok":true'*) echo "[live] going on air — ${secs}s countdown, then the live queue" ;;
    *) echo "[live] onair failed (is the streamer up?): ${resp:-no response}"; return 1 ;;
  esac
}

# resume the live show from a tech / brb / outro overlay — an INSTANT reveal with
# NO countdown and NO music restart (the show was already live underneath). Unlike
# `onair` (which starts the show from intro), this just clears the overlay. Brings
# the music back up in case an outro had faded it down.
resume_show() {
  curl -s -X POST "$MUTATE_URL" -H 'content-type: application/json' \
    -d '{"action":"setStandby","params":{"mode":"off"}}' >/dev/null \
    || { echo "[live] failed (is the streamer up?)"; return 1; }
  curl -s -X POST "$CONTROL/music/fade" -H 'content-type: application/json' -d '{"to":100,"ms":1200}' >/dev/null
  echo "[live] ▶ resumed — back to the live show (no countdown)"
}

case "${1:-status}" in
  up)        up ;;                 # start the streamer container
  build)     build ;;             # rebuild + start the container (after code changes)
  down)      down_all ;;          # stop the ingest AND the container (full off)
  boot)      boot ;;              # container + chat ingest (full on)
  start)     start ;;             # start just the chat ingest
  stop)      stop ;;              # stop just the chat ingest
  restart)   stop; sleep 1; start ;;
  status)    status ;;
  logs)      tail -f "$LOG" ;;
  now)       printf '  '; now_playing ;;
  queue)     if [ -n "${2:-}" ]; then queue_song "$2" "${3:-@operator}"; else echo "[queue]"; queue_list; fi ;;
  next|skip) next_song ;;
  intro)     intro_show ;;        # "starting shortly" screen + intro-music loop
  outro)     outro_show ;;        # sign-off: artist credits + repo/Suno links + fade
  tech|technical|glitch) tech_show ;;  # "technical difficulties" screen
  brb|break) brb_show ;;          # "we'll be right back" break screen
  onair|live) onair_show "${2:-10}" ;;  # countdown → reveal show + live queue (from intro)
  resume)    resume_show ;;       # instant reveal — back from tech/brb/outro (no countdown)
  json)      shift; node scripts/live-api.mjs "${1:-status}" ;; # JSON in/out for other systems
  *) echo "usage: $0 {boot|down|up|build | start|stop|restart|status|logs | now|queue [<url>]|next | intro|onair [secs]|resume|tech|brb|outro | json '<json>'}"; exit 1 ;;
esac
