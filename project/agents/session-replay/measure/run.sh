#!/bin/bash
# Runs the replay demo journey (examples/ouo-ios, OUO_ACTION=replaydemo, about 45 s) once per
# recorder per round on one simulator, against sink.py, interleaved and rotated.
#   run.sh <udid> <OuoExample.app> <out dir> [rounds, 3]
# Starts sink.py once per run (its own PID) and stops it after the run.
set -eu
UDID=$1; APP=$2; OUT=$3; ROUNDS=${4:-3}
HERE=$(cd "$(dirname "$0")" && pwd)
BID=dev.ouo.example.ios
VARIANTS=(frames sentry-video)
for r in $(seq 1 "$ROUNDS"); do
  for i in 0 1; do
    v=${VARIANTS[$(( (i + r) % 2 ))]}
    D="$OUT/$v-$r"; mkdir -p "$D"
    python3 -I "$HERE/sink.py" --base 47300 --out "$D" > "$D/sink.out" 2>&1 &
    SINK=$!
    sleep 1
    xcrun simctl uninstall "$UDID" "$BID" 2>/dev/null || true
    xcrun simctl install "$UDID" "$APP"
    sleep 1
    uptime > "$D/load.txt"
    T0=$(python3 -c 'import time;print(time.time())')
    SIMCTL_CHILD_OUO_ACTION=replaydemo SIMCTL_CHILD_OUO_RECORDER=$v \
      SIMCTL_CHILD_OUO_OTLP=http://127.0.0.1:47300 SIMCTL_CHILD_OUO_REPLAY=http://127.0.0.1:47301 \
      SIMCTL_CHILD_OUO_BACKEND=http://127.0.0.1:47300 \
      xcrun simctl launch --terminate-running-process "$UDID" "$BID" > "$D/launch.txt"
    sleep 50
    # Background: both recorders cut and send the open chunk.
    xcrun simctl launch "$UDID" com.apple.Preferences > /dev/null || true
    T1=$(python3 -c 'import time;print(time.time())')
    sleep 10
    C=$(xcrun simctl get_app_container "$UDID" "$BID" data)
    cp "$C/Documents/journey.jsonl" "$D/journey.jsonl" 2>/dev/null || echo '{"step":"missing"}' > "$D/journey.jsonl"
    xcrun simctl terminate "$UDID" "$BID" || true
    xcrun simctl terminate "$UDID" com.apple.Preferences || true
    kill "$SINK" 2>/dev/null || true
    echo "{\"variant\":\"$v\",\"round\":$r,\"t0\":$T0,\"t1\":$T1}" > "$D/run.json"
    echo "$v $r done"
    sleep 3
  done
done
