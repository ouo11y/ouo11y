#!/bin/bash
# Runs the measurements on one simulator. Needs scripts/build.sh first.
#   scripts/run.sh <udid> <out dir> [init launches per variant, 12] [journey rounds, 6]
# Starts capture.py itself (ports 47100..47103) and stops it (its own PID) at the end.
set -eu
W=$(cd "$(dirname "$0")/.." && pwd)
UDID=$1; OUT=$2; INITN=${3:-12}; ROUNDS=${4:-6}
SINK=http://127.0.0.1:47100
mkdir -p "$OUT/init" "$OUT/journey"
python3 -I "$W/scripts/capture.py" --base 47100 --log "$OUT/requests.jsonl" > "$OUT/capture.out" 2>&1 &
CAP=$!
trap 'kill $CAP 2>/dev/null || true' EXIT
sleep 1
VARIANTS=(base ouo ouo_replay sentry sentry_replay)
bid() { case $1 in base) echo dev.step5.base;; ouo*) echo dev.step5.ouo;; sentry*) echo dev.step5.sentry;; esac; }
app() { case $1 in base) echo base;; ouo*) echo ouo;; sentry*) echo sentry;; esac; }
rep() { case $1 in *_replay) echo 1;; *) echo 0;; esac; }
fresh() { # uninstall + install: an empty container (no queue, session or cache left over)
  xcrun simctl uninstall "$UDID" "$(bid $1)" 2>/dev/null || true
  xcrun simctl install "$UDID" "$W/build/$(app $1)/sim/Bench.app"
}
launch() { # <variant> <action> -> prints PID
  SIMCTL_CHILD_STEP5_ACTION=$2 SIMCTL_CHILD_STEP5_REPLAY=$(rep $1) SIMCTL_CHILD_STEP5_SINK=$SINK \
    xcrun simctl launch --terminate-running-process "$UDID" "$(bid $1)" | awk '{print $NF}'
}
collect() { # <variant> <dest>
  C=$(xcrun simctl get_app_container "$UDID" "$(bid $1)" data)
  cp "$C/Documents/step5.jsonl" "$2" 2>/dev/null || echo '{"kind":"missing"}' > "$2"
}
rot() { # round-robin, rotated by round
  local r=$1 n=${#VARIANTS[@]} i
  for i in $(seq 0 $((n - 1))); do echo "${VARIANTS[$(( (i + r) % n ))]}"; done
}
# Warm-up (not recorded): one launch of each app so the first measured launch is not the
# simulator's first launch of that binary.
for v in base ouo sentry; do fresh $v; launch $v init >/dev/null; sleep 4; xcrun simctl terminate "$UDID" "$(bid $v)" || true; done

echo "init: $INITN rounds"
for r in $(seq 1 "$INITN"); do
  for v in $(rot $r); do
    fresh $v
    sleep 1
    echo "$(date +%s.%N) start init $v $r" >> "$OUT/marks.log"
    PID=$(launch $v init)
    sleep 5
    xcrun simctl terminate "$UDID" "$(bid $v)" || true
    collect $v "$OUT/init/$v-$r.jsonl"
  done
done

echo "journey: $ROUNDS rounds"
for r in $(seq 1 "$ROUNDS"); do
  for v in $(rot $r); do
    fresh $v
    sleep 2
    T0=$(python3 -c 'import time;print(time.time())')
    PID=$(launch $v journey)
    python3 -I "$W/scripts/sample.py" --pid "$PID" --out "$OUT/journey/$v-$r.json" --seconds 100 --interval 0.5 &
    S=$!
    sleep 85
    # background the app (Settings to the front): both SDKs flush on background
    xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null || true
    sleep 15
    T1=$(python3 -c 'import time;print(time.time())')
    wait $S || true
    collect $v "$OUT/journey/$v-$r.jsonl"
    xcrun simctl terminate "$UDID" "$(bid $v)" || true
    xcrun simctl terminate "$UDID" com.apple.Preferences || true
    echo "{\"variant\":\"$v\",\"round\":$r,\"t0\":$T0,\"t1\":$T1,\"pid\":$PID}" >> "$OUT/runs.jsonl"
    echo "$v $r done"
    sleep 3
  done
done
