#!/bin/sh
# Prints the stack's URLs as KEY=value lines for $GITHUB_ENV, from the OUO_*_PORT host ports
# (compose.yaml's defaults when unset). Each self-hosted runner has its own rootless dockerd and
# its own port set in its .env (ouo11y-N: 20N00..20N91, project/kb/ci-runners.md), so stack jobs on two
# runners run at the same time. compose reads the same OUO_*_PORT variables; the scripts and the
# example apps read these URLs.
#   .github/scripts/stack-env.sh >> "$GITHUB_ENV"
set -eu
h=http://localhost
cat <<EOF
OUO_GRAFANA_URL=$h:${OUO_GRAFANA_PORT:-3000}
OUO_LOKI_URL=$h:${OUO_LOKI_PORT:-3100}
OUO_TEMPO_URL=$h:${OUO_TEMPO_PORT:-3200}
OUO_MIMIR_URL=$h:${OUO_MIMIR_PORT:-9009}
OUO_OTLP_URL=$h:${OUO_OTLP_HTTP_PORT:-4318}
OUO_REPLAY_URL=$h:${OUO_REPLAY_PORT:-4319}
OUO_SENTRY_URL=$h:${OUO_SENTRY_PORT:-4320}
OUO_COLLECTOR_HEALTH_URL=http://127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}
OUO_RUM_API_URL=$h:${OUO_RUM_API_PORT:-8080}
OUO_BACKEND_URL=$h:${OUO_BACKEND_PORT:-8081}
VITE_OTLP_ENDPOINT=$h:${OUO_OTLP_HTTP_PORT:-4318}
VITE_OUO_REPLAY_ENDPOINT=$h:${OUO_REPLAY_PORT:-4319}
VITE_BACKEND_URL=$h:${OUO_BACKEND_PORT:-8081}
EOF
