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

# --- audio: virtual PulseAudio sink the auto-DJ AND/OR the browser play into,
# and ffmpeg captures. Needed for music (DJ) and source (a video stage source's
# own audio) modes. Exported XDG_RUNTIME_DIR is inherited by the node
# orchestrator (and the ffmpeg/mpv/Chromium children it spawns) so they find
# pulse; setting the sink as DEFAULT is what routes Chromium's audio into it.
if [ "${AUDIO_MODE:-silent}" = "music" ] || [ "${AUDIO_MODE:-silent}" = "source" ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/pulse-runtime}"
  # clear any stale pulse daemon/socket from a previous run so a `docker compose
  # restart` (which reuses the container + /tmp) brings the sink up cleanly
  pulseaudio --kill 2>/dev/null || true
  sleep 0.5
  rm -rf "${XDG_RUNTIME_DIR}/pulse" 2>/dev/null || true
  mkdir -p "${XDG_RUNTIME_DIR}" && chmod 700 "${XDG_RUNTIME_DIR}"
  SINK="${PULSE_SINK:-hyperlive}"
  echo "[start] launching PulseAudio + null sink '${SINK}'"
  pulseaudio -D --exit-idle-time=-1 --disable-shm=true -n \
    --load="module-null-sink sink_name=${SINK} sink_properties=device.description=${SINK}" \
    --load="module-native-protocol-unix" || echo "[start] WARN: pulseaudio returned nonzero"
  for i in $(seq 1 30); do
    if pactl list short sinks 2>/dev/null | grep -q "${SINK}"; then echo "[start] sink '${SINK}' ready"; break; fi
    sleep 0.2
  done
  # make the null sink the DEFAULT output so Chromium (and anything else that
  # doesn't target a sink explicitly) plays INTO it — this is what lets a video
  # stage source's audio be captured. mpv still targets the sink by name.
  pactl set-default-sink "${SINK}" 2>/dev/null && echo "[start] default sink → ${SINK}" || true
fi

export DISPLAY="${DISPLAY_NUM}"
exec node src/index.js
