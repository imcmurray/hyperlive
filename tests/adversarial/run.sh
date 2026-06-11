#!/usr/bin/env bash
# Run the adversarial scene probe against a real, headless scene.
#
# Brings up just the streamer container (CPU render, output to /dev/null — no
# YouTube, no GPU, no keys), waits for the scene to report ready, fires the
# injection corpus at it, and tears the container down. Exit code is the
# probe's: 0 = the safe-template invariant held for every payload.
#
# Used by CI (.github/workflows/ci.yml) and runnable locally:
#   npm run test:adversarial
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT=hl-adv
IMAGE=${IMAGE:-hl-adv-streamer}
cleanup() { docker rm -f "${PROJECT}-streamer" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "[adversarial] building + starting the scene (CPU, no output)…"
docker build -t "$IMAGE" packages/streamer >/dev/null
docker run -d --name "${PROJECT}-streamer" --network=host --shm-size=1gb \
  -e DRY_RUN=false -e OUTPUT_FILE=/dev/null -e CAPTURE=screencast \
  -e HW_ENCODE=false -e AUDIO_MODE=silent \
  "$IMAGE" >/dev/null

echo "[adversarial] waiting for the scene to report ready…"
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8080/health | grep -q '"sceneReady":true'; then break; fi
  sleep 2
  [ "$i" = 40 ] && { echo "scene never became ready"; docker logs "${PROJECT}-streamer" | tail -20; exit 1; }
done

echo "[adversarial] firing the injection corpus…"
docker run --rm --network=host \
  -v "$PWD/tests/adversarial/scene-probe.mjs:/app/scene-probe.mjs" \
  --entrypoint node "$IMAGE" /app/scene-probe.mjs
