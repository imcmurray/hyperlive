#!/usr/bin/env bash
# Drive the LIVE scene via the file-watch trigger (writes the bind-mounted
# control/directives.json the container is watching). Same payloads as mutate.sh.
#
#   scripts/mutate-file.sh '{"action":"setTheme","params":{"theme":"sunrise"}}'
set -euo pipefail
BODY="${1:?usage: mutate-file.sh '<json directive>'}"
mkdir -p control
printf '%s\n' "${BODY}" > control/directives.json
echo "wrote control/directives.json"
