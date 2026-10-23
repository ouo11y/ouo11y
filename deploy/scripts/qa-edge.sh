#!/usr/bin/env bash
# Runs the edge QA checks (tests/e2e/edge-qa.mjs, checklist N13 / N15) against an ouo-env env.
#
#   1. profile `default` on the env as it is: auth-failure counter, empty OTLP exports charged
#      by the rate limiter, a stock OTel SDK with OTEL_EXPORTER_OTLP_HEADERS, foreign-origin
#      CORS in headless Chromium, the plugin as a Grafana Viewer, the RN `background` end reason
#   2. recreates the env's collector with small buckets and key_from x_forwarded_for, runs
#      profile `limits` (X-Forwarded-For keying, direct and through the env proxy; one
#      project's bucket against another's)
#   3. recreates the collector with the stock settings again (also when step 2 fails)
#
# Usage: deploy/scripts/qa-edge.sh [<env>] [--out-dir <dir>]
#   <env>      default: the branch slug (deploy/envs/ouo-env slug)
#   --out-dir  writes edge-qa-default.json and edge-qa-limits.json there
# Needs Node 24, the repository's npm install (vitest, OTel JS packages) and
# `npm install --prefix tests/e2e` (Playwright; it uses the cached Chromium headless shell,
# `npx --prefix tests/e2e playwright install chromium-headless-shell` when missing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUO_ENV="$REPO_ROOT/deploy/envs/ouo-env"

ENV_NAME=""
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) ENV_NAME="$1"; shift ;;
  esac
done
ENV_NAME="${ENV_NAME:-$("$OUO_ENV" slug)}"
eval "$("$OUO_ENV" env "$ENV_NAME")"
out() { [[ -n "$OUT_DIR" ]] && echo "--out $OUT_DIR/edge-qa-$1.json"; }

# Small buckets for the `limits` profile: the project bucket must empty before the client
# buckets of the many X-Forwarded-For clients it is spread over.
LIMITS=(OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for OUO_RATELIMIT_CLIENT_RATE=1 OUO_RATELIMIT_CLIENT_BURST=10
        OUO_RATELIMIT_PROJECT_RATE=1 OUO_RATELIMIT_PROJECT_BURST=40)

status=0
echo "== profile default on env $ENV_NAME"
# shellcheck disable=SC2046
node "$REPO_ROOT/tests/e2e/edge-qa.mjs" --profile default $(out default) || status=1

restore() {
  echo "== restoring the stock collector settings on env $ENV_NAME"
  "$OUO_ENV" up "$ENV_NAME" > /dev/null
}
trap restore EXIT

echo "== recreating the collector with ${LIMITS[*]}"
env "${LIMITS[@]}" "$OUO_ENV" up "$ENV_NAME" > /dev/null
"$SCRIPT_DIR/wait-ready.sh" > /dev/null
# The proxy route of the env's OTLP port (Traefik overwrites X-Forwarded-For).
proxy_otlp="$(sed -E 's#://grafana\.#://otlp.#' <<< "$OUO_GRAFANA_URL")"
# shellcheck disable=SC2046
OUO_QA_PROXY_OTLP_URL="$proxy_otlp" OUO_QA_CLIENT_BURST=10 OUO_QA_CLIENT_RATE=1 OUO_QA_PROJECT_BURST=40 \
  node "$REPO_ROOT/tests/e2e/edge-qa.mjs" --profile limits $(out limits) || status=1

exit "$status"
