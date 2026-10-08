#!/usr/bin/env bash
# Wait until Loki, Tempo, Mimir, the collector and Grafana answer their readiness endpoints.
# Honors the OUO_*_PORT overrides from deploy/docker/.env (same defaults as compose.yaml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
COLLECTOR_HEALTH="http://localhost:${OUO_COLLECTOR_HEALTH_PORT:-13133}"
GRAFANA="http://localhost:${OUO_GRAFANA_PORT:-3000}"
TIMEOUT="${OUO_READY_TIMEOUT:-120}"

wait_for() {
  local name="$1" url="$2" deadline=$((SECONDS + TIMEOUT))
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" == "200" ]]; do
    if (( SECONDS >= deadline )); then
      echo "FAIL: $name not ready after ${TIMEOUT}s ($url): $(curl -s "$url" | head -c 200)" >&2
      return 1
    fi
    sleep 2
  done
  echo "ready: $name ($url)"
}

wait_for loki "$LOKI/ready"
wait_for tempo "$TEMPO/ready"
wait_for mimir "$MIMIR/ready"
wait_for otel-collector "$COLLECTOR_HEALTH/"
wait_for grafana "$GRAFANA/api/health"
