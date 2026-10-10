#!/usr/bin/env bash
# End-to-end smoke test for the local stack (ADR-0007 ingest path):
#   1. rum-api CORS: preflight from an allowed browser origin is answered, from a foreign
#      origin it is not; the collector itself answers no browser preflight any more
#   2. rum-api auth: no token -> 401, wrong token -> 401, token + disallowed Origin -> 403
#   3. one trace, one log record, one metric sent as OTLP/JSON to rum-api
#      POST /ingest/otlp/v1/{traces,logs,metrics} with X-Ouo-Project-Token
#   4. the trace is found in Tempo (stamped ouo.project.id), the log in Loki, the metric in Mimir
# Exits non-zero on the first failure. Honors OUO_* from deploy/docker/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

RUM="${OUO_RUM_API:-http://localhost:${OUO_RUM_API_PORT:-8080}}"
INGEST="$RUM/ingest/otlp"
OTLP="http://127.0.0.1:${OUO_OTLP_HTTP_PORT:-4318}"     # collector, loopback only; used for a negative check
LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
PROJECT_ID="${OUO_PROJECT_ID:-demo}"
TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
ORIGIN="${OUO_SMOKE_ORIGIN:-http://localhost:5173}"
BAD_ORIGIN="${OUO_SMOKE_BAD_ORIGIN:-https://evil.example}"
SESSION_ID="${OUO_SMOKE_SESSION:-smoke-session}"
SERVICE="${OUO_SMOKE_SERVICE:-smoke}"
WAIT="${OUO_SMOKE_WAIT:-60}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

"$SCRIPT_DIR/wait-ready.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

