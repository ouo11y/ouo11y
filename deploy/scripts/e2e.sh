#!/usr/bin/env bash
# Runs the end-to-end scenario (tests/e2e/scenario.mjs) against the local stack.
# Reads the OUO_* overrides from deploy/docker/.env (same defaults as compose.yaml),
# waits for the stack, then generates the synthetic session matrix and asserts rum-api.
# Usage: deploy/scripts/e2e.sh [--out <result.json>]
#
# Environment handed to the scenario (ADR-0007):
#   OUO_RUM_API        rum-api base URL (http://localhost:8080). The scenario derives
#                      ${OUO_RUM_API}/ingest/otlp/v1/{traces,logs,metrics} and
#                      ${OUO_RUM_API}/v1/replay/chunks from it.
#   OUO_OTLP_URL       OTLP base the scenario posts to: ${OUO_RUM_API}/ingest/otlp, i.e.
#                      through rum-api, which requires the project token header.
#   OUO_PROJECT_ID     project id rum-api stamps as ouo.project.id (demo)
#   OUO_PROJECT_TOKEN  sent as `X-Ouo-Project-Token` on every ingest request
#   OUO_READ_TOKEN     sent as `Authorization: Bearer ...` on GET /v1/* reads
#   OUO_RUM_API_URL    same as OUO_RUM_API (pre-8a name, kept for compatibility)
#   OUO_GRAFANA_URL, OUO_GRAFANA_AUTH   Grafana for the plugin-proxy assertions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

export OUO_RUM_API="${OUO_RUM_API:-http://localhost:${OUO_RUM_API_PORT:-8080}}"
export OUO_RUM_API_URL="${OUO_RUM_API_URL:-$OUO_RUM_API}"
export OUO_OTLP_URL="${OUO_OTLP_URL:-$OUO_RUM_API/ingest/otlp}"
export OUO_PROJECT_ID="${OUO_PROJECT_ID:-demo}"
export OUO_PROJECT_TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
export OUO_READ_TOKEN="${OUO_READ_TOKEN:-rt_dev_0000000000000000}"
export OUO_GRAFANA_URL="${OUO_GRAFANA_URL:-http://localhost:${OUO_GRAFANA_PORT:-3000}}"
export OUO_GRAFANA_AUTH="${OUO_GRAFANA_AUTH:-admin:admin}"

"$SCRIPT_DIR/wait-ready.sh"   # includes rum-api /readyz

exec node "$REPO_ROOT/tests/e2e/scenario.mjs" "$@"
