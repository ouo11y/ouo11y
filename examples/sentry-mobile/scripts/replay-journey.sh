#!/usr/bin/env bash
# Fixed-length replay journey on the iOS Simulator, to measure Sentry mobile replay bytes per minute.
#
#   scripts/replay-journey.sh --device <udid> [--seconds 120]
#
# Launches the app, then for --seconds sends one command every 2.5 s through the file mailbox
# (same loop of screens and actions as scripts/android-journey.py --phases replay), then brings
# Settings to the front (the app goes to the background and sends its last, partial segment), and
# terminates the app. Pair with a sentrytap capture and scripts/extract.py. Written for the Step 6
# research (project/kb/vendor-internals/sentry/mobile-sdks/replay-mobile.md).
set -euo pipefail
DEVICE="" SECONDS_TOTAL=120 BUNDLE=dev.ouo.sentrydemo
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift ;;
    --seconds) SECONDS_TOTAL="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n $DEVICE ]] || { echo "pass --device <udid> (your own simulator)" >&2; exit 2; }
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
log() { printf '%s [replay-journey] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
docs="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"
link() { log "command $1"; mkdir -p "$docs"; printf '%s\n' "$1" > "$docs/.journey-command.tmp"; mv "$docs/.journey-command.tmp" "$docs/journey-command"; }

xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
rm -f "$docs/journey-command"
sleep 1
log "launch"; xcrun simctl launch "$DEVICE" "$BUNDLE" >/dev/null
sleep 6
loop=("screen/product?id=p-1001" "screen/cart" "screen/home" "action/fetch-ok" "action/browse-catalog"
      "screen/product?id=p-1002" "screen/home" "action/search" "action/handled-error" "screen/cart" "screen/home")
start=$(date +%s) i=0
while (( $(date +%s) - start < SECONDS_TOTAL )); do
  link "${loop[$((i % ${#loop[@]}))]}"
  i=$((i + 1))
  sleep 2.5
done
log "loop done after $(( $(date +%s) - start ))s, $i commands"
xcrun simctl launch "$DEVICE" com.apple.Preferences >/dev/null
sleep 8
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
log "done"
