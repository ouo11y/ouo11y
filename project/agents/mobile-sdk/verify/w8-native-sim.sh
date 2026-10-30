#!/bin/sh
# W8 part 1 on an iOS simulator: the OuoSDK package in a UIKit app (w8-native-sim/), driven through
# five runs against an ouo-env stack, then read back from rum-api by w8-native-sim-check.mjs:
#   1 journey: Home, Products (a backend request, TTFD), Cart (a handled error), a log line, then a
#     background stay past the 5 s timeout and back (C1.1, C2.1, C4, C5.1, C7, C9; the simulator
#     takes about 5 s to post `didEnterBackground`, hence the 15 s);
#   2 a 3 s main-thread block on Cart (C3.1);
#   3 a SIGSEGV 3 s after launch on Home, then a launch (C2.2);
#   4 a memory warning and SIGKILL in the foreground, then a launch (C3.2);
#   5 a run with the collector stopped, then a launch with it back (C11.1).
# Usage: w8-native-sim.sh <env> <simulator udid>   (the env up, the simulator booted; the app is
# uninstalled first). OUO_W8_OUT keeps the build and the run log (default: a temp folder).
set -eu
ENV=$1
UDID=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
OUT=${OUO_W8_OUT:-$(mktemp -d)}
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV")"
BACKEND=$("$ROOT/deploy/envs/ouo-env" url "$ENV" | sed -n 's/.*backend \(http[^ ]*\).*/\1/p' | tail -1)
COLLECTOR="ouo-$ENV-otel-collector-1"
APP=dev.ouo.w8sim

echo "building into $OUT"
(cd "$HERE/w8-native-sim" && xcodebuild -quiet -scheme OuoSimApp -configuration Release \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$OUT/dd" build)
P="$OUT/dd/Build/Products/Release-iphonesimulator"
rm -rf "$OUT/OuoSimApp.app" && mkdir -p "$OUT/OuoSimApp.app"
cp "$P/OuoSimApp" "$HERE/w8-native-sim/Info.plist" "$OUT/OuoSimApp.app/"
cp -R "$P/ouo11y-ios_OuoSDK.bundle" "$OUT/OuoSimApp.app/"
codesign --force --sign - "$OUT/OuoSimApp.app" >/dev/null
xcrun simctl uninstall "$UDID" "$APP" 2>/dev/null || true
xcrun simctl install "$UDID" "$OUT/OuoSimApp.app"

run() { SIMCTL_CHILD_OUO_ACTION=$1 SIMCTL_CHILD_OUO_OTLP=$OUO_OTLP_URL SIMCTL_CHILD_OUO_BACKEND=$BACKEND xcrun simctl launch "$UDID" "$APP" >/dev/null; }
background() { xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null; }
# Background first (the flush runs), then end the process: a run that ends normally.
stop() { background; sleep 3; xcrun simctl terminate "$UDID" "$APP" 2>/dev/null || true; sleep 1; }

echo "1 journey + background rotation"
run journey; sleep 6; background; sleep 15; run idle; sleep 3; stop
echo "2 hang"
run hang; sleep 9; stop
echo "3 crash, next launch"
run crash; sleep 6; run idle; sleep 4; stop
echo "4 memory kill, next launch"
run oom; sleep 5; run idle; sleep 4; stop
echo "5 offline run, next launch online"
docker stop "$COLLECTOR" >/dev/null
run offline; sleep 4; stop
docker start "$COLLECTOR" >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "$OUO_COLLECTOR_HEALTH_URL" && break; sleep 2; done
run idle; sleep 6; stop

cp "$(xcrun simctl get_app_container "$UDID" "$APP" data)/Documents/w8.jsonl" "$OUT/w8.jsonl"
node "$HERE/w8-native-sim-check.mjs" "$OUT/w8.jsonl"
