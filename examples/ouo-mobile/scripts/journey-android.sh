#!/usr/bin/env bash
# Unattended shopper journey for mobile-store on an Android emulator: the Android twin of
# scripts/journey.sh. Commands go in as broadcasts (src/journey.ts: only the conformance build,
# `scripts/build-android.sh --conformance`, and debug builds listen); typing is real input
# (`adb shell input`) into the checkout's promo field, so the replay's input masking is exercised.
#
#   scripts/journey-android.sh [--serial <adb serial>] [--no-relaunch]
#
# Launch -> product p-1001, add -> Products -> p-1002, add -> Cart -> Checkout, type a promo code ->
# Chaos, a 500 -> Products -> flush -> background (HOME) for 8 s (the conformance build ends a session
# after 5 s there) -> force-stop -> launch again (the next run ends what the last one left open) ->
# flush -> background.
set -euo pipefail
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
SERIAL="${ANDROID_SERIAL:-}" RELAUNCH=1
APP=dev.ouo.mobilestore
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) SERIAL="$2"; shift ;;
    --no-relaunch) RELAUNCH=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
ADB=("$ANDROID_HOME/platform-tools/adb")
[[ -n $SERIAL ]] && ADB+=(-s "$SERIAL")
log() { printf '%s [journey-android] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cmd() {
  log "command $1"
  "${ADB[@]}" shell "am broadcast -a dev.ouo.mobilestore.JOURNEY -p $APP --es cmd '$1'" >/dev/null
  sleep "${2:-2}"
}
launch() {
  log "launch $APP"
  "${ADB[@]}" shell am start -W -n "$APP/.MainActivity" >/dev/null
  sleep 8
}
# Taps the centre of the view whose resource-id (React Native testID) is $1, from a uiautomator dump.
tap_id() {
  local xml bounds
  xml="$("${ADB[@]}" exec-out uiautomator dump /dev/tty 2>/dev/null || true)"
  bounds="$(grep -o "resource-id=\"$1\"[^>]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]\"" <<<"$xml" | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -1 || true)"
  [[ -n $bounds ]] || { log "no view $1 on screen"; return 1; }
  read -r x1 y1 x2 y2 <<<"$(tr -c '0-9' ' ' <<<"$bounds")"
  log "tap $1 at $(((x1 + x2) / 2)),$(((y1 + y2) / 2))"
  "${ADB[@]}" shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
  sleep 1
}

"${ADB[@]}" shell am force-stop "$APP"
launch
cmd "screen/Product?id=p-1001"
cmd "action/add?id=p-1001"
cmd "screen/Products"
cmd "screen/Product?id=p-1002"
cmd "action/add?id=p-1002"
cmd "screen/Cart"
cmd "screen/Checkout"
if tap_id ouo-mask; then
  log "type a promo code"
  "${ADB[@]}" shell input text "SECRET4242"
  sleep 2
  "${ADB[@]}" shell input keyevent KEYCODE_BACK # hide the keyboard
  sleep 2
fi
cmd "screen/Chaos"
cmd "action/fetch-500"
cmd "screen/Products"
cmd "action/flush" 4
log "background"
"${ADB[@]}" shell input keyevent KEYCODE_HOME
sleep 8
"${ADB[@]}" shell am force-stop "$APP"
if [[ $RELAUNCH == 1 ]]; then
  launch
  cmd "screen/Product?id=p-1003"
  cmd "action/flush" 4
  log "background"
  "${ADB[@]}" shell input keyevent KEYCODE_HOME
  sleep 8
fi
log "done"
