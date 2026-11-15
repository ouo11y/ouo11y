#!/bin/sh
# Prints the stack's URLs as KEY=value lines for $GITHUB_ENV, from the OUO_*_PORT host ports
# (compose.yaml's defaults when unset, as on the GitHub-hosted runners). compose reads the same
# OUO_*_PORT variables; the scripts and the example apps read these URLs.
#   .github/scripts/stack-env.sh >> "$GITHUB_ENV"
set -eu
h=http://localhost
muninn=${OUO_MUNINN_PORT:-3400}
cat <<EOF
OUO_GRAFANA_URL=$h:${OUO_GRAFANA_PORT:-3000}
OUO_LOKI_URL=$h:${OUO_LOKI_PORT:-3100}
OUO_TEMPO_URL=$h:${OUO_TEMPO_PORT:-3200}
OUO_MIMIR_URL=$h:${OUO_MIMIR_PORT:-9009}
OUO_OTLP_URL=$h:${OUO_OTLP_HTTP_PORT:-4318}
OUO_SENTRY_URL=$h:${OUO_SENTRY_PORT:-4320}
OUO_COLLECTOR_HEALTH_URL=http://127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}
OUO_BACKEND_URL=$h:${OUO_BACKEND_PORT:-8081}
OUO_MUNINN_PORT=$muninn
OUO_MUNINN_URL=$h:$muninn
VITE_OTLP_ENDPOINT=$h:${OUO_OTLP_HTTP_PORT:-4318}
VITE_BACKEND_URL=$h:${OUO_BACKEND_PORT:-8081}
EOF
