#!/usr/bin/env bash
# Drive one rollout cohort end to end on the simulator (ROLLOUT.md).
#
#   scripts/rollout-journey.sh --mode sentry|parallel|ouo --flags-file <flagd json> [--device <udid>]
#                              [--fresh] [--replay-wait 15]
#
# 1. Pins `ouo.rum.mode` to --mode in the flagd file (flagd reloads it on write).
# 2. Launch A: the app applies the mode stored by the previous launch and fetches the flag;
#    the new value is stored for the next launch. Terminate.
#    --fresh uninstalls nothing but deletes the stored decision first, so launch A is a first
#    launch: it waits for the flag and applies it at once (launch B then repeats the mode).
# 3. Launch B: the app runs --mode. A short journey: two screens, fetch OK / 500, XHR cart,
#    handled error, message, unhandled promise rejection, then a replay wait and a flush.
# 4. Prints the stored decision (Documents/ouo-rum-mode.json) after each launch and exits non-zero
#    when launch B did not run --mode.
set -euo pipefail

DEVICE="${SIM_UDID:-D64DE653-47C7-4349-91E3-D6E64D9EF009}"
BUNDLE=dev.ouo.sentrydemo
MODE=""
FLAGS=""
FRESH=0
REPLAY_WAIT=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift ;;
    --flags-file) FLAGS="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --fresh) FRESH=1 ;;
    --replay-wait) REPLAY_WAIT="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $MODE =~ ^(sentry|parallel|ouo)$ ]] || { echo "--mode sentry|parallel|ouo" >&2; exit 2; }
[[ -f $FLAGS ]] || { echo "--flags-file <flagd json> is required" >&2; exit 2; }

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
log() { printf '%s [rollout] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
wait_s() { log "  wait ${1}s${2:+ ($2)}"; sleep "$1"; }
docs() { echo "$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"; }
link() {
  log "command $1"
  local d; d="$(docs)"; mkdir -p "$d"
  printf '%s\n' "$1" > "$d/.journey-command.tmp"
  mv "$d/.journey-command.tmp" "$d/journey-command"
}
launch() { log "launch $BUNDLE"; xcrun simctl launch "$DEVICE" "$BUNDLE" >/dev/null; }
terminate() { log "terminate $BUNDLE"; xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true; }
decision() { cat "$(docs)/ouo-rum-mode.json" 2>/dev/null || echo "(none)"; echo; }

log "== pin $MODE in $FLAGS"
python3 -I - "$FLAGS" "$MODE" <<'EOF'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
d = json.load(open(path))
f = d["flags"]["ouo.rum.mode"]
f["defaultVariant"] = mode
f.pop("targeting", None)
open(path, "w").write(json.dumps(d, indent=2) + "\n")
EOF
sleep 2

terminate
rm -f "$(docs)/journey-command"
[[ $FRESH == 1 ]] && { log "delete the stored decision (first launch)"; rm -f "$(docs)/ouo-rum-mode.json"; }
log "stored before launch A: $(decision)"
log "== launch A (applies the stored mode, fetches $MODE for the next launch)"
launch
wait_s 6 "flag evaluation"
terminate
log "stored after launch A: $(decision)"
wait_s 2

log "== launch B (runs $MODE)"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
launch
wait_s 8 "app start, session start"
link "screen/product?id=p-1001"; wait_s 3
link "screen/cart"; wait_s 3
link "screen/home"; wait_s 2
link "action/fetch-ok"; wait_s 2
link "action/fetch-500"; wait_s 2
link "action/xhr-cart"; wait_s 2
link "action/handled-error"; wait_s 2
link "action/message"; wait_s 2
link "action/unhandled-rejection"; wait_s 2
wait_s "$REPLAY_WAIT" "replay segments"
link "action/flush"; wait_s 5
terminate
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "stored after launch B: $(decision)"
log "window $START .. $END"
echo "{\"mode\":\"$MODE\",\"start\":\"$START\",\"end\":\"$END\"}"
