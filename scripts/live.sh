#!/usr/bin/env bash
# Control the LIVE ingest — the loop that reads YouTube chat, moderates it, and
# tells the stream how to react (themes, votes, music, reactions, Super Chats).
#
#   scripts/live.sh start     # (re)start it — always single-instance
#   scripts/live.sh stop      # stop it
#   scripts/live.sh restart   # stop + start
#   scripts/live.sh status    # is it running? + stream health + now-playing
#   scripts/live.sh logs      # tail the ingest log
#   scripts/live.sh queue URL # operator: queue a Suno song directly (no chat)
#   scripts/live.sh skip      # operator: skip the current song
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
  printf '[music]  '; curl -s "$CONTROL/music/status" 2>/dev/null | grep -oE '"title":"[^"]*"|"queue":[0-9]+' | tr '\n' ' '; echo
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    tail -f "$LOG" ;;
  queue)
    [ -n "${2:-}" ] || { echo "usage: $0 queue <suno-share-url>"; exit 1; }
    curl -s -X POST "$CONTROL/music/enqueue" -H 'content-type: application/json' \
      -d "{\"link\":\"$2\",\"who\":\"${3:-@operator}\"}"; echo ;;
  skip)    curl -s -X POST "$CONTROL/music/skip"; echo ;;
  *) echo "usage: $0 {start|stop|restart|status|logs|queue <url>|skip}"; exit 1 ;;
esac
