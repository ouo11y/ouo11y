#!/usr/bin/env bash
# Build the sentry-demo app in the Release configuration for the iOS Simulator (JS bundle
# embedded, no Metro) and install it on the booted simulator.
#
#   scripts/build-ios.sh [--clean] [--no-install] [--device <udid>]
#
# Environment (baked in at build time, see app.config.ts): SENTRY_DSN, BACKEND_URL, APP_VERSION,
# BUILD_NUMBER, SENTRY_DEBUG=1. Needs full Xcode (DEVELOPER_DIR) and CocoaPods; see
# kb/sentry-react-native-demo.md and kb/xcode-setup.md.
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$PWD"

DEVICE="${SIM_UDID:-D64DE653-47C7-4349-91E3-D6E64D9EF009}"
CLEAN=0
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --no-install) INSTALL=0 ;;
    --device) DEVICE="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods refuses non-UTF-8 terminals
# Belt and braces with the plugin's disableAutoUpload: never call sentry-cli / sentry.io.
export SENTRY_DISABLE_AUTO_UPLOAD=true
export CI=1   # non-interactive expo CLI

log() { printf '%s [build-ios] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ ! -d node_modules ]]; then
  log "npm ci"
  npm ci
fi

if [[ $CLEAN == 1 || ! -d ios ]]; then
  log "expo prebuild --platform ios ${CLEAN:+(clean=$CLEAN)}"
  if [[ $CLEAN == 1 ]]; then
    npx expo prebuild --platform ios --clean --no-install
  else
    npx expo prebuild --platform ios --no-install
  fi
fi

log "pod install"
(cd ios && pod install)

WORKSPACE=$(ls -d ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
DERIVED="$APP_DIR/ios/build/DerivedData"

log "xcodebuild $SCHEME Release for simulator $DEVICE"
mkdir -p ios/build
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "id=$DEVICE" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  build 2>&1 | tee ios/build/xcodebuild.log | grep -E '^(\*\*|error:|.*error: |warning: .*Sentry)' || true
if ! grep -q '\*\* BUILD SUCCEEDED \*\*' ios/build/xcodebuild.log; then
  log "build failed, see ios/build/xcodebuild.log"
  exit 1
fi

APP_PATH="$DERIVED/Build/Products/Release-iphonesimulator/$SCHEME.app"
log "built $APP_PATH"

if [[ $INSTALL == 1 ]]; then
  log "install on $DEVICE"
  xcrun simctl install "$DEVICE" "$APP_PATH"
  log "installed dev.ouo.sentrydemo"
fi
