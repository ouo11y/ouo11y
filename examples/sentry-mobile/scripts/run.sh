#!/usr/bin/env bash
# Run the sentry-mobile example's scripted journey on the iOS Simulator and verify it.
#
#   scripts/run.sh [--env <name>] [--device <udid>] [--build] [--full] [--no-verify]
#
# --build   build and install the app first (scripts/build-ios.sh, same --env / --device)
# --full    the full journey (background rotation and native crash, ~2.5 min) instead of the
#           short one (launch, navigation, network, shop, errors, ~1.5 min)
# Without --env the plain compose stack's ports are used (Tempo 3200, Loki 3100,
# backend 8081); the app must have been built for the same stack (.env or --env).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
ENV_NAME="" DEVICE="${SIM_UDID:-}" BUILD=0 FULL=0 VERIFY=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --build) BUILD=1 ;;
    --full) FULL=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [sentry-mobile] %s\n' "$(date +%H:%M:%S)" "$*"; }
if [[ -z $DEVICE ]]; then
  DEVICE="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')"
  [[ -n $DEVICE ]] || { echo "no booted simulator: boot one or pass --device" >&2; exit 1; }
fi
dev=(--device "$DEVICE")
env_args=()
[[ -n $ENV_NAME ]] && env_args=(--env "$ENV_NAME")

if [[ $BUILD == 1 ]]; then
  scripts/build-ios.sh ${env_args[@]+"${env_args[@]}"} "${dev[@]}"
fi

backend="${BACKEND_URL:-}"
if [[ -n $ENV_NAME ]]; then
  eval "$("$root/deploy/envs/ouo-env" env "$ENV_NAME")"
  backend="$("$root/deploy/envs/ouo-env" url "$ENV_NAME" | sed -n 's/.*backend \(http:\/\/localhost:[0-9]*\).*/\1/p')"
elif [[ -z $backend && -f .env ]]; then
  backend="$(sed -n 's/^BACKEND_URL=//p' .env)"
fi
backend="${backend:-http://localhost:8081}"

start=$(( $(date +%s) - 1 ))
if [[ $FULL == 1 ]]; then
  scripts/journey.sh "${dev[@]}" --shop-rounds 1
else
  scripts/journey.sh "${dev[@]}" --no-background --no-crash --shop-rounds 1 --replay-wait 8
fi
# The journey ends with SIGKILL; relaunch once so the SDK sends the last session's end and any
# envelopes it cached, then stop it.
xcrun simctl launch "$DEVICE" dev.ouo.sentrydemo >/dev/null; sleep 12
xcrun simctl terminate "$DEVICE" dev.ouo.sentrydemo 2>/dev/null || true
end=$(( $(date +%s) + 1 ))
# The errors phase's `feedback` action (bridge spec 9c): captureFeedback resolves like an event
# (envelope, replay, device or trace rule), the user report through the error it names.
feedback='[{"message": "The pay button does nothing", "contact": "qa@example.invalid", "rules": ["envelope", "replay", "device", "trace"]},
  {"message": "It failed when I paid", "contact": "qa@example.invalid", "id": null, "rules": ["event"]}]'
printf '{"start": %d, "end": %d, "backend": "%s", "device": "%s", "feedback": %s}\n' "$start" "$end" "$backend" "$DEVICE" "$feedback" > journey.json
log "journey window $start..$end, backend $backend"

if [[ $VERIFY == 1 ]]; then
  python3 -I scripts/verify.py --journey journey.json
fi
