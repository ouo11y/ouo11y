#!/usr/bin/env bash
# End-to-end smoke test for the local stack (ADR-0007: the collector is the edge):
#   1. CORS: a browser preflight from an allowed origin against the collector's OTLP port
#      (4318) returns the allow headers, including `authorization`
#   2. auth: OTLP without credential -> 401, wrong token -> 401, unknown project -> 401
#   3. one trace, one log record, one metric sent as OTLP/JSON to the collector
#      POST /v1/{traces,logs,metrics} with `Authorization: Basic base64(project:token)`
#   4. the trace is found in Tempo (stamped ouo.project.id), the log in Loki, the metric
#      in Mimir (Muninn's readiness is checked by wait-ready.sh)
# Exits non-zero on the first failure. Honors OUO_* from deploy/compose/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../compose/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

OTLP="${OUO_OTLP_URL:-http://localhost:${OUO_OTLP_HTTP_PORT:-4318}}"       # collector OTLP/HTTP (public)
LOKI="${OUO_LOKI_URL:-http://localhost:${OUO_LOKI_PORT:-3100}}"
TEMPO="${OUO_TEMPO_URL:-http://localhost:${OUO_TEMPO_PORT:-3200}}"
MIMIR="${OUO_MIMIR_URL:-http://localhost:${OUO_MIMIR_PORT:-9009}}"
PROJECT_ID="${OUO_PROJECT_ID:-demo}"
TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
ORIGIN="${OUO_SMOKE_ORIGIN:-http://localhost:5173}"
BAD_ORIGIN="${OUO_SMOKE_BAD_ORIGIN:-https://evil.example}"
SESSION_ID="${OUO_SMOKE_SESSION:-smoke-session}"
SERVICE="${OUO_SMOKE_SERVICE:-smoke}"
WAIT="${OUO_SMOKE_WAIT:-60}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

basic() { printf '%s:%s' "$1" "$2" | base64 | tr -d '\n'; }
AUTH="Authorization: Basic $(basic "$PROJECT_ID" "$TOKEN")"

"$SCRIPT_DIR/wait-ready.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }
warn() { echo "warn: $*" >&2; }

# Requested headers are listed the way browsers send them: lowercase and sorted
# (the collector's CORS handler rejects unsorted lists, see project/kb-archive/collector-components.md).
# The OTLP SDK exporters send trace context headers.
OTLP_PREFLIGHT_HEADERS="authorization,baggage,content-encoding,content-type,traceparent"
preflight() { # $1 url, $2 origin -> prints response headers
  local hdrs="$OTLP_PREFLIGHT_HEADERS"
  curl -s -i -X OPTIONS "$1" \
    -H "Origin: $2" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: $hdrs"
}
has_header() { # $1 response, $2 header name (lowercase), optional $3 exact value
  if [[ $# -ge 3 ]]; then printf '%s' "$1" | grep -qi "^$2: $3"; else printf '%s' "$1" | grep -qi "^$2:"; fi
}
header_contains() { # $1 response, $2 header, $3 substring (case-insensitive)
  printf '%s' "$1" | grep -i "^$2:" | grep -qi "$3"
}

# --- 1. CORS at the collector's OTLP port ----------------------------------------------
for ep in "$OTLP/v1/traces"; do
  resp=$(preflight "$ep" "$ORIGIN")
  has_header "$resp" access-control-allow-origin \
    || fail "preflight $ep from $ORIGIN lacks Access-Control-Allow-Origin"$'\n'"$resp"
  has_header "$resp" access-control-allow-headers \
    || fail "preflight $ep lacks Access-Control-Allow-Headers"$'\n'"$resp"
  header_contains "$resp" access-control-allow-headers "authorization" \
    || header_contains "$resp" access-control-allow-headers '\*' \
    || fail "preflight $ep does not allow the Authorization header (Basic credential)"$'\n'"$resp"
  pass "preflight $ep from $ORIGIN allows Authorization"

  resp=$(preflight "$ep" "$BAD_ORIGIN" || true)
  if has_header "$resp" access-control-allow-origin "$BAD_ORIGIN" || has_header "$resp" access-control-allow-origin '\*'; then
    warn "preflight $ep from $BAD_ORIGIN is allowed: the collector's cors.allowed_origins list is wide open (fine on a laptop, not on a server)"
  else
    pass "preflight $ep from $BAD_ORIGIN has no Access-Control-Allow-Origin"
  fi
done

# --- 2. credential checks ---------------------------------------------------------------
empty='{"resourceSpans":[]}'
code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$OTLP/v1/traces" -H "Content-Type: application/json" --data-binary "$empty")
[[ "$code" == "401" ]] || fail "OTLP POST without credential returned $code, want 401: $(cat "$TMP/r")"
pass "OTLP POST without credential -> 401"

code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$OTLP/v1/traces" -H "Content-Type: application/json" \
  -H "Authorization: Basic $(basic "$PROJECT_ID" "pt_wrong_$(date +%s)")" --data-binary "$empty")
[[ "$code" == "401" ]] || fail "OTLP POST with wrong token returned $code, want 401: $(cat "$TMP/r")"
pass "OTLP POST with wrong token -> 401"

code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$OTLP/v1/traces" -H "Content-Type: application/json" \
  -H "Authorization: Basic $(basic "no-such-project" "$TOKEN")" --data-binary "$empty")
[[ "$code" == "401" ]] || fail "OTLP POST with unknown project id returned $code, want 401: $(cat "$TMP/r")"
pass "OTLP POST with unknown project id -> 401"

# --- 3. send OTLP/JSON to the collector -------------------------------------------------
now_ns=$(python3 -c 'import time; print(time.time_ns())')
start_ns=$((now_ns - 50000000))
trace_id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
span_id=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
run_id="$(date +%s)"

post() { # $1 signal path, $2 body
  local code
  code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$OTLP/$1" \
    -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "$AUTH" --data-binary "$2")
  [[ "$code" == "200" ]] || fail "POST $1 returned $code: $(cat "$TMP/r")"
  pass "POST $1 accepted by the collector (run_id=$run_id)"
}

# Note: the client sets ouo.project.id=spoofed; the collector must overwrite it with the
# authenticated project (ADR-0007 section 3). Asserted below in Tempo and Loki.
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

# The project id is a resource attribute set by the collector from the Basic auth
# username, so it is searchable with the `resource.` scope; the client-sent value
# (spoofed) must be gone.
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
