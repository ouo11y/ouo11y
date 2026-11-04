#!/usr/bin/env bash
# The native capabilities of @ouo11y/react-native in the bare React Native 0.82 app on the iOS
# Simulator, against an ouo-env stack. The React Native iOS conformance suite (tests/e2e/mobile) is a
# model of the app in Node and runs no native code, so this drives the real Release build instead,
# with the golden app's journey mailbox (../ouo-mobile/src/journey.ts) and demo module (ouo-chaos):
#
#   journey    ../ouo-mobile/scripts/journey.sh: products, cart, feedback, checkouts, a 500, flush
#   crash      Cart, then SIGSEGV to the app's own pid (the signal handler of OuoCrash), next launch
#   hang       a 3 s main-thread block (OuoCrash's watchdog)
#   oom        a memory warning, then SIGKILL in the foreground (a termination), next launch
#
# OTLP goes through tests/e2e/mobile-native/proxy.mjs, which logs each request's content-encoding
# (gzip, done natively), then verify-ios.py asserts rum-api and Tempo.
#
#   scripts/verify-ios.sh --env <env> --device <udid> [--build]
#
# --build builds and installs the Release app first, pointed at the proxy (scripts/build-ios.sh).
# OUO_IOS_OUT keeps the proxy log and the phase windows; OUO_IOS_PROXY_PORT (default 18329).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
ENV_NAME="" DEVICE="" BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n $ENV_NAME && -n $DEVICE ]] || { echo "--env and --device are required" >&2; exit 2; }
eval "$("$root/deploy/envs/ouo-env" env "$ENV_NAME")"
PROXY_PORT=${OUO_IOS_PROXY_PORT:-18329}
OUT=${OUO_IOS_OUT:-$(mktemp -d)}
mkdir -p "$OUT"
export OUO_IOS_BUNDLE=dev.ouo.bare
BUNDLE=$OUO_IOS_BUNDLE
log() { printf '%s [bare verify-ios] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ $BUILD == 1 ]]; then
  EXPO_PUBLIC_OTLP_ENDPOINT="http://localhost:$PROXY_PORT" scripts/build-ios.sh --env "$ENV_NAME" --device "$DEVICE"
fi

: > "$OUT/requests.jsonl"
node "$root/tests/e2e/mobile-native/proxy.mjs" "$PROXY_PORT" "$OUO_OTLP_URL" "$OUT/requests.jsonl" &
PROXY=$!
trap 'kill $PROXY 2>/dev/null || true' EXIT
sleep 1

cmd() {
  log "command $1"
  local docs; docs="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"
  mkdir -p "$docs"
  printf '%s\n' "$1" > "$docs/.journey-command.tmp"
  mv "$docs/.journey-command.tmp" "$docs/journey-command"
  sleep "${2:-2}"
}
# `simctl launch` prints "<bundle>: <pid>": the only process this script signals is that pid.
launch() { xcrun simctl launch "$DEVICE" "$BUNDLE" | sed -n 's/.*: \([0-9]*\)$/\1/p'; }
background() { xcrun simctl launch "$DEVICE" com.apple.Preferences >/dev/null; sleep "${1:-5}"; xcrun simctl terminate "$DEVICE" com.apple.Preferences 2>/dev/null || true; }
quit() { background; xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true; sleep 1; }
phases="{"
mark() { phases+="\"$1\": [$2, $(( $(date +%s) + 1 ))],"; }

xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
t=$(( $(date +%s) - 1 ))
log "journey"
"$root/examples/ouo-mobile/scripts/journey.sh" --device "$DEVICE"
mark journey "$t"

t=$(( $(date +%s) - 1 ))
log "crash: SIGSEGV on Cart, then the next launch"
pid=$(launch); sleep 7
cmd "screen/Cart" 3
kill -SEGV "$pid"; sleep 3
launch >/dev/null; sleep 8; quit
mark crash "$t"

t=$(( $(date +%s) - 1 ))
log "hang: the main thread blocked for 3 s"
launch >/dev/null; sleep 7
cmd "screen/Cart" 2
cmd "action/hang?ms=3000" 7
cmd "action/flush" 4; quit
mark hang "$t"

t=$(( $(date +%s) - 1 ))
log "oom: a memory warning, then SIGKILL in the foreground, then the next launch"
launch >/dev/null; sleep 7
cmd "screen/Cart" 2
cmd "action/oom" 4
launch >/dev/null; sleep 8; quit
mark oom "$t"

printf '%s\n' "${phases%,}}" > "$OUT/phases.json"
backend="$("$root/deploy/envs/ouo-env" url "$ENV_NAME" | sed -n 's/.*backend \(http:\/\/localhost:[0-9]*\).*/\1/p')"
python3 -I scripts/verify-ios.py --phases "$OUT/phases.json" --requests "$OUT/requests.jsonl" --backend "$backend" --device "$DEVICE"
