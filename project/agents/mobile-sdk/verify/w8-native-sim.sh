#!/bin/sh
# W8 part 1 on an iOS simulator: the OuoSDK package in a UIKit app (w8-native-sim/), driven through
# five runs against an ouo-env stack, then read back from rum-api by w8-native-sim-check.mjs:
#   1 journey: Home, Products (a backend request, TTFD), Cart (a handled error), a log line, then a
#     background stay past the 5 s timeout and back (C1.1, C2.1, C4, C5.1, C7, C9; the simulator
#     takes about 5 s to post `didEnterBackground`, hence the 15 s);
#   2 a 3 s main-thread block on Cart (C3.1);
#   3 a SIGSEGV 3 s after launch on Home, then a launch (C2.2);
#   4 a memory warning and SIGKILL in the foreground, then a launch (C3.2);
#   5 a run with the collector stopped, then a launch with it back (C11.1);
#   6 the same SDK in an app with a scene delegate and in a SwiftUI `App` (the shapes where
#     `applicationState` is `.background` at launch): app start, the first screen's TTID, no
#     `app.lifecycle` before the first real change, and the launch's task role and `start` time.
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
(cd "$HERE/w8-native-sim" && xcodebuild -quiet -scheme OuoSimApp-Package -configuration Release \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$OUT/dd" build)
P="$OUT/dd/Build/Products/Release-iphonesimulator"
# A SwiftPM executable becomes an app: the binary, an Info.plist, the SDK's resource bundle, signed ad hoc.
wrap() { # <executable> <Info.plist> <bundle id>
  rm -rf "$OUT/$1.app" && mkdir -p "$OUT/$1.app"
  cp "$P/$1" "$OUT/$1.app/" && cp "$HERE/w8-native-sim/$2" "$OUT/$1.app/Info.plist"
  cp -R "$P/ouo11y-ios_OuoSDK.bundle" "$OUT/$1.app/"
  codesign --force --sign - "$OUT/$1.app" >/dev/null
  xcrun simctl uninstall "$UDID" "$3" 2>/dev/null || true
  xcrun simctl install "$UDID" "$OUT/$1.app"
}
wrap OuoSimApp Info.plist "$APP"
wrap OuoSimScene Info-Scene.plist "$APP.scene"
wrap OuoSimSwiftUI Info-SwiftUI.plist "$APP.swiftui"

run() { SIMCTL_CHILD_OUO_ACTION=$1 SIMCTL_CHILD_OUO_OTLP=$OUO_OTLP_URL SIMCTL_CHILD_OUO_BACKEND=$BACKEND xcrun simctl launch "$UDID" "${2:-$APP}" >/dev/null; }
background() { xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null; }
# Background first (the flush runs), then end the process: a run that ends normally.
stop() { background; sleep 3; xcrun simctl terminate "$UDID" "${1:-$APP}" 2>/dev/null || true; sleep 1; }

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
echo "6 scene delegate and SwiftUI App"
for v in scene swiftui; do run idle "$APP.$v"; sleep 6; stop "$APP.$v"; done

for v in "" .scene .swiftui; do
  cp "$(xcrun simctl get_app_container "$UDID" "$APP$v" data)/Documents/w8.jsonl" "$OUT/w8$v.jsonl"
done
node "$HERE/w8-native-sim-check.mjs" "$OUT/w8.jsonl" "$OUT/w8.scene.jsonl" "$OUT/w8.swiftui.jsonl"
