#!/usr/bin/env bash
# Device-cost measurement of the SDK mixes in examples/sentry-mobile (method: project/kb-archive/sdk-overhead-ios.md).
#
#   scripts/perf/run.sh --out <dir> [--runs 5] [--seconds 95] [--modes "none sentry both both-replay ouo-replay"]
#                       [--device <udid>]
#
# Needs: the app built with OUO_PERF=1 and the proxy ports baked in (see the kb entry),
# installed on --device; scripts/perf/proxy.py running and logging to <dir>/requests.jsonl; the
# stack behind the proxy. Each run: terminate the app, wipe its Library (SDK queues, sessions,
# AsyncStorage: every run starts as a fresh install would), write Documents/perf-mode.json (the
# launch's `ouo.rum.mode`, overriding the flag: src/rollout.ts), start
# the sampler, run the XCUITest journey (real taps, fixed schedule), collect perf.json. Modes are
# interleaved (round-robin, rotated each round) so slow drift on the host spreads over all of them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEVICE="${SIM_UDID:-A99B6BF8-6975-4407-9B59-D38066523B15}"
BUNDLE=dev.ouo.sentrydemo
RUNS=5
SECONDS_PER_RUN=95
MODES="none sentry both both-replay ouo-replay"
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    --runs) RUNS="$2"; shift ;;
    --seconds) SECONDS_PER_RUN="$2"; shift ;;
    --modes) MODES="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$OUT" ]] || { echo "--out is required" >&2; exit 2; }
mkdir -p "$OUT"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

log() { printf '%s [perf] %s\n' "$(date +%H:%M:%S)" "$*"; }

mode_json() {
  case "$1" in
    # Harness mode -> rollout mode (ouo.rum.mode); `none` and the forced replay are perf-only.
    none)        echo '{"mode":"none"}' ;;
    sentry)      echo '{"mode":"sentry"}' ;;
    both)        echo '{"mode":"parallel"}' ;;
    both-replay) echo '{"mode":"parallel","ouoReplay":true}' ;;
    ouo-replay)  echo '{"mode":"ouo"}' ;;
    *) echo "unknown mode $1" >&2; exit 2 ;;
  esac
}

DRIVER="$HERE/driver/build"
if [[ ! -d "$DRIVER/dd/Build/Products" ]]; then
  log "build the XCUITest driver"
  GEM_HOME=/opt/homebrew/Cellar/cocoapods/1.17.0/libexec /opt/homebrew/opt/ruby/bin/ruby "$HERE/make-driver.rb"
  xcodebuild build-for-testing -project "$DRIVER/PerfDriver.xcodeproj" -scheme PerfJourney \
    -destination "id=$DEVICE" -derivedDataPath "$DRIVER/dd" >"$DRIVER/build.log" 2>&1
fi
XCTESTRUN=$(ls "$DRIVER"/dd/Build/Products/*.xctestrun | head -1)

read -r -a mode_list <<<"$MODES"
n=${#mode_list[@]}
for ((round = 1; round <= RUNS; round++)); do
  for ((i = 0; i < n; i++)); do
    mode=${mode_list[$(((i + round - 1) % n))]}
    dir="$OUT/$mode/run$round"
    mkdir -p "$dir"
    log "round $round mode $mode"
    xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
    sleep 2
    data=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)
    rm -rf "$data/Library/Caches" "$data/Library/Application Support" "$data/tmp"/* "$data/Documents/perf.json" "$data/Documents/journey-command"
    mkdir -p "$data/Documents"
    mode_json "$mode" >"$data/Documents/perf-mode.json"
    sleep 3   # let the host settle after the previous run
    python3 -I "$HERE/sample.py" --exe sentrydemo.app/sentrydemo --out "$dir/samples.json" --seconds "$SECONDS_PER_RUN" >"$dir/sample.log" 2>&1 &
    sampler=$!
    TEST_RUNNER_PERF_SECONDS=$((SECONDS_PER_RUN + 1)) xcodebuild test-without-building -xctestrun "$XCTESTRUN" \
      -destination "id=$DEVICE" -only-testing:PerfJourney/PerfJourneyUITests/testJourney >"$dir/xcuitest.log" 2>&1 || log "  xcuitest exit $? (see $dir/xcuitest.log)"
    wait "$sampler" || log "  sampler failed: $(cat "$dir/sample.log")"
    cp "$data/Documents/perf.json" "$dir/perf.json" 2>/dev/null || log "  no perf.json"
    xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
    grep -E '^PERF ' "$dir/xcuitest.log" >"$dir/steps.log" || true
    printf '{"mode":"%s","round":%d,"device":"%s"}\n' "$mode" "$round" "$DEVICE" >"$dir/meta.json"
    log "  $(cat "$dir/sample.log"); steps $(grep -c 'PERF step' "$dir/steps.log" || true)"
  done
done
log "done: $OUT"
