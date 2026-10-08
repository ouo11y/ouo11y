#!/usr/bin/env bash
# End-to-end smoke test for the local stack:
#   1. CORS preflight on the collector OTLP/HTTP receiver (browser origin)
#   2. one trace, one log record, one metric sent as OTLP/JSON to the collector
#   3. the trace is found in Tempo, the log in Loki, the metric in Mimir
# Exits non-zero on the first failure. Honors OUO_*_PORT from deploy/docker/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

OTLP="http://localhost:${OUO_OTLP_HTTP_PORT:-4318}"
LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
ORIGIN="${OUO_SMOKE_ORIGIN:-http://localhost:5173}"
SESSION_ID="${OUO_SMOKE_SESSION:-smoke-session}"
SERVICE="${OUO_SMOKE_SERVICE:-smoke}"
WAIT="${OUO_SMOKE_WAIT:-60}"

"$SCRIPT_DIR/wait-ready.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# --- 1. CORS preflight ---------------------------------------------------------
preflight=$(curl -s -i -X OPTIONS "$OTLP/v1/traces" \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,traceparent,baggage")
echo "$preflight" | grep -qi "^access-control-allow-origin: $ORIGIN" \
  || fail "CORS preflight did not return Access-Control-Allow-Origin: $ORIGIN"$'\n'"$preflight"
echo "$preflight" | grep -qi "^access-control-allow-headers:" \
  || fail "CORS preflight did not return Access-Control-Allow-Headers"$'\n'"$preflight"
pass "CORS preflight for $ORIGIN"

# --- 2. send OTLP/JSON ---------------------------------------------------------
now_ns=$(python3 -c 'import time; print(time.time_ns())')
start_ns=$((now_ns - 50000000))
trace_id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
span_id=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
run_id="$(date +%s)"

post() { # $1 signal path, $2 body
  local code
  code=$(curl -s -o /tmp/ouo-smoke-resp -w '%{http_code}' -X POST "$OTLP/$1" \
    -H "Content-Type: application/json" -H "Origin: $ORIGIN" --data-binary "$2")
  [[ "$code" == "200" ]] || fail "POST $1 returned $code: $(cat /tmp/ouo-smoke-resp)"
  pass "POST $1 accepted (run_id=$run_id)"
}

resource='{"attributes":[
  {"key":"service.name","value":{"stringValue":"'"$SERVICE"'"}},
  {"key":"service.version","value":{"stringValue":"0.0.1"}},
  {"key":"deployment.environment.name","value":{"stringValue":"local"}},
  {"key":"ouo.platform","value":{"stringValue":"web"}}]}'

post v1/traces '{"resourceSpans":[{"resource":'"$resource"',"scopeSpans":[{"scope":{"name":"ouo.smoke"},"spans":[{
  "traceId":"'"$trace_id"'","spanId":"'"$span_id"'","name":"smoke GET /api/products","kind":3,
  "startTimeUnixNano":"'"$start_ns"'","endTimeUnixNano":"'"$now_ns"'",
  "attributes":[
    {"key":"session.id","value":{"stringValue":"'"$SESSION_ID"'"}},
    {"key":"user.id","value":{"stringValue":"smoke-user"}},
    {"key":"ouo.platform","value":{"stringValue":"web"}},
    {"key":"http.request.method","value":{"stringValue":"GET"}},
    {"key":"ouo.smoke.run_id","value":{"stringValue":"'"$run_id"'"}}],
  "status":{"code":1}}]}]}]}'

post v1/logs '{"resourceLogs":[{"resource":'"$resource"',"scopeLogs":[{"scope":{"name":"ouo.smoke"},"logRecords":[{
  "timeUnixNano":"'"$now_ns"'","observedTimeUnixNano":"'"$now_ns"'",
  "severityNumber":9,"severityText":"INFO","eventName":"session.start",
  "body":{"stringValue":"session.start"},
  "traceId":"'"$trace_id"'","spanId":"'"$span_id"'",
  "attributes":[
    {"key":"event.name","value":{"stringValue":"session.start"}},
    {"key":"session.id","value":{"stringValue":"'"$SESSION_ID"'"}},
    {"key":"user.id","value":{"stringValue":"smoke-user"}},
    {"key":"ouo.platform","value":{"stringValue":"web"}},
    {"key":"ouo.session.started_at","value":{"stringValue":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}},
    {"key":"ouo.smoke.run_id","value":{"stringValue":"'"$run_id"'"}}]}]}]}]}'

post v1/metrics '{"resourceMetrics":[{"resource":'"$resource"',"scopeMetrics":[{"scope":{"name":"ouo.smoke"},"metrics":[{
  "name":"ouo_smoke_requests","description":"smoke counter","unit":"1",
  "sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{
    "startTimeUnixNano":"'"$start_ns"'","timeUnixNano":"'"$now_ns"'","asInt":"1",
    "attributes":[{"key":"ouo.platform","value":{"stringValue":"web"}},{"key":"run_id","value":{"stringValue":"'"$run_id"'"}}]}]}}]}]}]}'

# --- 3. query back -------------------------------------------------------------
retry() { # $1 label, $2 command (string, eval'd); passes when it prints non-empty output
  local label="$1" cmd="$2" deadline=$((SECONDS + WAIT)) out=""
  while true; do
    out=$(eval "$cmd" 2>/dev/null || true)
    if [[ -n "$out" ]]; then pass "$label -> $out"; return 0; fi
    (( SECONDS >= deadline )) && fail "$label: nothing found after ${WAIT}s"
    sleep 3
  done
}

retry "tempo search by session.id" \
  "curl -s -G '$TEMPO/api/search' --data-urlencode 'q={ span.session.id = \"$SESSION_ID\" && span.ouo.smoke.run_id = \"$run_id\" }' --data-urlencode 'limit=5' \
   | python3 -c 'import sys,json; t=json.load(sys.stdin).get(\"traces\",[]); print(t[0][\"traceID\"] if t else \"\")'"

retry "tempo trace by id" \
  "curl -s -o /dev/null -w '%{http_code}' '$TEMPO/api/traces/$trace_id' | grep -x 200"

start_s=$(( now_ns / 1000000000 - 300 )); end_s=$(( now_ns / 1000000000 + 300 ))
retry "loki query {service_name=\"$SERVICE\", event_name=\"session.start\"} | session_id=\"$SESSION_ID\"" \
  "curl -s -G '$LOKI/loki/api/v1/query_range' --data-urlencode 'query={service_name=\"$SERVICE\", event_name=\"session.start\", ouo_platform=\"web\"} | session_id=\"$SESSION_ID\" | ouo_smoke_run_id=\"$run_id\"' --data-urlencode 'start=$start_s' --data-urlencode 'end=$end_s' --data-urlencode 'limit=5' \
   | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"data\"][\"result\"]; print(json.dumps(r[0][\"stream\"]) if r else \"\")'"

# Mimir runs with otel_metric_suffixes_enabled=false, so the counter keeps its OTLP name (no _total).
retry "mimir query ouo_smoke_requests{run_id=\"$run_id\"}" \
  "curl -s -G '$MIMIR/prometheus/api/v1/query' --data-urlencode 'query=ouo_smoke_requests{run_id=\"$run_id\"}' \
   | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"data\"][\"result\"]; print(r[0][\"value\"][1]+\" \"+json.dumps(r[0][\"metric\"]) if r else \"\")'"

echo "SMOKE OK: trace_id=$trace_id session.id=$SESSION_ID service=$SERVICE run_id=$run_id"
