#!/usr/bin/env bash
# Runs the end-to-end scenario (tests/e2e/scenario.mjs) against the local stack.
# Reads the OUO_* overrides from deploy/docker/.env (same defaults as compose.yaml),
# waits for the stack, then generates the synthetic session matrix and asserts rum-api.
# Usage: deploy/scripts/e2e.sh [--out <result.json>]
#
# Environment handed to the scenario (ADR-0007, the collector is the edge):
#   OUO_OTLP_URL       collector OTLP/HTTP base (http://localhost:4318); the scenario
#                      posts ${OUO_OTLP_URL}/v1/{traces,logs,metrics}
#   OUO_REPLAY_URL     collector replay receiver base (http://localhost:4319); the
#                      scenario posts ${OUO_REPLAY_URL}/v1/replay/chunks
#   OUO_PROJECT_ID     project id = Basic auth username; the collector stamps it as
#                      ouo.project.id (demo)
#   OUO_PROJECT_TOKEN  project token = Basic auth password. Every ingest request carries
#                      `Authorization: Basic base64("${OUO_PROJECT_ID}:${OUO_PROJECT_TOKEN}")`
#   OUO_PROJECT_BASIC  that base64 value, precomputed for convenience
#   OUO_RUM_API_URL    internal rum-api base (http://localhost:8080) for the read-side
#                      assertions only; `Authorization: Bearer ${OUO_READ_TOKEN}` on GET /v1/*
#   OUO_RUM_API        same as OUO_RUM_API_URL (older name, kept)
#   OUO_READ_TOKEN     the read token
#   OUO_GRAFANA_URL, OUO_GRAFANA_AUTH   Grafana for the plugin-proxy assertions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

export OUO_OTLP_URL="${OUO_OTLP_URL:-http://localhost:${OUO_OTLP_HTTP_PORT:-4318}}"
export OUO_REPLAY_URL="${OUO_REPLAY_URL:-http://localhost:${OUO_REPLAY_PORT:-4319}}"
export OUO_PROJECT_ID="${OUO_PROJECT_ID:-demo}"
export OUO_PROJECT_TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
export OUO_PROJECT_BASIC="$(printf '%s:%s' "$OUO_PROJECT_ID" "$OUO_PROJECT_TOKEN" | base64 | tr -d '\n')"
export OUO_RUM_API_URL="${OUO_RUM_API_URL:-${OUO_RUM_API:-http://localhost:${OUO_RUM_API_PORT:-8080}}}"
export OUO_RUM_API="${OUO_RUM_API:-$OUO_RUM_API_URL}"
export OUO_READ_TOKEN="${OUO_READ_TOKEN:-rt_dev_0000000000000000}"
export OUO_GRAFANA_URL="${OUO_GRAFANA_URL:-http://localhost:${OUO_GRAFANA_PORT:-3000}}"
export OUO_GRAFANA_AUTH="${OUO_GRAFANA_AUTH:-admin:testing567}"

"$SCRIPT_DIR/wait-ready.sh"   # collector health + public ports, rum-api /readyz

exec node "$REPO_ROOT/tests/e2e/scenario.mjs" "$@"
