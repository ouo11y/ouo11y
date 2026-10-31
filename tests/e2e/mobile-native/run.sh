#!/bin/sh
# The native iOS conformance suite (docs/specs/mobile-sdk.md section 5, ADR-0015): the example app
# (examples/ouo-ios) on a simulator against an ouo-env stack, launches for every check, then
# check.mjs asserts rum-api with the same check ids as the React Native suite and prints the
# maturity row. C6.1's taps come from an XCUITest runner (taps/, generated with xcodegen) that
# drives the example by accessibility identifier. Run by hand: CI's Mac runner runs one job at a
# time and has no stack (README.md).
#
# Usage: run.sh <env> <simulator udid>
# OUO_NATIVE_OUT keeps the build, the app's notes and the proxy log (default: a temp folder).
set -eu
ENV=$1
UDID=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=${OUO_NATIVE_OUT:-$(mktemp -d)}
mkdir -p "$OUT"
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV")"
BACKEND=$("$ROOT/deploy/envs/ouo-env" url "$ENV" | sed -n 's/.*backend \(http[^ ]*\).*/\1/p' | tail -1)
COLLECTOR="ouo-$ENV-otel-collector-1"
APP=dev.ouo.example.ios
PROXY_PORT=${OUO_NATIVE_PROXY_PORT:-18318}

echo "building into $OUT"
BUNDLE=$("$ROOT/examples/ouo-ios/scripts/build.sh" "$OUT" | tail -1)
mkdir -p "$OUT/taps" && xcodegen generate --spec "$HERE/taps/project.yml" --project "$OUT/taps" --quiet
TAPS_RUN="xcodebuild -project $OUT/taps/Taps.xcodeproj -scheme RunnerUITests -destination id=$UDID -derivedDataPath $OUT/taps/dd -quiet"
perl -e 'alarm 900; exec @ARGV' $TAPS_RUN build-for-testing > "$OUT/taps-build.log" 2>&1
xcrun simctl uninstall "$UDID" "$APP" 2>/dev/null || true
xcrun simctl install "$UDID" "$BUNDLE"
: > "$OUT/requests.jsonl"
node "$HERE/proxy.mjs" "$PROXY_PORT" "$OUO_OTLP_URL" "$OUT/requests.jsonl" &
PROXY=$!
trap 'kill $PROXY 2>/dev/null || true' EXIT

run() { SIMCTL_CHILD_OUO_ACTION=$1 SIMCTL_CHILD_OUO_OTLP=${2:-$OUO_OTLP_URL} SIMCTL_CHILD_OUO_REPLAY=$OUO_REPLAY_URL SIMCTL_CHILD_OUO_BACKEND=$BACKEND xcrun simctl launch "$UDID" "$APP" >/dev/null; }
background() { xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null; }
# Background first (the flush runs), then end the process: a run that ends normally.
stop() { background; sleep 3; xcrun simctl terminate "$UDID" "$APP" 2>/dev/null || true; sleep 1; }

echo "main: journey through the proxy, a background stay past the 5 s timeout, back"
run journey "http://127.0.0.1:$PROXY_PORT"; sleep 7; background; sleep 15; run idle "http://127.0.0.1:$PROXY_PORT"; sleep 4; stop
echo "taps: the XCUITest runner taps Products, Add to cart, long-presses Checkout, swipes the items"
run taps; sleep 3
perl -e 'alarm 300; exec @ARGV' $TAPS_RUN test-without-building > "$OUT/taps.log" 2>&1 || echo "taps runner failed: $OUT/taps.log"
stop
echo "hang"; run hang; sleep 9; stop
echo "crash 3 s after launch, next launch"; run crash; sleep 6; run idle; sleep 4; stop
echo "crash 200 ms after launch, next launch"; run early; sleep 3; run idle; sleep 4; stop
echo "memory kill, next launch"; run oom; sleep 5; run idle; sleep 4; stop
echo "offline run, next launch online"
docker stop "$COLLECTOR" >/dev/null
run offline; sleep 4; stop
docker start "$COLLECTOR" >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "$OUO_COLLECTOR_HEALTH_URL" && break; sleep 2; done
run idle; sleep 6; stop

cp "$(xcrun simctl get_app_container "$UDID" "$APP" data)/Documents/journey.jsonl" "$OUT/journey.jsonl"
node "$HERE/check.mjs" "$OUT"
