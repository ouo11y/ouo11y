#!/usr/bin/env bash
# Build the bare React Native 0.82 app in the Release configuration for the iOS Simulator (JS bundle
# embedded, no Metro) and install it on a simulator.
#
#   scripts/build-ios.sh [--env <name>] [--device <udid>] [--no-install] [--no-firebase]
#
# Settings are baked into the build (app.config.js `extra`, read by expo-constants):
# EXPO_PUBLIC_OTLP_ENDPOINT, EXPO_PUBLIC_OUO_REPLAY_ENDPOINT, EXPO_PUBLIC_OUO_PROJECT_ID / _TOKEN,
# BACKEND_URL, APP_VERSION, OUO_ENV; --env <name> points the app at an ouo-env's published ports.
# --no-install builds for any simulator (CI): no device needed. --no-firebase leaves the Firebase
# pods out (OUO_NO_FIREBASE=1). Needs full Xcode and CocoaPods (project/kb/xcode-setup.md).
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$PWD"
root="$(cd ../.. && pwd)"
DEVICE="${SIM_UDID:-}" INSTALL=1 ENV_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --no-firebase) export OUO_NO_FIREBASE=1 ;;
    --device) DEVICE="$2"; shift ;;
    --env) ENV_NAME="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [bare build-ios] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -n $ENV_NAME ]]; then
  urls="$("$root/deploy/envs/ouo-env" url "$ENV_NAME")"
  otlp="$(sed -n 's/.*OTLP *\(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  replay="$(sed -n 's/.*replay \(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  backend="$(sed -n 's/.*backend \(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  [[ -n $otlp && -n $replay && -n $backend ]] || { echo "cannot read the ports of env $ENV_NAME" >&2; exit 1; }
  export EXPO_PUBLIC_OTLP_ENDPOINT="${EXPO_PUBLIC_OTLP_ENDPOINT:-$otlp}" EXPO_PUBLIC_OUO_REPLAY_ENDPOINT="${EXPO_PUBLIC_OUO_REPLAY_ENDPOINT:-$replay}" BACKEND_URL="${BACKEND_URL:-$backend}"
fi
if [[ $INSTALL == 1 && -z $DEVICE ]]; then
  DEVICE="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')"
  [[ -n $DEVICE ]] || { echo "no booted simulator: boot one or pass --device" >&2; exit 1; }
fi

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods refuses non-UTF-8 terminals
export CI=1 NODE_ENV=production

# Always (about 2 s): the app compiles the SDK's dist and its copy of the sdk/ios sources.
log "build @ouo11y/react-native (dist, sdk/ios sources)"; (cd "$root" && npm run -w sdk/react-native build >/dev/null)
[[ -d node_modules ]] || { log "npm ci"; npm ci --no-audit --no-fund; }
log "OTLP ${EXPO_PUBLIC_OTLP_ENDPOINT:-<default>}, replay ${EXPO_PUBLIC_OUO_REPLAY_ENDPOINT:-<derived>}, backend ${BACKEND_URL:-<default>}, firebase $([[ ${OUO_NO_FIREBASE:-0} == 1 ]] && echo no || echo yes)"
mkdir -p ios/build
log "pod install"
(cd ios && pod install > "$APP_DIR/ios/build/pod-install.log" 2>&1) || { tail -30 ios/build/pod-install.log; exit 1; }

DERIVED="$APP_DIR/ios/build/DerivedData"
dest="generic/platform=iOS Simulator"
[[ -n $DEVICE ]] && dest="id=$DEVICE"
log "xcodebuild OuoBare Release for $dest"
xcodebuild -workspace ios/OuoBare.xcworkspace -scheme OuoBare -configuration Release -sdk iphonesimulator \
  -destination "$dest" -derivedDataPath "$DERIVED" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build \
  > ios/build/xcodebuild.log 2>&1 || true
grep -q '\*\* BUILD SUCCEEDED \*\*' ios/build/xcodebuild.log || { grep -E ' error:' ios/build/xcodebuild.log | sort -u | head -20; log "build failed, see ios/build/xcodebuild.log"; exit 1; }
APP_PATH="$DERIVED/Build/Products/Release-iphonesimulator/OuoBare.app"
[[ -f $APP_PATH/main.jsbundle ]] || { log "no main.jsbundle in $APP_PATH"; exit 1; }
log "built $APP_PATH"
if [[ $INSTALL == 1 ]]; then
  xcrun simctl install "$DEVICE" "$APP_PATH"
  log "installed dev.ouo.bare on $DEVICE"
fi
