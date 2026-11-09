#!/usr/bin/env bash
# The React Native Android conformance suite (docs/specs/mobile-sdk.md section 5, ADR-0015): the
# example app (examples/ouo-mobile, built with OUO_CONFORMANCE=1) on an Android emulator against an
# ouo-env stack, the launches the checks need, then check.mjs asserts rum-api with the same check
# ids as the other suites and prints the maturity row. Commands reach the app as broadcasts, taps
# come from `adb shell input` on the views uiautomator finds by test id, OTLP goes through
# ../mobile-native/proxy.mjs (C11.2). Run by hand: CI's Mac runner runs one job at a time and has
# no stack (README.md).
#
# Usage: run.sh <env> [<adb serial>]      (OUO_ANDROID_OUT keeps the notes, logs and frames)
# OUO_ANDROID_SKIP_BUILD=1 reuses the installed app (built for the same env and proxy port).
# OUO_ANDROID_APP=ouo-bare-rn runs the same launches on examples/ouo-bare-rn (bare React Native 0.82
# with install-expo-modules, the same golden screens and demo module); default examples/ouo-mobile.
set -euo pipefail
ENV=$1
SERIAL=${2:-${ANDROID_SERIAL:-emulator-5580}}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=${OUO_ANDROID_OUT:-$(mktemp -d)}
mkdir -p "$OUT"
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
export ANDROID_HOME
ADB=("$ANDROID_HOME/platform-tools/adb" -s "$SERIAL")
EXAMPLE=${OUO_ANDROID_APP:-ouo-mobile}
case "$EXAMPLE" in
  ouo-mobile) APP=dev.ouo.mobilestore ;;
  ouo-bare-rn) APP=dev.ouo.bare ;;
  *) echo "OUO_ANDROID_APP must be ouo-mobile or ouo-bare-rn" >&2; exit 2 ;;
esac
PROXY_PORT=${OUO_ANDROID_PROXY_PORT:-18328}
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV")"
COLLECTOR="ouo-$ENV-otel-collector-1"
log() { printf '%s [android-suite] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ ${OUO_ANDROID_SKIP_BUILD:-0} != 1 ]]; then
  log "building the golden app ($EXAMPLE) into $OUT (OTLP through the proxy on $PROXY_PORT)"
  EXPO_PUBLIC_OTLP_ENDPOINT="http://10.0.2.2:$PROXY_PORT" "$ROOT/examples/$EXAMPLE/scripts/build-android.sh" --env "$ENV" --conformance --no-install
fi
"${ADB[@]}" uninstall "$APP" >/dev/null 2>&1 || true
"${ADB[@]}" install "$ROOT/examples/$EXAMPLE/android/app/build/outputs/apk/release/app-release.apk" >/dev/null
swiftc -O "$HERE/../mobile-native/pixels.swift" -o "$OUT/pixels"

: > "$OUT/requests.jsonl"
node "$HERE/../mobile-native/proxy.mjs" "$PROXY_PORT" "$OUO_OTLP_URL" "$OUT/requests.jsonl" &
PROXY=$!
"${ADB[@]}" logcat -c
"${ADB[@]}" logcat -v epoch ReactNativeJS:I ouo:V AndroidRuntime:E '*:S' > "$OUT/logcat.txt" &
LOGCAT=$!
# The offline run stops the collector: whatever happens, it is started again.
trap 'kill $PROXY $LOGCAT 2>/dev/null || true; docker start "$COLLECTOR" >/dev/null 2>&1 || true' EXIT

# `launch <action>`: the action names the launch in the app's notes (check.mjs finds it by name).
launch() { "${ADB[@]}" shell am start -W -n "$APP/.MainActivity" -e ouo_action "${1:-relaunch}" >/dev/null; }
cmd() {
  log "command $1"
  "${ADB[@]}" shell "am broadcast -a dev.ouo.mobilestore.JOURNEY -p $APP --es cmd '$1'" >/dev/null
  sleep "${2:-2}"
}
background() { "${ADB[@]}" shell input keyevent KEYCODE_HOME; }
# Background first (the flush runs), then end the process: a run that ends normally.
stop() { background; sleep 4; "${ADB[@]}" shell am force-stop "$APP"; sleep 1; }
# The centre of the view with this test id (React Native puts testID in the resource id).
center() {
  "${ADB[@]}" shell uiautomator dump /sdcard/ouo-ui.xml >/dev/null
  "${ADB[@]}" shell cat /sdcard/ouo-ui.xml | python3 -I -c '
import re, sys
xml, tid = sys.stdin.read(), sys.argv[1]
m = re.search(r"resource-id=\"%s\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"" % re.escape(tid), xml)
if not m: sys.exit("no view with test id " + tid)
x0, y0, x1, y1 = map(int, m.groups()); print((x0 + x1) // 2, (y0 + y1) // 2)' "$1"
}

log "main: journey Products, Product, Cart (error, span and log, feedback), background past the 5 s timeout, back"
launch main; sleep 8
cmd "screen/Product?id=p-1001" 3
cmd "action/areas" 2
cmd "action/add?id=p-1001" 1
cmd "screen/Cart" 3
cmd "action/areas" 2
cmd "action/error" 1
cmd "action/golden" 2
cmd "action/feedback?message=golden%20feedback&contact=qa%40example.invalid" 4
background; sleep 10; launch resume; sleep 6; cmd "action/flush" 3; stop

log "taps: tap a product on Products, long-press Add to cart on Product, swipe the items on Cart"
launch taps; sleep 8
read -r x y <<<"$(center product-p-1002)"; "${ADB[@]}" shell input tap "$x" "$y"; sleep 4
read -r x y <<<"$(center 'btn-Add to cart')"; "${ADB[@]}" shell input swipe "$x" "$y" "$x" "$y" 900; sleep 4
read -r x y <<<"$(center cart-items)"; "${ADB[@]}" shell input swipe "$x" "$y" "$x" "$((y - 300))" 300; sleep 2
cmd "action/flush" 3; stop

log "crash: a native crash on Cart while recording, next launch"
launch crash; sleep 7; cmd "screen/Cart" 2; cmd "action/crash" 4; launch; sleep 8; stop

log "hang: the main thread blocked for 3 s on Cart"
launch hang; sleep 7; cmd "screen/Cart" 2; cmd "action/hang?ms=3000" 7; cmd "action/flush" 3; stop

log "early crash: a native crash 200 ms after the JS bundle runs, next launch"
launch crash-early; sleep 5; launch; sleep 8; stop

log "memory kill: a memory warning, then SIGKILL in the foreground on Cart, next launch"
launch oom; sleep 7; cmd "screen/Cart" 2; cmd "action/oom" 4; launch; sleep 8; stop

log "offline run, next launch online"
docker stop "$COLLECTOR" >/dev/null
launch offline; sleep 6; cmd "action/event?name=offline-step" 2; stop
docker start "$COLLECTOR" >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "$OUO_COLLECTOR_HEALTH_URL" && break; sleep 2; done
launch; sleep 10; stop

log "reject: the proxy answers the first OTLP request 500 every time, the second 503 once"
curl -sf -X POST "http://127.0.0.1:$PROXY_PORT/__reject"
launch reject; sleep 6; cmd "action/event?name=reject-step" 2; cmd "action/flush" 6; stop

kill $LOGCAT 2>/dev/null || true
node "$HERE/check.mjs" "$OUT"
