#!/usr/bin/env bash
# End-to-end symbolication on simulators (ADR-0026): build release apps, upload their debug files
# to Muninn with ouo-sourcemaps, crash them, read the recorded exception back from Loki and resolve
# it with libs/ouo-go/symbolicate (cmd/ouo-symbolicate), then assert the original files and lines.
#
#   tests/e2e/symbolication/run.sh --env <env> [--native-ios] [--rn-ios] [--rn-android]
#       [--sim <udid>] [--serial <adb serial>] [--out <dir>] [--no-build]
#
#   --env <env>      an ouo-env started with --muninn (deploy/envs/ouo-env up <env> --muninn)
#   --native-ios     examples/ouo-ios: dSYM upload (upload-dsym), a SIGSEGV, resolved through the dSYM
#   --rn-ios         examples/ouo-mobile Release (Hermes) on the iOS simulator: Hermes map upload, a fatal JS error
#   --rn-android     the same on an Android emulator (built with --conformance: the journey broadcasts)
#                    (no target flag: all three)
#   --sim <udid>     a booted iOS simulator (default: the first booted one)
#   --serial <s>     a running Android emulator (default: the first adb device)
#   --out <dir>      build outputs and resolved stacks (default: a temp folder)
#   --no-build       reuse the builds already in --out and the app folders
#
# Exits 1 when any target's resolved stack does not name the expected function, file and line.
# The Muninn tokens are the public development ones of deploy/compose (override with
# OUO_UPLOAD_TOKEN, MUNINN_READ_TOKEN). Needs Xcode, the Android SDK (ANDROID_HOME), Go and Node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_NAME="" SIM="" SERIAL="" OUT="" BUILD=1 TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --native-ios|--rn-ios|--rn-android) TARGETS+=("${1#--}") ;;
    --sim) SIM="$2"; shift ;;
    --serial) SERIAL="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n $ENV_NAME ]] || { echo "--env is required" >&2; exit 2; }
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=(native-ios rn-ios rn-android)
OUT="${OUT:-$(mktemp -d -t ouo-symbolication)}"
mkdir -p "$OUT"
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV_NAME")"
[[ -n ${OUO_MUNINN_URL:-} ]] || { echo "env $ENV_NAME has no Muninn: ouo-env up $ENV_NAME --muninn" >&2; exit 2; }
export OUO_UPLOAD_TOKEN="${OUO_UPLOAD_TOKEN:-ut_dev_demo_0000000000000000}"
export MUNINN_READ_TOKEN="${MUNINN_READ_TOKEN:-mrt_dev_0000000000000000}"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
export ANDROID_HOME
ADB="$ANDROID_HOME/platform-tools/adb"
APP_DIR="$ROOT/examples/ouo-mobile"
CLI=(node "$ROOT/sdk/sourcemaps/dist/cli.js")
log() { printf '%s [symbolication] %s\n' "$(date +%H:%M:%S)" "$*"; }
bound() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

log "out $OUT, env $ENV_NAME, targets ${TARGETS[*]}"
(cd "$ROOT" && npm run -w @ouo11y/sourcemaps build >/dev/null)
(cd "$ROOT/libs/ouo-go" && go build -o "$OUT/ouo-symbolicate" ./cmd/ouo-symbolicate)
needs_sim() { [[ -n $SIM ]] || SIM="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')"; [[ -n $SIM ]] || { echo "no booted simulator: pass --sim" >&2; exit 2; }; }

# resolve <service> <contains> <name>: polls Loki (the report can take a few seconds) and writes $OUT/<name>.json.
resolve() {
  local i
  for i in $(seq 1 20); do
    if "$OUT/ouo-symbolicate" --loki "$OUO_LOKI_URL" --muninn "$OUO_MUNINN_URL" --project demo \
        --service "$1" --contains "$2" --since "${SINCE}s" > "$OUT/$3.json" 2>"$OUT/$3.err"; then return 0; fi
    sleep 3
  done
  cat "$OUT/$3.err" >&2; return 1
}

# check <name> <function substring> <file suffix> <line> [...]: every triple must be a mapped frame.
FAILED=()
check() {
  local name=$1; shift
  if python3 - "$OUT/$name.json" "$@" <<'PY'; then log "PASS $name"; else log "FAIL $name (see $OUT/$name.json)"; FAILED+=("$name"); fi
import json, sys
res = json.load(open(sys.argv[1]))
want = sys.argv[2:]
frames = [f["original"] for f in res["frames"] if f["status"] == "mapped" and f.get("original")]
ok = True
for fn, file, line in zip(want[0::3], want[1::3], want[2::3]):
    hit = [f for f in frames if fn in f.get("function", "") and f["file"].endswith(file) and f["line"] == int(line)]
    print(f"  {'ok  ' if hit else 'MISS'} {fn} {file}:{line}")
    ok = ok and bool(hit)
if not ok:
    print("  resolved frames:")
    for f in frames[:12]:
        print(f"    {f.get('function', '')} {f['file']}:{f['line']}:{f['column']}")
sys.exit(0 if ok else 1)
PY
}

