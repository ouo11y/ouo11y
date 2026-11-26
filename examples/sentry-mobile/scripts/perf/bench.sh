#!/usr/bin/env bash
# One benchmark run end to end (docs/benchmarks.md): build, size attribution, every cell, result,
# report, trend page.
#
#   scripts/perf/bench.sh --env <ouo-env> [--target sim|device] [--device <udid>] [--team <TEAM_ID>]
#                         [--runs 10] [--ouo workspace|<version>] [--sentry latest|pinned|<version>]
#                         [--work <dir>] [--publish <reports dir>] [--sink] [-- <extra bench.py flags>]
#
# Raw runs go to --work (default ~/.cache/ouo-bench/<name>); the published folder
# <publish>/<date>-ouo-<ver>-vs-sentry-<ver>[-sim]/ gets result.json, report.html, configs/ and
# size.json. --publish defaults to project/reports/benchmarks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
ENV_NAME=""; TARGET=sim; DEVICE=""; TEAM=""; RUNS=10; OUO=workspace; SENTRY=latest; WORK=""; PUBLISH="$REPO/project/reports/benchmarks"; SINK=()
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --target) TARGET="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --team) TEAM="$2"; shift ;;
    --runs) RUNS="$2"; shift ;;
    --ouo) OUO="$2"; shift ;;
    --sentry) SENTRY="$2"; shift ;;
    --work) WORK="$2"; shift ;;
    --publish) PUBLISH="$2"; shift ;;
    --sink) SINK=(--sink) ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$ENV_NAME" ]] || { echo "--env is required" >&2; exit 2; }
log() { printf '%s [bench.sh] %s\n' "$(date +%H:%M:%S)" "$*"; }

stamp=$(date +%Y%m%d-%H%M%S)
WORK=${WORK:-$HOME/.cache/ouo-bench/$stamp-$TARGET}
mkdir -p "$WORK"
dev_args=()
[[ -n "$DEVICE" ]] && dev_args+=(--device "$DEVICE")
[[ -n "$TEAM" ]] && dev_args+=(--team "$TEAM")

log "build ($TARGET, ouo $OUO, sentry $SENTRY) -> $WORK/build"
"$HERE/build.sh" --out "$WORK/build" --target "$TARGET" ${dev_args[@]+"${dev_args[@]}"} --ouo "$OUO" --sentry "$SENTRY"
python3 -I "$HERE/size.py" --build "$WORK/build" --json "$WORK/size.json"

log "bench -> $WORK/runs"
python3 -I "$HERE/bench.py" --env "$ENV_NAME" --app "$WORK/build/sentrydemo.app" --out "$WORK/runs" --target "$TARGET" \
  ${dev_args[@]+"${dev_args[@]}"} --runs "$RUNS" ${SINK[@]+"${SINK[@]}"} ${EXTRA[@]+"${EXTRA[@]}"}

ouo_v=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["@ouo11y/react-native"])' "$WORK/build/versions.json")
sentry_v=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["@sentry/react-native"])' "$WORK/build/versions.json")
suffix=""; [[ $TARGET == sim ]] && suffix="-sim"
DEST="$PUBLISH/$(date +%Y-%m-%d)-ouo-$ouo_v-vs-sentry-$sentry_v$suffix"
mkdir -p "$DEST/configs"
python3 -I "$HERE/bench_result.py" --out "$WORK/runs" --size "$WORK/size.json" --json "$DEST/result.json"
cp "$WORK/size.json" "$DEST/size.json"
# The SDK options of every tier, as the app passes them (src/sentry.ts, src/ouo.ts), and each cell's perf-mode.json.
cp "$HERE/../../src/sentry.ts" "$HERE/../../src/ouo.ts" "$DEST/configs/"
python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["configs"], indent=1))' "$WORK/runs/meta.json" >"$DEST/configs/cells.json"
cp "$WORK/build/versions.json" "$WORK/build/Podfile.lock" "$DEST/configs/"
NOTES=()
[[ -f "$DEST/notes.html" ]] && NOTES=(--notes "$DEST/notes.html")
python3 -I "$HERE/bench_report.py" --result "$DEST/result.json" --out "$DEST/report.html" ${NOTES[@]+"${NOTES[@]}"}
python3 -I "$HERE/bench_trend.py" --dir "$PUBLISH"
log "published $DEST (raw runs in $WORK)"
echo "$DEST"
# A cell with no usable run would pass as free (a replay that never uploaded, an SDK that sent
# nothing): published for the record above, then the benchmark fails.
empty=$(python3 -I -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["empty_cells"]))' "$DEST/result.json")
if [[ -n $empty ]]; then
  log "FAILED: no usable run in cell(s) $empty (PROBLEM lines above, $DEST/report.html)"
  exit 1
fi
