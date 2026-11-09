#!/usr/bin/env bash
# Build mobile-store in the Release configuration for the iOS Simulator (JS bundle embedded, no
# Metro) and install it on a simulator.
#
#   scripts/build-ios.sh [--env <name>] [--device <udid>] [--clean] [--no-install]
#
# Settings are baked into the build (app.config.ts `extra`): EXPO_PUBLIC_OTLP_ENDPOINT,
# EXPO_PUBLIC_OUO_REPLAY_ENDPOINT, EXPO_PUBLIC_OUO_PROJECT_ID / _TOKEN, BACKEND_URL, APP_VERSION,
# OUO_ENV, read from .env when present (copy .env.example), the shell wins. --env <name> points the
# app at an ouo-env's published ports instead. Needs full Xcode and CocoaPods
# (project/kb-archive/xcode-setup.md); builds @ouo11y/react-native first when its dist/ is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$PWD"
root="$(cd ../.. && pwd)"
DEVICE="${SIM_UDID:-}" CLEAN=0 INSTALL=1 ENV_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --no-install) INSTALL=0 ;;
    --device) DEVICE="$2"; shift ;;
    --env) ENV_NAME="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [build-ios] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -f .env ]]; then
  saved="$(export -p)"
  set -a; . ./.env; set +a
  eval "$saved"
fi
if [[ -n $ENV_NAME ]]; then
  urls="$("$root/deploy/envs/ouo-env" url "$ENV_NAME")"
  otlp="$(sed -n 's/.*OTLP *\(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  replay="$(sed -n 's/.*replay \(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  backend="$(sed -n 's/.*backend \(http:\/\/localhost:[0-9]*\).*/\1/p' <<<"$urls")"
  [[ -n $otlp && -n $replay && -n $backend ]] || { echo "cannot read the ports of env $ENV_NAME" >&2; exit 1; }
  export EXPO_PUBLIC_OTLP_ENDPOINT="$otlp" EXPO_PUBLIC_OUO_REPLAY_ENDPOINT="$replay" BACKEND_URL="$backend"
fi
if [[ -z $DEVICE ]]; then
  DEVICE="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')"
  [[ -n $DEVICE ]] || { echo "no booted simulator: boot one or pass --device" >&2; exit 1; }
fi

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods refuses non-UTF-8 terminals
export CI=1                                   # non-interactive expo CLI

# Always (about 2 s): the app compiles the SDK's dist and its copy of the sdk/ios sources (sdk/react-native/ios), and a copy
# left from an earlier checkout builds an app without the source's changes.
log "build @ouo11y/react-native (dist, sdk/ios sources)"; (cd "$root" && npm run -w sdk/react-native build >/dev/null)
[[ -d node_modules ]] || { log "npm ci"; npm ci; }
log "OTLP ${EXPO_PUBLIC_OTLP_ENDPOINT:-<default>}, replay ${EXPO_PUBLIC_OUO_REPLAY_ENDPOINT:-<derived>}, backend ${BACKEND_URL:-<default>}"
if [[ $CLEAN == 1 || ! -d ios ]]; then
  log "expo prebuild --platform ios"
  npx expo prebuild --platform ios --no-install $([[ $CLEAN == 1 ]] && echo --clean)
fi
log "pod install"
(cd ios && pod install >/dev/null)

WORKSPACE=$(ls -d ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
DERIVED="$APP_DIR/ios/build/DerivedData"
log "xcodebuild $SCHEME Release for simulator $DEVICE"
mkdir -p ios/build
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release -sdk iphonesimulator \
  -destination "id=$DEVICE" -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO build \
  2>&1 | tee ios/build/xcodebuild.log | grep -E '^(\*\*|error:|.*error: )' || true
grep -q '\*\* BUILD SUCCEEDED \*\*' ios/build/xcodebuild.log || { log "build failed, see ios/build/xcodebuild.log"; exit 1; }
APP_PATH="$DERIVED/Build/Products/Release-iphonesimulator/$SCHEME.app"
log "built $APP_PATH"
if [[ $INSTALL == 1 ]]; then
  xcrun simctl install "$DEVICE" "$APP_PATH"
  log "installed dev.ouo.mobilestore on $DEVICE"
fi
