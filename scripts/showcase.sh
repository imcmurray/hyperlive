#!/usr/bin/env bash
# showcase.sh — randomized tour of every visual element of the live scene.
# Picks a random directive (theme crossfade, effect fade, shoutout, headline,
# subhead, burst) each step, with random params + timing, until you quit.
#
#   scripts/showcase.sh                       # random, loops forever (gaps 1–10s)
#   MIN_DELAY=1 MAX_DELAY=5 scripts/showcase.sh   # tighter random gaps
#   CONTROL_PORT=8099 scripts/showcase.sh     # point at a DRY_RUN dev container
#
# Quit with Ctrl-C.
set -uo pipefail

PORT="${CONTROL_PORT:-8080}"
URL="http://localhost:${PORT}/mutate"
# gap between steps is random in [MIN_DELAY, MAX_DELAY] seconds
MIN_DELAY="${MIN_DELAY:-1}"
MAX_DELAY="${MAX_DELAY:-10}"

THEMES=(synthwave sunrise mono forest aurora ember midnight vapor matrix gold crimson
        neon dusk ocean lava frost glitch retro void plasma noir solar holo)
EFFECTS=(particles rays scanlines grain vignette bokeh bars fog sweep
         grid chroma holoscan dust datarain sparks lightning filmburn ripple)
TIERS=(small medium large)
TICKS=("live and reactive" "powered by chat" "drop a comment" "themes change on request"
       "premium visuals" "welcome in" "more effects soon" "vibe check passed" "stay a while")
DURS=(0.8 1.2 1.6 2.0 2.4)
INTEN=(0.4 0.6 0.8 1.0)
WHO=(@nova @pixel @echo_ @riff @lumen @vortex @async @gizmo @flux @halo)
MSG=("love the vibe" "this is sick" "more of this" "incredible visuals"
     "turn it up" "so smooth" "10/10 stream" "vibing hard" "best channel" "do it again")
HEADLINES=("Chat is in control" "Driven by the crowd" "Live and reactive"
           "Anything can happen" "Powered by comments" "Welcome to the stream")
SUBS=("themes, effects, and motion on autopilot" "every element, shuffled"
      "a different look every minute" "premium but lightweight")
KICKERS=("hyperframes live" "live from the lab" "now streaming" "on air" "powered by chat" "welcome in")
GRAD_SPEEDS=(4 6 8 10 12)

count=0
# track which effects are currently on so we can turn them back off (seed the
# defaults that start enabled in the scene, so those can drop out too)
declare -A ON=( [vignette]=1 [scanlines]=1 [grain]=1 )
trap 'echo; echo "[showcase] stopped after ${count} directives. bye 👋"; exit 0' INT TERM

# pick one random element from the args:  pick "${ARR[@]}"
pick() { echo "${@:RANDOM % $# + 1:1}"; }

# fire one directive: m <label> <json>
m() {
  count=$((count + 1))
  printf '  ▸ %-22s %s\n' "$1" "$2"
  curl -fsS -X POST "$URL" -H 'content-type: application/json' -d "$2" >/dev/null \
    || echo "    (! mutate failed — is the streamer up on :${PORT}?)"
}

# pre-flight
if ! curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "[showcase] cannot reach streamer on :${PORT}. Start it with 'docker compose up -d' first."
  exit 1
fi
echo "[showcase] randomized visual tour → ${URL}  (Ctrl-C to quit)"

span=$(( MAX_DELAY - MIN_DELAY + 1 ))
while true; do
  r=$((RANDOM % 100))

  if   [ "$r" -lt 30 ]; then                       # 30% — theme crossfade
    th=$(pick "${THEMES[@]}"); du=$(pick "${DURS[@]}")
    m "theme: ${th}" "{\"action\":\"transitionTheme\",\"params\":{\"theme\":\"${th}\",\"duration\":${du}}}"

  elif [ "$r" -lt 55 ]; then                       # 25% — effect fade on/off
    du=$(pick "${DURS[@]}")
    on_count=${#ON[@]}
    # the more effects are on, the more likely we turn one OFF (keeps it from
    # piling up); always leave room for new ones to come back on later
    if (( on_count > 0 )) && { (( on_count >= 5 )) || (( RANDOM % 2 == 0 )); }; then
      active=("${!ON[@]}"); fx=$(pick "${active[@]}")
      unset 'ON[$fx]'
      m "effect ${fx}=off" "{\"action\":\"setEffect\",\"params\":{\"effect\":\"${fx}\",\"on\":false,\"duration\":${du}}}"
    else
      fx=$(pick "${EFFECTS[@]}"); ON[$fx]=1
      m "effect ${fx}=on" "{\"action\":\"setEffect\",\"params\":{\"effect\":\"${fx}\",\"on\":true,\"duration\":${du}}}"
    fi

  elif [ "$r" -lt 70 ]; then                       # 15% — shoutout
    t=$(pick "${TIERS[@]}"); w=$(pick "${WHO[@]}"); g=$(pick "${MSG[@]}")
    m "shoutout: ${t}" "{\"action\":\"addShoutout\",\"params\":{\"who\":\"${w}\",\"text\":\"${g}\",\"tier\":\"${t}\"}}"

  elif [ "$r" -lt 78 ]; then                       # 8% — headline
    h=$(pick "${HEADLINES[@]}")
    m "headline" "{\"action\":\"setHeadline\",\"params\":{\"text\":\"${h}\"}}"

  elif [ "$r" -lt 84 ]; then                       # 6% — subhead
    s=$(pick "${SUBS[@]}")
    m "subhead" "{\"action\":\"setSubhead\",\"params\":{\"text\":\"${s}\"}}"

  elif [ "$r" -lt 88 ]; then                       # 4% — kicker
    k=$(pick "${KICKERS[@]}")
    m "kicker" "{\"action\":\"setKicker\",\"params\":{\"text\":\"${k}\"}}"

  elif [ "$r" -lt 92 ]; then                       # 4% — rewrite the ticker
    a=$(pick "${TICKS[@]}"); b=$(pick "${TICKS[@]}"); c=$(pick "${TICKS[@]}")
    m "ticker" "{\"action\":\"setTicker\",\"params\":{\"items\":[\"${a}\",\"${b}\",\"${c}\"]}}"

  elif [ "$r" -lt 97 ]; then                       # 5% — toggle the headline gradient pan
    if [ $((RANDOM % 10)) -lt 7 ]; then
      sp=$(pick "${GRAD_SPEEDS[@]}")
      m "gradient pan on" "{\"action\":\"setHeadlineGradient\",\"params\":{\"animate\":true,\"speed\":${sp}}}"
    else
      m "gradient pan off" "{\"action\":\"setHeadlineGradient\",\"params\":{\"animate\":false}}"
    fi

  else                                             # 3% — burst
    i=$(pick "${INTEN[@]}")
    m "burst" "{\"action\":\"burst\",\"params\":{\"intensity\":${i}}}"
  fi

  # random gap in [MIN_DELAY, MAX_DELAY] seconds
  sleep "$(( MIN_DELAY + RANDOM % span ))"
done
