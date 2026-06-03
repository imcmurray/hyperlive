#!/usr/bin/env bash
# Entrypoint: bring up Xvfb on the configured display, wait for it, then run
# the Node orchestrator (which launches Chromium + ffmpeg).
set -euo pipefail

DISPLAY_NUM="${DISPLAY:-:99}"
W="${VIDEO_WIDTH:-1280}"
H="${VIDEO_HEIGHT:-720}"

# clean any stale lock from a previous run
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" 2>/dev/null || true

echo "[start] launching Xvfb on ${DISPLAY_NUM} at ${W}x${H}x24"
Xvfb "${DISPLAY_NUM}" -screen 0 "${W}x${H}x24" -nolisten tcp -ac &
XVFB_PID=$!

# wait for the display to be ready
for i in $(seq 1 50); do
  if xdpyinfo -display "${DISPLAY_NUM}" >/dev/null 2>&1; then
    echo "[start] Xvfb ready after ${i} checks"
    break
  fi
  sleep 0.2
done

# ensure Xvfb is reaped if node exits
trap 'kill ${XVFB_PID} 2>/dev/null || true' EXIT

export DISPLAY="${DISPLAY_NUM}"
exec node src/index.js
