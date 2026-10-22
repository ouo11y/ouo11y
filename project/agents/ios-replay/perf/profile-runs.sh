#!/usr/bin/env bash
# Per-capture main-thread time on the simulator: the sentry-mobile perf journey (scripts/perf/run.sh,
# unchanged) with Instruments' Time Profiler attached, then capture_stalls.py on the export.
#
#   profile-runs.sh --out <dir> --app <sentrydemo.app dir with its .dSYM next to it> [--rounds 3]
#                   [--mode both-replay] [--device <udid>]
#
# Installs the given build first, so a before/after pair runs on the same simulator and stack.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PERF="$HERE/../../../../examples/sentry-mobile/scripts/perf"
DEVICE=9F8C59BD-F745-4B41-91F9-4674A6B0FA7B
ROUNDS=3
MODE=both-replay
OUT=""
APP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    --app) APP="$2"; shift ;;
    --rounds) ROUNDS="$2"; shift ;;
    --mode) MODE="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$APP" ]] || { echo "--out and --app are required" >&2; exit 2; }
mkdir -p "$OUT"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
log() { printf '%s [profile] %s\n' "$(date +%H:%M:%S)" "$*"; }

xcrun simctl install "$DEVICE" "$APP/sentrydemo.app"
for ((r = 1; r <= ROUNDS; r++)); do
  dir="$OUT/round$r"
  mkdir -p "$dir"
  log "round $r: journey ($MODE) with Time Profiler"
  "$PERF/run.sh" --out "$dir" --runs 1 --modes "$MODE" --device "$DEVICE" >"$dir/run.log" 2>&1 &
  runner=$!
  # XCUITest launches the app (sometimes twice in a row), and other simulators may run sentrydemo
  # too: attach to the process on this simulator once it has stayed alive for 3 s. Attaching (not
  # --all-processes) matters: xctrace cannot symbolicate a process that starts after recording
  # began. 80 s keeps the recording inside the 95 s journey, so the app is alive when it ends.
  for _ in $(seq 1 600); do grep -q "mode $MODE" "$dir/run.log" 2>/dev/null && break; sleep 0.5; done
  sleep 3
  pid=""; stable=0
  for _ in $(seq 1 240); do
    cur=$(pgrep -f "$DEVICE/.*/sentrydemo.app/sentrydemo$" | tail -1 || true)
    if [[ -n "$cur" && "$cur" == "$pid" ]]; then stable=$((stable + 1)); else stable=0; pid=$cur; fi
    [[ $stable -ge 6 ]] && break
    sleep 0.5
  done
  if [[ -z "$pid" ]]; then log "  app never started"; wait "$runner" || true; continue; fi
  xcrun xctrace record --template 'Time Profiler' --device "$DEVICE" --attach "$pid" --time-limit 80s \
    --output "$dir/tp.trace" >"$dir/xctrace.log" 2>&1 || log "  xctrace exit $?"
  wait "$runner" || log "  run.sh exit $?"
  xcrun xctrace symbolicate --input "$dir/tp.trace" --dsym "$APP/sentrydemo.app.dSYM" --output "$dir/tps.trace" >/dev/null 2>&1 \
    || cp -R "$dir/tp.trace" "$dir/tps.trace"
  xcrun xctrace export --input "$dir/tps.trace" \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' >"$dir/tps.xml"
  sampled=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$dir/$MODE/run1/samples.json")
  [[ "$sampled" == "$pid" ]] || log "  WARNING: profiled pid $pid, sampler measured pid $sampled"
  python3 -I "$HERE/capture_stalls.py" "$dir/tps.xml" --process "pid: $pid" --json "$dir/stalls.json" | tee "$dir/stalls.txt"
  rm -rf "$dir/tp.trace"
done
log "done: $OUT"
