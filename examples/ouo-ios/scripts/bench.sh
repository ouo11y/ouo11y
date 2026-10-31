#!/bin/sh
# B3 cells for the native app (docs/benchmarks.md): `none` (OUO_OFF=1, the SDK not started) and
# `ouo` (the example's config: replay on, masking on) on the same simulator, alternating per round,
# 40 s of the `bench` journey each, sampled from the host by examples/sentry-mobile/scripts/perf/
# sample.py. bench.py prints the paired median deltas and writes results.json.
# Usage: scripts/bench.sh <env> <simulator udid> <out dir> [rounds, default 10]
set -eu
ENV=$1
UDID=$2
OUT=$3
ROUNDS=${4:-10}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SAMPLE="$ROOT/examples/sentry-mobile/scripts/perf/sample.py"
APP=dev.ouo.example.ios
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV")"
mkdir -p "$OUT"
BUNDLE=$("$HERE/scripts/build.sh" "$OUT" | tail -1)
xcrun simctl uninstall "$UDID" "$APP" 2>/dev/null || true
xcrun simctl install "$UDID" "$BUNDLE"
cell() { # <cell> <round>
  python3 -I "$SAMPLE" --exe OuoExample.app/OuoExample --out "$OUT/$1-$2.json" --seconds 40 --interval 0.5 &
  S=$!
  sleep 1
  OFF=0; [ "$1" = none ] && OFF=1
  SIMCTL_CHILD_OUO_OFF=$OFF SIMCTL_CHILD_OUO_ACTION=bench SIMCTL_CHILD_OUO_OTLP=$OUO_OTLP_URL SIMCTL_CHILD_OUO_REPLAY=$OUO_REPLAY_URL xcrun simctl launch "$UDID" "$APP" >/dev/null
  wait $S
  xcrun simctl terminate "$UDID" "$APP" 2>/dev/null || true
  C=$(xcrun simctl get_app_container "$UDID" "$APP" data)
  mv "$C/Documents/journey.jsonl" "$OUT/$1-$2.notes.jsonl"
  sleep 2
}
for r in $(seq 1 "$ROUNDS"); do
  if [ $((r % 2)) -eq 1 ]; then cell none "$r"; cell ouo "$r"; else cell ouo "$r"; cell none "$r"; fi
done
python3 -I "$HERE/scripts/bench.py" "$OUT" "$ROUNDS"