native_ios() {
  needs_sim
  local app="$OUT/ios-native/OuoExample.app" dsym="$OUT/ios-native/dd/Build/Products/Release-iphonesimulator/OuoExample.dSYM" id=dev.ouo.example.ios
  if [[ $BUILD == 1 ]]; then log "native iOS: build"; bound 1500 "$ROOT/examples/ouo-ios/scripts/build.sh" "$OUT/ios-native" >"$OUT/ios-native.log" 2>&1; fi
  log "native iOS: upload-dsym"
  "${CLI[@]}" upload-dsym "$dsym" --url "$OUO_MUNINN_URL" --token "$OUO_UPLOAD_TOKEN" --project demo >"$OUT/native-upload.log"
  xcrun simctl uninstall "$SIM" "$id" 2>/dev/null || true
  xcrun simctl install "$SIM" "$app"
  launch() { SIMCTL_CHILD_OUO_ACTION=$1 SIMCTL_CHILD_OUO_OTLP="$OUO_OTLP_URL" SIMCTL_CHILD_OUO_REPLAY="$OUO_REPLAY_URL" xcrun simctl launch "$SIM" "$id" >/dev/null; }
  SINCE=$(( $(date +%s) )); log "native iOS: crash, then the launch that reports it"
  launch crash; sleep 7; launch idle; sleep 8; xcrun simctl terminate "$SIM" "$id" 2>/dev/null || true
  SINCE=$(( $(date +%s) - SINCE + 2 ))  # only records of this run
  resolve ouo-ios-example SIGSEGV native-ios || { FAILED+=(native-ios); return; }
  # Swift names stay mangled (symbolicate does not demangle): crashForSymbolication() is $s10OuoExample21crashForSymbolicationyyF.
  check native-ios crashForSymbolication Journey.swift 167
}

# The Hermes stack of src/symbolication.ts: the throw (line 8). It is the only JavaScript frame:
# hermesc -O inlines chargeCardForSymbolication into the timer's arrow, and the timer calls it from
# native code, so the resolved name and line come from the map's inlined position.
rn_check() { check "$1" chargeCardForSymbolication src/symbolication.ts 8; }

rn_ios() {
  needs_sim
  local id=dev.ouo.mobilestore build="$APP_DIR/ios/build/DerivedData/Build/Products/Release-iphonesimulator"
  if [[ $BUILD == 1 ]]; then
    log "RN iOS: build (Release, Hermes, SOURCEMAP_FILE)"
    mkdir -p "$OUT/rn-ios"
    SOURCEMAP_FILE="$OUT/rn-ios/main.jsbundle.map" bound 3000 "$APP_DIR/scripts/build-ios.sh" --env "$ENV_NAME" --device "$SIM" --no-install >"$OUT/rn-ios.log" 2>&1
  fi
  local app; app="$(ls -d "$build"/*.app | head -1)"
  log "RN iOS: upload the Hermes map"
  "${CLI[@]}" upload --bundle "$app/main.jsbundle" --sourcemap "$OUT/rn-ios/main.jsbundle.map" \
    --url "$OUO_MUNINN_URL" --token "$OUO_UPLOAD_TOKEN" --project demo --release 1.0.0 >"$OUT/rn-ios-upload.log"
  xcrun simctl uninstall "$SIM" "$id" 2>/dev/null || true
  xcrun simctl install "$SIM" "$app"
  SINCE=$(( $(date +%s) ))
  xcrun simctl launch "$SIM" "$id" >/dev/null; sleep 8
  log "RN iOS: js-crash, then the launch that reports anything left"
  printf 'action/js-crash\n' > "$(xcrun simctl get_app_container "$SIM" "$id" data)/Documents/journey-command"
  sleep 6; xcrun simctl launch "$SIM" "$id" >/dev/null 2>&1 || true; sleep 8; xcrun simctl terminate "$SIM" "$id" 2>/dev/null || true
  SINCE=$(( $(date +%s) - SINCE + 2 ))  # only records of this run
  resolve mobile-store "ouo symbolication e2e" rn-ios || { FAILED+=(rn-ios); return; }
  rn_check rn-ios
}

rn_android() {
  [[ -n $SERIAL ]] || SERIAL="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
  [[ -n $SERIAL ]] || { echo "no Android emulator: boot one or pass --serial" >&2; exit 2; }
  local id=dev.ouo.mobilestore gen="$APP_DIR/android/app/build/generated"
  if [[ $BUILD == 1 ]]; then
    log "RN Android: build (Release, Hermes, --conformance)"
    bound 3000 "$APP_DIR/scripts/build-android.sh" --env "$ENV_NAME" --conformance --no-install >"$OUT/rn-android.log" 2>&1
  fi
  log "RN Android: upload the Hermes map"
  "${CLI[@]}" upload --bundle "$gen/assets/react/release/index.android.bundle" --sourcemap "$gen/sourcemaps/react/release/index.android.bundle.map" \
    --url "$OUO_MUNINN_URL" --token "$OUO_UPLOAD_TOKEN" --project demo --release 1.0.0 >"$OUT/rn-android-upload.log"
  "$ADB" -s "$SERIAL" install -r "$APP_DIR/android/app/build/outputs/apk/release/app-release.apk" >/dev/null
  SINCE=$(( $(date +%s) ))
  "$ADB" -s "$SERIAL" shell am start -n "$id/.MainActivity" >/dev/null; sleep 10
  log "RN Android: js-crash, then the launch that reports anything left"
  "$ADB" -s "$SERIAL" shell am broadcast -a dev.ouo.mobilestore.JOURNEY --es cmd action/js-crash >/dev/null
  sleep 6; "$ADB" -s "$SERIAL" shell am start -n "$id/.MainActivity" >/dev/null; sleep 10; "$ADB" -s "$SERIAL" shell am force-stop "$id"
  SINCE=$(( $(date +%s) - SINCE + 2 ))  # only records of this run
  resolve mobile-store "ouo symbolication e2e" rn-android || { FAILED+=(rn-android); return; }
  rn_check rn-android
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    native-ios) native_ios ;;
    rn-ios) rn_ios ;;
    rn-android) rn_android ;;
  esac
done
if [[ ${#FAILED[@]} -gt 0 ]]; then log "FAILED: ${FAILED[*]} (out $OUT)"; exit 1; fi
log "all passed: ${TARGETS[*]} (out $OUT)"
