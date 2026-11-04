#!/usr/bin/env bash
# Unattended shopper journey for mobile-store on an iOS Simulator (no taps: commands through the
# app's Documents/journey-command file, src/journey.ts).
#
#   scripts/journey.sh [--device <udid>]
#
# Launch (Products loads the catalog) -> two products, each added to the cart -> cart, feedback with a
# screenshot -> checkout
# (card) -> one more product -> checkout (broken-card, 500) -> 500 from /api/products -> flush,
# background (Home) so the SDK exports, terminate.
set -euo pipefail
DEVICE="${SIM_UDID:-}"
BUNDLE=${OUO_IOS_BUNDLE:-dev.ouo.mobilestore}   # dev.ouo.bare: examples/ouo-bare-rn
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n $DEVICE ]] || DEVICE=booted
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
log() { printf '%s [journey] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cmd() {
  log "command $1"
  local docs; docs="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"
  mkdir -p "$docs"
  printf '%s\n' "$1" > "$docs/.journey-command.tmp"
  mv "$docs/.journey-command.tmp" "$docs/journey-command"
  sleep "${2:-2}"
}

xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
log "launch $BUNDLE"
xcrun simctl launch "$DEVICE" "$BUNDLE" >/dev/null
sleep 6
cmd "screen/Product?id=p-1001"
cmd "action/add?id=p-1001"
cmd "screen/Products"
cmd "screen/Product?id=p-1002"
cmd "action/add?id=p-1002"
cmd "screen/Cart"
cmd "action/feedback?message=The%20cart%20total%20looks%20wrong&contact=qa%40example.invalid" 3
cmd "screen/Checkout"
cmd "action/checkout?method=card" 3
cmd "screen/Product?id=p-1003"
cmd "action/add?id=p-1003"
cmd "action/checkout?method=broken-card" 3
cmd "screen/Chaos"
cmd "action/fetch-500"
cmd "screen/Products"
cmd "action/flush" 4
log "background"
xcrun simctl launch "$DEVICE" com.apple.Preferences >/dev/null 2>&1 || true
sleep 5
xcrun simctl terminate "$DEVICE" com.apple.Preferences 2>/dev/null || true
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
log "done"
