#!/usr/bin/env bash
# Control the LIVE ingest — the loop that reads YouTube chat, moderates it, and
# tells the stream how to react (themes, votes, music, reactions, Super Chats).
#
#   scripts/live.sh start     # (re)start it — always single-instance
#   scripts/live.sh stop      # stop it
#   scripts/live.sh restart   # stop + start
#   scripts/live.sh status    # is it running? + stream health + now-playing
#   scripts/live.sh logs      # tail the ingest log
#   scripts/live.sh now       # what's playing (title/artist/cover/likes/queue)
#   scripts/live.sh queue     # list the waiting request queue
#   scripts/live.sh queue URL # operator: queue a Suno song directly (shows cover)
#   scripts/live.sh next      # operator: move onto the next song (alias: skip)
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
  nohup env \
    SOURCE=youtube \
    MUTATE_URL="$MUTATE_URL" \
    MOOD_TICK_MS="$MOOD_TICK_MS" \
    node "$ENTRY" > "$LOG" 2>&1 &
  disown
  sleep 4
  status
}

status() {
  local p; p=$(ingest_pids)
  if [ -n "$p" ]; then echo "[live] RUNNING (pid $p)"; else echo "[live] NOT running"; fi
  grep -iE 'source=|connected|resumed' "$LOG" 2>/dev/null | tail -2
  printf '[stream] '; curl -s "$CONTROL/health" 2>/dev/null | grep -oE '"ffmpegUp":[a-z]+|"ffmpegRestarts":[0-9]+|"renderMode":"[a-z]+"' | tr '\n' ' '; echo
  printf '[music]  '; now_playing
  echo "[queue]"; queue_list
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

# list the waiting request queue (read from the DJ's persisted queue file)
queue_list() {
  node -e '
    const fs = require("fs");
    let q = []; try { q = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
    if (!Array.isArray(q) || !q.length) { console.log("  (queue empty)"); process.exit(0); }
    q.forEach((t, i) => console.log("  " + (i + 1) + ". " + (t.title || "?") + " — " + (t.artist || "?")
      + (t.who ? "  (req " + t.who + ")" : "") + (t.image ? "  cover ✓" : "")));
  ' "$QUEUE_FILE" 2>/dev/null || echo "  (queue unavailable)"
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

case "${1:-status}" in
  start)     start ;;
  stop)      stop ;;
  restart)   stop; sleep 1; start ;;
  status)    status ;;
  logs)      tail -f "$LOG" ;;
  now)       printf '  '; now_playing ;;
  queue)     if [ -n "${2:-}" ]; then queue_song "$2" "${3:-@operator}"; else echo "[queue]"; queue_list; fi ;;
  next|skip) next_song ;;
  *) echo "usage: $0 {start|stop|restart|status|logs|now|queue [<url> [who]]|next}"; exit 1 ;;
esac
