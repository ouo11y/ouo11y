#!/usr/bin/env bash
# Runs the end-to-end scenario (tests/e2e/scenario.mjs) against the local stack.
# Reads the OUO_*_PORT overrides from deploy/docker/.env (same defaults as compose.yaml),
# waits for the stack, then generates the synthetic session matrix and asserts rum-api.
# Usage: deploy/scripts/e2e.sh [--out <result.json>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

export OUO_OTLP_URL="${OUO_OTLP_URL:-http://localhost:${OUO_OTLP_HTTP_PORT:-4318}}"
export OUO_RUM_API_URL="${OUO_RUM_API_URL:-http://localhost:${OUO_RUM_API_PORT:-8080}}"
export OUO_GRAFANA_URL="${OUO_GRAFANA_URL:-http://localhost:${OUO_GRAFANA_PORT:-3000}}"
export OUO_GRAFANA_AUTH="${OUO_GRAFANA_AUTH:-admin:admin}"

"$SCRIPT_DIR/wait-ready.sh"

deadline=$((SECONDS + ${OUO_READY_TIMEOUT:-120}))
until curl -fs "$OUO_RUM_API_URL/readyz" >/dev/null; do
  (( SECONDS >= deadline )) && { echo "FAIL: rum-api not ready at $OUO_RUM_API_URL" >&2; exit 1; }
  sleep 2
done
echo "ready: rum-api ($OUO_RUM_API_URL/readyz)"

exec node "$REPO_ROOT/tests/e2e/scenario.mjs" "$@"
