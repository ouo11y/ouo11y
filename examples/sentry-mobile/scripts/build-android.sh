#!/usr/bin/env bash
# Build the sentry-demo app in the Release configuration for Android (JS bundle embedded, no Metro)
# and install it on an emulator.
#
#   scripts/build-android.sh [--serial <adb serial>] [--clean] [--no-install]
#
# Environment (baked in at Gradle time, see app.config.ts): SENTRY_DSN, BACKEND_URL, APP_VERSION,
# BUILD_NUMBER, SENTRY_DEBUG=1, SENTRY_CAPTURE_ALL=1, SENTRY_REPLAY_MASK=default, read from .env when
# present; the shell wins. From the emulator the Mac's localhost is 10.0.2.2, so build with for
# example SENTRY_DSN=http://<key>@10.0.2.2:4531/<project>. Needs JDK 17 and the Android SDK
# (ANDROID_HOME, project/kb-archive/android-setup.md). ABIs: REACT_NATIVE_ARCHITECTURES, default
# arm64-v8a. Added for the Step 6 wire captures (project/kb/vendor-internals/sentry/mobile-sdks/).
set -euo pipefail
cd "$(dirname "$0")/.."
SERIAL="${ANDROID_SERIAL:-}" CLEAN=0 INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --no-install) INSTALL=0 ;;
    --serial) SERIAL="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [build-android] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -f .env ]]; then
  saved="$(export -p)"
  set -a; . ./.env; set +a
  eval "$saved"
fi
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
# Never call sentry-cli / sentry.io from the Gradle build.
export ANDROID_HOME CI=1 NODE_ENV=production SENTRY_DISABLE_AUTO_UPLOAD=true
ADB="$ANDROID_HOME/platform-tools/adb"

[[ -d node_modules ]] || { log "npm ci"; npm ci; }
log "DSN ${SENTRY_DSN:-<app.config default>}, backend ${BACKEND_URL:-<app.config default>}"
if [[ $CLEAN == 1 || ! -d android ]]; then
  log "expo prebuild --platform android"
  ./node_modules/.bin/expo prebuild --platform android --no-install $([[ $CLEAN == 1 ]] && echo --clean)
fi

mkdir -p android/build
log "gradle :app:assembleRelease"
# lintVital crashes inside third-party modules with AGP 8.12 on JDK 17 (project/kb-archive/android-setup.md).
(cd android && ./gradlew :app:assembleRelease -x lintVitalAnalyzeRelease -PreactNativeArchitectures="${REACT_NATIVE_ARCHITECTURES:-arm64-v8a}" --console=plain) > android/build/gradle.log 2>&1 \
  || { tail -40 android/build/gradle.log; log "build failed, see android/build/gradle.log"; exit 1; }
APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
log "built $APK"
if [[ $INSTALL == 1 ]]; then
  [[ -n $SERIAL ]] || { echo "pass --serial (never install on a device you did not start)" >&2; exit 1; }
  "$ADB" -s "$SERIAL" install -r "$APK" >/dev/null
  log "installed dev.ouo.sentrydemo on $SERIAL"
fi
