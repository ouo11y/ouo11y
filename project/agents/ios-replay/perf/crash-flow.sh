#!/usr/bin/env bash
# Native crash end to end on a simulator with examples/sentry-mobile (built with OUO_PERF=1, so
# Documents/perf-mode.json picks the SDK mix per launch): launch, crash through the demo's deep
# link, relaunch, then read the crashed session back from rum-api and Loki.
#
#   crash-flow.sh --env <ouo-env> --device <udid> [--mode parallel|ouo] [--action native-crash|js-fatal] [--out <dir>]
#
# Prints the crashed session id, its rum-api record (status, end_reason, ended_at, crash_count) and
# the exception records Loki holds for it.
set -euo pipefail
ENV=""; DEVICE=""; MODE=parallel; ACTION=native-crash; OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --mode) MODE="$2"; shift ;;
    --action) ACTION="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$ENV" && -n "$DEVICE" ]] || { echo "--env and --device are required" >&2; exit 2; }
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
BUNDLE=dev.ouo.sentrydemo
RUM="http://rum-api.$ENV.ouo.localhost"
LOKI="http://loki.$ENV.ouo.localhost"
log() { printf '%s [crash-flow] %s\n' "$(date +%H:%M:%S)" "$*"; }

case "$MODE" in
  parallel) MODE_JSON='{"mode":"parallel"}' ;;
  ouo) MODE_JSON='{"mode":"ouo"}' ;;
  *) echo "mode must be parallel or ouo" >&2; exit 2 ;;
esac

xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
data=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)
mkdir -p "$data/Documents"
echo "$MODE_JSON" >"$data/Documents/perf-mode.json"
t0=$(python3 -c 'import time; print(int(time.time()*1e9))')

log "launch 1 ($MODE), $ACTION after 12 s (XCUITest)"
# `simctl openurl` stops at iOS 27's "Open in …?" sheet, and the UI test runner terminates the app
# when it starts: a one-test XCUITest (crashtap/) launches the app, waits, opens the link and
# confirms the sheet.
HERE="$(cd "$(dirname "$0")" && pwd)"
CT="$HERE/crashtap/build"
if [[ ! -d "$CT/dd/Build/Products" ]]; then
  GEM_HOME=/opt/homebrew/Cellar/cocoapods/1.17.0/libexec /opt/homebrew/opt/ruby/bin/ruby "$HERE/crashtap/make.rb" >/dev/null
  xcodebuild build-for-testing -project "$CT/OpenURL.xcodeproj" -scheme OpenURL -destination "id=$DEVICE" -derivedDataPath "$CT/dd" >"$CT/build.log" 2>&1
fi
TEST_RUNNER_OUO_URL="sentrydemo://action/$ACTION" TEST_RUNNER_OUO_WAIT=12 xcodebuild test-without-building \
  -xctestrun "$(ls "$CT"/dd/Build/Products/*.xctestrun | head -1)" -destination "id=$DEVICE" >"$OUT/openurl.log" 2>&1 || true
if pgrep -f "$DEVICE/.*/sentrydemo.app/sentrydemo$" >/dev/null; then log "app still alive after $ACTION"; exit 1; fi
log "app died"
ls "$data/Library/Application Support/ouo/crash/" 2>/dev/null | sed 's/^/  report dir: /' || true
cp "$data/Library/Application Support/ouo/crash/report.json" "$OUT/report.json" 2>/dev/null || log "  no ouo report on disk"
sleep 2

log "launch 2 (sends the report)"
xcrun simctl launch "$DEVICE" "$BUNDLE" >/dev/null
sleep 20
[[ -e "$data/Library/Application Support/ouo/crash/report.json" ]] && log "  report still on disk" || log "  report taken"

t1=$(python3 -c 'import time; print(int(time.time()*1e9))')
q='{service_name=~".+", event_name="exception"} | ouo_exception_fatal="true"'
curl -sG "$LOKI/loki/api/v1/query_range" --data-urlencode "query=$q" --data-urlencode "start=$t0" --data-urlencode "end=$t1" \
  --data-urlencode limit=50 >"$OUT/loki-fatal.json"
python3 -I - "$OUT/loki-fatal.json" <<'EOF' | tee "$OUT/fatal.txt"
import json, sys
d = json.load(open(sys.argv[1]))
for r in d["data"]["result"]:
    s = r["stream"]
    for ts, _ in r["values"]:
        print(f"exception ts={ts} session={s.get('session_id')} kind={s.get('ouo_exception_kind')} service={s.get('service_name')} "
              f"type={s.get('exception_type')} message={s.get('exception_message')!r} crash_ts={s.get('ouo_crash_timestamp')}")
        print("  " + (s.get("exception_stacktrace") or "").replace("\n", "\n  ")[:1500])
EOF
sid=$(python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
ids=[r["stream"].get("session_id") for r in d["data"]["result"] if r["stream"].get("service_name")=="sentry-demo" or True]
print(ids[0] if ids else "")' "$OUT/loki-fatal.json")
echo "$sid" >"$OUT/session_id"
if [[ -n "$sid" ]]; then
  log "crashed session $sid"
  curl -s -H "Authorization: Bearer ${OUO_READ_TOKEN:-rt_dev_0000000000000000}" "$RUM/v1/sessions/$sid" >"$OUT/session.json" || true
  python3 -I -c 'import json,sys
s=json.load(open(sys.argv[1])); s=s.get("session", s)
print({k: s.get(k) for k in ("session_id","service_name","status","state","end_reason","started_at","ended_at","error_count","crash_count")})' "$OUT/session.json" | tee "$OUT/session.txt"
  q2='{service_name=~".+", event_name="session.end"} | session_id="'"$sid"'"'
  curl -sG "$LOKI/loki/api/v1/query_range" --data-urlencode "query=$q2" --data-urlencode "start=$t0" --data-urlencode "end=$t1" >"$OUT/loki-end.json"
  python3 -I -c 'import json,sys
for r in json.load(open(sys.argv[1]))["data"]["result"]:
  s=r["stream"]; print("session.end", s.get("ouo_session_end_reason"), "ended_at", s.get("ouo_session_ended_at"))' "$OUT/loki-end.json" | tee -a "$OUT/session.txt"
fi
log "out: $OUT"