preflight() { # $1 url, $2 origin -> prints response headers
  curl -s -i -X OPTIONS "$1" \
    -H "Origin: $2" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type,content-encoding,x-ouo-project-token,traceparent,baggage"
}
has_header() { # $1 response, $2 header name (lowercase), optional $3 exact value
  if [[ $# -ge 3 ]]; then printf '%s' "$1" | grep -qi "^$2: $3"; else printf '%s' "$1" | grep -qi "^$2:"; fi
}

# --- 1. CORS at rum-api, per project ------------------------------------------------
resp=$(preflight "$INGEST/v1/traces" "$ORIGIN")
has_header "$resp" access-control-allow-origin "$ORIGIN" \
  || fail "rum-api preflight for allowed origin $ORIGIN lacks Access-Control-Allow-Origin"$'\n'"$resp"
has_header "$resp" access-control-allow-headers \
  || fail "rum-api preflight lacks Access-Control-Allow-Headers"$'\n'"$resp"
printf '%s' "$resp" | grep -i "^access-control-allow-headers:" | grep -qi "x-ouo-project-token" \
  || fail "rum-api preflight does not allow the X-Ouo-Project-Token header"$'\n'"$resp"
pass "rum-api preflight for allowed origin $ORIGIN"

resp=$(preflight "$INGEST/v1/traces" "$BAD_ORIGIN")
has_header "$resp" access-control-allow-origin \
  && fail "rum-api preflight for foreign origin $BAD_ORIGIN returned Access-Control-Allow-Origin"$'\n'"$resp"
pass "rum-api preflight for foreign origin $BAD_ORIGIN has no Access-Control-Allow-Origin"

resp=$(preflight "$OTLP/v1/traces" "$ORIGIN" || true)
has_header "$resp" access-control-allow-origin \
  && fail "collector at $OTLP still answers browser preflights (CORS block must be gone)"$'\n'"$resp"
pass "collector answers no browser preflight (browsers must use rum-api)"

# --- 2. token and origin checks --------------------------------------------------------
empty='{"resourceSpans":[]}'
code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$INGEST/v1/traces" -H "Content-Type: application/json" --data-binary "$empty")
[[ "$code" == "401" ]] || fail "POST without token returned $code, want 401: $(cat "$TMP/r")"
pass "POST without X-Ouo-Project-Token -> 401"

code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$INGEST/v1/traces" -H "Content-Type: application/json" \
  -H "X-Ouo-Project-Token: pt_wrong_$(date +%s)" --data-binary "$empty")
[[ "$code" == "401" ]] || fail "POST with unknown token returned $code, want 401: $(cat "$TMP/r")"
pass "POST with unknown token -> 401"

code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$INGEST/v1/traces" -H "Content-Type: application/json" \
  -H "X-Ouo-Project-Token: $TOKEN" -H "Origin: $BAD_ORIGIN" --data-binary "$empty")
[[ "$code" == "403" ]] || fail "POST with valid token from $BAD_ORIGIN returned $code, want 403: $(cat "$TMP/r")"
pass "POST with valid token from foreign origin -> 403"

# --- 3. send OTLP/JSON through rum-api --------------------------------------------------
now_ns=$(python3 -c 'import time; print(time.time_ns())')
start_ns=$((now_ns - 50000000))
trace_id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
span_id=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
run_id="$(date +%s)"

post() { # $1 signal path, $2 body
  local code
  code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$INGEST/$1" \
    -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "X-Ouo-Project-Token: $TOKEN" --data-binary "$2")
  [[ "$code" == "200" ]] || fail "POST $1 returned $code: $(cat "$TMP/r")"
  pass "POST $1 accepted via rum-api (run_id=$run_id)"
}

# Note: the client sets ouo.project.id=spoofed; rum-api must overwrite it with the
# project the token belongs to (ADR-0007 section 4.6). Asserted below in Tempo and Loki.
resource='{"attributes":[
  {"key":"service.name","value":{"stringValue":"'"$SERVICE"'"}},
  {"key":"service.version","value":{"stringValue":"0.0.1"}},
  {"key":"deployment.environment.name","value":{"stringValue":"local"}},
  {"key":"ouo.project.id","value":{"stringValue":"spoofed"}},
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

# --- 4. query back -----------------------------------------------------------------------
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

# The project id is a resource attribute set by rum-api, so it is searchable with the
# `resource.` scope; the client-sent value (spoofed) must be gone.
retry "tempo search by resource.ouo.project.id=$PROJECT_ID" \
  "curl -s -G '$TEMPO/api/search' --data-urlencode 'q={ resource.ouo.project.id = \"$PROJECT_ID\" && span.ouo.smoke.run_id = \"$run_id\" }' --data-urlencode 'limit=5' \
   | python3 -c 'import sys,json; t=json.load(sys.stdin).get(\"traces\",[]); print(t[0][\"traceID\"] if t else \"\")'"

retry "tempo trace by id carries ouo.project.id=$PROJECT_ID" \
  "curl -s '$TEMPO/api/traces/$trace_id' | python3 -c '
import sys, json
def walk(o, acc):
    if isinstance(o, dict):
        if o.get(\"key\") == \"ouo.project.id\": acc.append(o.get(\"value\", {}).get(\"stringValue\"))
        for v in o.values(): walk(v, acc)
    elif isinstance(o, list):
        for v in o: walk(v, acc)
acc = []
try: walk(json.load(sys.stdin), acc)
except Exception: pass
print(\"ouo.project.id=\" + acc[0] if acc and all(a == \"$PROJECT_ID\" for a in acc) else \"\")'"

start_s=$(( now_ns / 1000000000 - 300 )); end_s=$(( now_ns / 1000000000 + 300 ))
retry "loki query {service_name=\"$SERVICE\", event_name=\"session.start\"} | session_id=\"$SESSION_ID\" | ouo_project_id=\"$PROJECT_ID\"" \
  "curl -s -G '$LOKI/loki/api/v1/query_range' --data-urlencode 'query={service_name=\"$SERVICE\", event_name=\"session.start\", ouo_platform=\"web\"} | session_id=\"$SESSION_ID\" | ouo_smoke_run_id=\"$run_id\" | ouo_project_id=\"$PROJECT_ID\"' --data-urlencode 'start=$start_s' --data-urlencode 'end=$end_s' --data-urlencode 'limit=5' \
   | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"data\"][\"result\"]; print(json.dumps(r[0][\"stream\"]) if r else \"\")'"

# Mimir runs with otel_metric_suffixes_enabled=false, so the counter keeps its OTLP name (no _total).
retry "mimir query ouo_smoke_requests{run_id=\"$run_id\"}" \
  "curl -s -G '$MIMIR/prometheus/api/v1/query' --data-urlencode 'query=ouo_smoke_requests{run_id=\"$run_id\"}' \
   | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"data\"][\"result\"]; print(r[0][\"value\"][1]+\" \"+json.dumps(r[0][\"metric\"]) if r else \"\")'"

echo "SMOKE OK: trace_id=$trace_id session.id=$SESSION_ID service=$SERVICE project=$PROJECT_ID run_id=$run_id"
