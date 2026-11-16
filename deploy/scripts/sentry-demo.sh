#!/usr/bin/env bash
# Sentry bridge + Muninn + LGTM in one collector: a reproducible demo on an ouo-env stack.
#
#   deploy/envs/ouo-env up <env> --muninn            # collector: config.muninn.yaml + config.muninn-sentry.yaml
#   deploy/scripts/sentry-demo.sh --env <env> [--capture DIR] [--with-muninn-e2e] [--load PASSES]
#
# 1. replay   examples/tools/sentryreplay.py sends a recorded Sentry SDK journey (default: the
#             golden iOS capture of @sentry/react-native 8.32.0, unchanged SDK, sessions, errors,
#             a crash, logs, transactions and replay_video segments) to the bridge on :4320 in real
#             time (2.5 min), with every timestamp moved to now and fresh ids; what it sent is saved
#             as a sentrytap capture.
# 2. verify   examples/sentry-mobile/scripts/verify-bridge.py derives sessions, errors, logs,
#             transactions and replay segments from that capture and finds each of them in
#             rum-api, Loki, Tempo and rum-api's replay store (mp4 bytes compared by sha256 and
#             decoded with AVFoundation on macOS).
# 3. mimir    Tempo's span metrics for the bridged service and the collector's own counters for
#             the ouosentry receiver are in Mimir.
# 4. muninn   with --with-muninn-e2e, tests/e2e/muninn/run.mjs runs against the same collector:
#             web SDK replay over OTLP /v1/logs into Muninn, Loki references, disk queue while
#             Muninn is stopped (needs node and Playwright's Chromium).
# 5. load     with --load N, N more journeys (fresh ids, 8 threads) and the bridge's answer
#             latency; see the report for the backend-down runs.
#
# Prints one PASS/FAIL line per check and exits non-zero on the first failed step.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_NAME="" CAPTURE="" MUNINN_E2E=0 LOAD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --capture) CAPTURE="$2"; shift ;;
    --with-muninn-e2e) MUNINN_E2E=1 ;;
    --load) LOAD="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
ENV_NAME="${ENV_NAME:-$("$ROOT/deploy/envs/ouo-env" slug)}"
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV_NAME")"
[[ -n "${OUO_MUNINN_URL:-}" ]] || { echo "env $ENV_NAME was not started with --muninn" >&2; exit 2; }
SENTRY="${OUO_SENTRY_URL:-http://sentry-bridge.$ENV_NAME.ouo.localhost}"
OUT="${OUO_DEMO_OUT:-$(mktemp -d)}"
log() { printf '%s [sentry-demo] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

log "env $ENV_NAME, bridge $SENTRY, output $OUT"
log "1. replay the Sentry journey"
python3 -I "$ROOT/examples/tools/sentryreplay.py" --bridge "$SENTRY" ${CAPTURE:+--capture "$CAPTURE"} \
  --save "$OUT/capture" --manifest "$OUT/manifest.json"

log "   waiting 20 s for the bridge's replay hold, the batches and Tempo's flush"
sleep 20

log "2. verify sessions, errors, logs, traces and replays against what was sent"
python3 -I "$ROOT/examples/sentry-mobile/scripts/verify-bridge.py" --capture "$OUT/capture" \
  --no-backend --rum "$OUO_RUM_API_URL" --loki "$OUO_LOKI_URL" --tempo "$OUO_TEMPO_URL" --out "$OUT/verify-bridge.json"

log "3. Mimir: span metrics of the bridged service, the bridge's own counters"
prom() { curl -fsS --get "$OUO_MIMIR_URL/prometheus/api/v1/query" --data-urlencode "query=$1" | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(sum(float(x["value"][1]) for x in r))'; }
fail=0
for q in 'sum(traces_spanmetrics_calls_total{service="sentry-demo"})' \
         'sum(ouo_sentry_envelopes_total)' \
         'sum(ouo_sentry_items_total)'; do
  v="$(prom "$q")"
  if python3 -c "import sys; sys.exit(0 if float('$v') > 0 else 1)"; then echo "PASS $q = $v"; else echo "FAIL $q = $v"; fail=1; fi
done
[[ $fail == 0 ]]

if [[ $MUNINN_E2E == 1 ]]; then
  log "4. Muninn spec wire through the same collector (tests/e2e/muninn)"
  (cd "$ROOT/tests/e2e/muninn" && { [[ -d node_modules ]] || npm install --no-audit --no-fund; } && node run.mjs)
fi

if [[ $LOAD -gt 0 ]]; then
  log "5. load: $LOAD journeys on 8 threads"
  python3 -I "$ROOT/examples/tools/sentryreplay.py" --bridge "$SENTRY" ${CAPTURE:+--capture "$CAPTURE"} \
    --passes "$LOAD" --concurrency 8 --gap 0 --manifest "$OUT/load.json"
fi
log "done; Grafana $OUO_GRAFANA_URL (admin / testing567), plugin page /a/ouo11y-rum-app"
