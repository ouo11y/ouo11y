#!/usr/bin/env bash
# Unattended Sentry SDK journey on the booted iOS Simulator (no taps: deep links only).
#
#   scripts/journey.sh [--no-nav] [--no-network] [--no-shop] [--no-errors] [--no-background] [--no-crash]
#                      [--js-fatal] [--shop-rounds 2] [--bg-seconds 40] [--replay-wait 12] [--device <udid>] [--openurl]
#
# Commands use the deep-link grammar (action/<name>, screen/<name>). By default they are delivered
# through the app's file mailbox (Documents/journey-command, polled by src/mailbox.ts) because on
# iOS 27 `xcrun simctl openurl` shows an "Open in sentry-demo?" alert for every custom-scheme URL.
# --openurl uses real deep links instead (someone must tap "Open" each time).
#
# Phases, in order:
#   launch      terminate + launch the app (session init, app start, first replay segment)
#   nav         Home -> Product -> Cart -> Home (navigation transactions)
#   network     fetch OK, fetch 500, slow fetch (http.client spans)
#   shop        --shop-rounds x (browse catalog, search, checkout, declined checkout): manually
#               instrumented transactions whose fetches reach the backend (app + backend spans in
#               one trace) and Sentry.logger calls (log items)
#   errors      handled error, breadcrumb + message, unhandled promise rejection
#   replay      wait so replay segments flush (one segment about every 5 s)
#   background  Settings app in front for --bg-seconds (> 30 s), relaunch: session `exited` + new session
#   js-fatal    (opt-in) fatal JS error from setTimeout, relaunch
#   crash       Sentry.nativeCrash(), relaunch so the crash report and `crashed` session are sent
#   end         wait, terminate
#
# Install the app first with scripts/build-ios.sh. Start a recorder on the DSN port
# (scripts/recorder.py) or the ouosentry receiver before running.
set -euo pipefail

DEVICE="${SIM_UDID:-D64DE653-47C7-4349-91E3-D6E64D9EF009}"
BUNDLE=dev.ouo.sentrydemo
NAV=1 NETWORK=1 SHOP=1 ERRORS=1 BACKGROUND=1 CRASH=1 JSFATAL=0
SHOP_ROUNDS=2
BG_SECONDS=40
OPENURL=0
REPLAY_WAIT=12

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-nav) NAV=0 ;;
    --no-network) NETWORK=0 ;;
    --no-shop) SHOP=0 ;;
    --shop-rounds) SHOP_ROUNDS="$2"; shift ;;
    --no-errors) ERRORS=0 ;;
    --no-background) BACKGROUND=0 ;;
    --no-crash) CRASH=0 ;;
    --js-fatal) JSFATAL=1 ;;
    --bg-seconds) BG_SECONDS="$2"; shift ;;
    --replay-wait) REPLAY_WAIT="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --openurl) OPENURL=1 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

log() { printf '%s [journey] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
wait_s() { log "  wait ${1}s${2:+ ($2)}"; sleep "$1"; }
link() {
  if [[ $OPENURL == 1 ]]; then
    log "openurl sentrydemo://$1"
    xcrun simctl openurl "$DEVICE" "sentrydemo://$1"
  else
    log "command $1"
    local docs; docs="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"
    mkdir -p "$docs"
    printf '%s\n' "$1" > "$docs/.journey-command.tmp"
    mv "$docs/.journey-command.tmp" "$docs/journey-command"
  fi
}
launch() { log "launch $BUNDLE"; xcrun simctl launch "$DEVICE" "$BUNDLE" >/dev/null; }
terminate() { log "terminate $BUNDLE"; xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true; }

if ! xcrun simctl get_app_container "$DEVICE" "$BUNDLE" >/dev/null 2>&1; then
  echo "$BUNDLE is not installed on $DEVICE; run scripts/build-ios.sh first" >&2
  exit 1
fi

log "== phase launch (device $DEVICE)"
terminate
rm -f "$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents/journey-command"
wait_s 1
launch
wait_s 8 "app start, session init, first screen"

if [[ $NAV == 1 ]]; then
  log "== phase nav"
  link "screen/product?id=p-1001"; wait_s 3
  link "screen/cart"; wait_s 3
  link "screen/product?id=p-1002"; wait_s 3
  link "screen/home"; wait_s 3
fi

if [[ $NETWORK == 1 ]]; then
  log "== phase network"
  link "action/fetch-ok"; wait_s 2
  link "action/fetch-500"; wait_s 2
  link "action/fetch-slow"; wait_s 5
fi

if [[ $SHOP == 1 ]]; then
  log "== phase shop ($SHOP_ROUNDS rounds)"
  for ((round = 1; round <= SHOP_ROUNDS; round++)); do
    link "action/browse-catalog"; wait_s 3
    link "action/search"; wait_s 3
    link "screen/product?id=p-100$((round + 3))"; wait_s 3
    link "screen/home"; wait_s 2
    link "action/checkout"; wait_s 3
    link "action/checkout-fail"; wait_s 3
  done
fi

if [[ $ERRORS == 1 ]]; then
  log "== phase errors"
  link "action/handled-error"; wait_s 2
  link "action/message"; wait_s 2
  link "action/unhandled-rejection"; wait_s 2
fi

log "== phase replay"
wait_s "$REPLAY_WAIT" "replay segments flush every ~5 s"

if [[ $BACKGROUND == 1 ]]; then
  log "== phase background"
  log "bring Settings to the front"
  xcrun simctl launch "$DEVICE" com.apple.Preferences >/dev/null
  wait_s "$BG_SECONDS" "app in background > 30 s session timeout"
  launch
  wait_s 8 "foreground: previous session exited, new session init"
  link "screen/product?id=p-1003"; wait_s 3
  link "screen/home"; wait_s 3
fi

if [[ $JSFATAL == 1 ]]; then
  log "== phase js-fatal"
  link "action/js-fatal"; wait_s 4 "app terminates"
  launch
  wait_s 10 "relaunch sends the fatal event"
fi

if [[ $CRASH == 1 ]]; then
  log "== phase crash"
  link "action/native-crash"; wait_s 4 "app crashes"
  launch
  wait_s 15 "relaunch sends the crash report and the crashed session"
fi

log "== phase end"
wait_s 5
terminate
log "done"
