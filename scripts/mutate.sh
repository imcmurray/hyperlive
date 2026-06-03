#!/usr/bin/env bash
# Drive the LIVE scene over HTTP while it is streaming.
#
#   scripts/mutate.sh '{"action":"transitionTheme","params":{"theme":"aurora","duration":1.4}}'
#   scripts/mutate.sh '{"action":"setTheme","params":{"theme":"forest"}}'   # crossfades
#   scripts/mutate.sh '{"action":"setEffect","params":{"effect":"particles","on":true}}'
#   scripts/mutate.sh '{"action":"setHeadline","params":{"text":"viewers are driving this"}}'
#   scripts/mutate.sh '{"action":"addShoutout","params":{"who":"ian","text":"hello from chat","tier":"large"}}'
#   scripts/mutate.sh '{"action":"burst","params":{"intensity":0.8}}'
# Themes: synthwave | sunrise | mono | forest | aurora | ember
# Effects: particles | rays | scanlines | grain | vignette
set -euo pipefail
PORT="${CONTROL_PORT:-8080}"
BODY="${1:?usage: mutate.sh '<json directive>'}"
curl -fsS -X POST "http://localhost:${PORT}/mutate" \
  -H 'content-type: application/json' \
  -d "${BODY}"
echo
