#!/usr/bin/env bash
# Build the bare React Native 0.82 app in the Release configuration for Android (JS bundle embedded,
# no Metro) and install it on an emulator or a device.
#
#   scripts/build-android.sh [--env <name>] [--host <ip>] [--serial <adb serial>] [--conformance] [--no-install]
#
# Same settings and flags as examples/ouo-mobile/scripts/build-android.sh, without the prebuild: the
# native projects are checked in. --env <name> points the app at an ouo-env's published ports on --host
# (default 10.0.2.2, the emulator's address of the Mac); --conformance builds the golden app of the
# Android conformance suite (OUO_CONFORMANCE=1: default replay masking, a 5 s background timeout,
# OUO_NOTE lines in logcat). Needs JDK 17 and the Android SDK (ANDROID_HOME, project/kb/android-setup.md).
# ABIs: REACT_NATIVE_ARCHITECTURES, default arm64-v8a (Apple silicon emulators and phones).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
SERIAL="${ANDROID_SERIAL:-}" INSTALL=1 ENV_NAME="" HOST="10.0.2.2"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --serial) SERIAL="$2"; shift ;;
    --env) ENV_NAME="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    --conformance) export OUO_CONFORMANCE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [bare build-android] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -n $ENV_NAME ]]; then
  urls="$("$root/deploy/envs/ouo-env" url "$ENV_NAME")"
  port() { sed -n "s/.*$1 *http:\/\/localhost:\([0-9]*\).*/\1/p" <<<"$urls" | head -1; }
  otlp="$(port OTLP)" replay="$(port replay)" backend="$(port backend)"
  [[ -n $otlp && -n $replay && -n $backend ]] || { echo "cannot read the ports of env $ENV_NAME" >&2; exit 1; }
  export EXPO_PUBLIC_OTLP_ENDPOINT="${EXPO_PUBLIC_OTLP_ENDPOINT:-http://$HOST:$otlp}"
  export EXPO_PUBLIC_OUO_REPLAY_ENDPOINT="${EXPO_PUBLIC_OUO_REPLAY_ENDPOINT:-http://$HOST:$replay}"
  export BACKEND_URL="${BACKEND_URL:-http://$HOST:$backend}"
fi
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
export ANDROID_HOME CI=1 NODE_ENV=production
ADB="$ANDROID_HOME/platform-tools/adb"

# Always (about 2 s): the app compiles the SDK's dist and its vendored copy of sdk/android.
log "build @ouo11y/react-native (dist, vendored sdk/android)"; (cd "$root" && npm run -w sdk/react-native build >/dev/null)
[[ -d node_modules ]] || { log "npm ci"; npm ci --no-audit --no-fund; }
log "OTLP ${EXPO_PUBLIC_OTLP_ENDPOINT:-<default>}, replay ${EXPO_PUBLIC_OUO_REPLAY_ENDPOINT:-<derived>}, backend ${BACKEND_URL:-<default>}, conformance ${OUO_CONFORMANCE:-0}"

mkdir -p android/build
log "gradle :app:assembleRelease"
# The bundle task's inputs are this app's files only: a change to the golden screens in ../ouo-mobile or
# to the linked SDK would leave the bundle UP-TO-DATE, so that one task always runs (--rerun).
(cd android && ./gradlew :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease -x lintVitalAnalyzeRelease -PreactNativeArchitectures="${REACT_NATIVE_ARCHITECTURES:-arm64-v8a}" --console=plain) > android/build/gradle.log 2>&1 \
  || { grep -E '^e: |What went wrong' -A4 android/build/gradle.log | head -40; tail -20 android/build/gradle.log; log "build failed, see android/build/gradle.log"; exit 1; }
APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
log "built $APK"
if [[ $INSTALL == 1 ]]; then
  [[ -n $SERIAL ]] || SERIAL="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
  [[ -n $SERIAL ]] || { echo "no device: boot an emulator or pass --serial" >&2; exit 1; }
  "$ADB" -s "$SERIAL" install -r "$APK" >/dev/null
  log "installed dev.ouo.bare on $SERIAL"
fi
