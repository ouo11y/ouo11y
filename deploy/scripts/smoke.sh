#!/usr/bin/env bash
# End-to-end smoke test for the local stack (ADR-0007: the collector is the edge):
#   1. CORS: a browser preflight from an allowed origin against the collector's OTLP port
#      (4318) and replay port (4319) returns the allow headers, including `authorization`
#   2. auth: OTLP without credential -> 401, wrong token -> 401, unknown project -> 401;
#      replay chunk without credential -> 401; the internal rum-api sink refuses a direct
#      post without the ingest token -> 401
#   3. one trace, one log record, one metric sent as OTLP/JSON to the collector
#      POST /v1/{traces,logs,metrics} with `Authorization: Basic base64(project:token)`,
#      plus one replay chunk to POST /v1/replay/chunks on 4319 (202)
#   4. the trace is found in Tempo (stamped ouo.project.id), the log in Loki, the metric
#      in Mimir, and the replay chunk is readable from rum-api with the read token
# Exits non-zero on the first failure. Honors OUO_* from deploy/compose/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../compose/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

OTLP="${OUO_OTLP_URL:-http://localhost:${OUO_OTLP_HTTP_PORT:-4318}}"       # collector OTLP/HTTP (public)
REPLAY="${OUO_REPLAY_URL:-http://localhost:${OUO_REPLAY_PORT:-4319}}"      # collector replay receiver (public)
RUM="${OUO_RUM_API_URL:-${OUO_RUM_API:-http://localhost:${OUO_RUM_API_PORT:-8080}}}"  # internal, read side
LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
PROJECT_ID="${OUO_PROJECT_ID:-demo}"
TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
READ_TOKEN="${OUO_READ_TOKEN:-rt_dev_0000000000000000}"
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
# (the collector's CORS handler rejects unsorted lists, see project/kb/collector-components.md).
# The OTLP SDK exporters send trace context headers; the replay uploaders do not.
OTLP_PREFLIGHT_HEADERS="authorization,baggage,content-encoding,content-type,traceparent"
REPLAY_PREFLIGHT_HEADERS="authorization,content-encoding,content-type"
preflight() { # $1 url, $2 origin -> prints response headers
  local hdrs="$OTLP_PREFLIGHT_HEADERS"
  [[ "$1" == */v1/replay/* ]] && hdrs="$REPLAY_PREFLIGHT_HEADERS"
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

# --- 1. CORS at the collector, both public ports ---------------------------------------
for ep in "$OTLP/v1/traces" "$REPLAY/v1/replay/chunks"; do
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

chunk_min='{"session_id":"x","seq":0,"started_at":1000,"ended_at":2000,"events":[]}'
code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$REPLAY/v1/replay/chunks" -H "Content-Type: application/json" --data-binary "$chunk_min")
[[ "$code" == "401" ]] || fail "replay POST without credential returned $code, want 401: $(cat "$TMP/r")"
pass "replay POST without credential -> 401"

# The internal sink (rum-api) must refuse a direct post without the ingest token. Only
# testable where rum-api's port is published (laptop); skipped when it is unreachable.
code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$RUM/v1/replay/chunks" -H "Content-Type: application/json" \
  -H "X-Ouo-Project-Id: $PROJECT_ID" --data-binary "$chunk_min" || true)
case "$code" in
  401) pass "rum-api internal sink refuses a direct post without the ingest token -> 401" ;;
  000) warn "rum-api not reachable at $RUM (expected on a server); skipping the internal-sink check" ;;
  *) fail "rum-api POST /v1/replay/chunks without ingest token returned $code, want 401: $(cat "$TMP/r")" ;;
esac

# --- 3. send OTLP/JSON and one replay chunk to the collector ---------------------------
now_ns=$(python3 -c 'import time; print(time.time_ns())')
start_ns=$((now_ns - 50000000))
now_ms=$((now_ns / 1000000))
trace_id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
span_id=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
run_id="$(date +%s)"
replay_session="${OUO_SMOKE_REPLAY_SESSION:-smoke-replay-$run_id}"

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

# One rrweb chunk (ADR-0003 shape) through the replay receiver on 4319. The receiver
# answers 202 once the chunk is accepted into the pipeline; the exporter then posts it
# to rum-api with X-Ouo-Project-Id=<auth username> and the ingest token bearer.
chunk='{"session_id":"'"$replay_session"'","seq":0,"started_at":'"$now_ms"',"ended_at":'"$((now_ms + 1000))"',
  "events":[{"type":4,"data":{"href":"http://localhost:5173/"},"timestamp":'"$now_ms"'},{"type":2,"data":{},"timestamp":'"$((now_ms + 1))"'}]}'
code=$(curl -s -o "$TMP/r" -w '%{http_code}' -X POST "$REPLAY/v1/replay/chunks" \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "$AUTH" --data-binary "$chunk")
[[ "$code" == "202" || "$code" == "200" ]] || fail "replay POST with credential returned $code, want 202: $(cat "$TMP/r")"
pass "replay POST /v1/replay/chunks with credential -> $code (session_id=$replay_session)"

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

# Replay: the chunk travelled collector -> ouoreplay exporter -> rum-api and is readable
# with the read token; meta records the authenticated project.
code=$(curl -s -o /dev/null -w '%{http_code}' "$RUM/v1/sessions/$replay_session/replay" || true)
if [[ "$code" == "000" ]]; then
  warn "rum-api not reachable at $RUM; skipping the replay read-back"
else
  [[ "$code" == "401" ]] || fail "GET /v1/sessions/{id}/replay without read token returned $code, want 401"
  pass "rum-api GET /v1/sessions/{id}/replay without read token -> 401"
  retry "rum-api GET /v1/sessions/$replay_session/replay (read token) has the chunk with project_id=$PROJECT_ID" \
    "curl -s -H 'Authorization: Bearer $READ_TOKEN' '$RUM/v1/sessions/$replay_session/replay' \
     | python3 -c 'import sys,json; m=json.load(sys.stdin); print(\"kind=%s chunks=%s project_id=%s\" % (m.get(\"kind\"), m.get(\"chunk_count\"), m.get(\"project_id\")) if m.get(\"chunk_count\",0) >= 1 and m.get(\"project_id\") == \"$PROJECT_ID\" else \"\")'"
fi

echo "SMOKE OK: trace_id=$trace_id session.id=$SESSION_ID replay_session=$replay_session service=$SERVICE project=$PROJECT_ID run_id=$run_id"
