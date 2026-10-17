#!/usr/bin/env bash
# Wait until Loki, Tempo, Mimir, the collector, Grafana and rum-api answer their readiness endpoints.
# Honors the OUO_*_PORT overrides from deploy/compose/.env (same defaults as compose.yaml).
# The collector (ADR-0007, the public ingest) is probed three times: the health_check
# extension on loopback (127.0.0.1:13133), then the two published ports 4318 (OTLP/HTTP)
# and 4319 (replay) must answer HTTP at all (any status; without credentials the
# answer is 401, which proves basicauth is in front).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../compose/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
COLLECTOR_HEALTH="http://127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}"
OTLP="${OUO_OTLP_URL:-http://localhost:${OUO_OTLP_HTTP_PORT:-4318}}"
REPLAY="${OUO_REPLAY_URL:-http://localhost:${OUO_REPLAY_PORT:-4319}}"
GRAFANA="http://localhost:${OUO_GRAFANA_PORT:-3000}"
RUM_API="${OUO_RUM_API_URL:-${OUO_RUM_API:-http://localhost:${OUO_RUM_API_PORT:-8080}}}"
TIMEOUT="${OUO_READY_TIMEOUT:-120}"

wait_for() { # $1 name, $2 url, $3 accepted status regex (default ^200$)
  local name="$1" url="$2" want="${3:-^200$}" deadline=$((SECONDS + TIMEOUT)) code
  until code="$(curl -s -o /dev/null -w '%{http_code}' -X "${METHOD:-GET}" "$url")"; [[ "$code" =~ $want ]]; do
    if (( SECONDS >= deadline )); then
      echo "FAIL: $name not ready after ${TIMEOUT}s ($url -> $code): $(curl -s "$url" | head -c 200)" >&2
      return 1
    fi
    sleep 2
  done
  echo "ready: $name ($url -> $code)"
}

wait_for loki "$LOKI/ready"
wait_for tempo "$TEMPO/ready"
wait_for mimir "$MIMIR/ready"
wait_for otel-collector-health "$COLLECTOR_HEALTH/"
# Any HTTP answer (not 000) means the receiver is listening; 401 is the expected one.
METHOD=POST wait_for otel-collector-otlp "$OTLP/v1/traces" '^[1-5][0-9][0-9]$'
METHOD=POST wait_for otel-collector-replay "$REPLAY/v1/replay/chunks" '^[1-5][0-9][0-9]$'
wait_for grafana "$GRAFANA/api/health"
# /readyz is 503 until rum-api can reach Loki and Tempo; it needs no token.
wait_for rum-api "$RUM_API/readyz"
