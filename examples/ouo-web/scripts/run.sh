#!/usr/bin/env bash
# Build ouo-web against a stack, serve it, run the scripted journey and verify it.
#
#   examples/ouo-web/scripts/run.sh                 # plain compose stack on the stock ports (.env)
#   examples/ouo-web/scripts/run.sh --env <name>    # an ouo-env (deploy/envs/ouo-env)
#   examples/ouo-web/scripts/run.sh --no-verify     # journey only
#   examples/ouo-web/scripts/run.sh --browsers chromium,firefox,webkit   # cross-browser matrix
#
# Stock ports: OTLP 4318, replay 4319, backend 8081, Tempo 3200, rum-api 8080, overridden by
# examples/ouo-web/.env (copy .env.example). With --env the URLs come from `ouo-env env/url`.
# Needs Node 24 and `npm ci` at the repo root; the first run downloads Playwright's browsers.
# Each browser runs the journey and verify in turn, with its own session (journey-<browser>.json).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
ENV_NAME="" VERIFY=1 PORT="${OUO_WEB_PORT:-4173}" BROWSERS="${OUO_WEB_BROWSERS:-chromium}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --no-verify) VERIFY=0 ;;
    --port) PORT="$2"; shift ;;
    --browsers) BROWSERS="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
log() { printf '%s [ouo-web] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ -f "$here/.env" ]]; then set -a; . "$here/.env"; set +a; fi
if [[ -n $ENV_NAME ]]; then
  eval "$("$root/deploy/envs/ouo-env" env "$ENV_NAME")"
  export VITE_OTLP_ENDPOINT="$OUO_OTLP_URL" VITE_OUO_REPLAY_ENDPOINT="$OUO_REPLAY_URL"
  export VITE_BACKEND_URL="http://backend.$ENV_NAME.ouo.localhost"
  [[ $ENV_NAME == main ]] && VITE_BACKEND_URL="http://backend.ouo.localhost"
fi
export VITE_OTLP_ENDPOINT="${VITE_OTLP_ENDPOINT:-http://localhost:4318}"
export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:8081}"
export OUO_TEMPO_URL="${OUO_TEMPO_URL:-http://localhost:3200}" OUO_RUM_API_URL="${OUO_RUM_API_URL:-http://localhost:8080}"

cd "$root"
[[ -f sdk/browser/dist/index.js ]] || { log "build @ouo11y/browser"; npm run -w sdk/browser build >/dev/null; }
log "build (OTLP $VITE_OTLP_ENDPOINT, backend $VITE_BACKEND_URL)"
npm run -w examples/ouo-web build >/dev/null
# On a fresh Linux CI runner the browser also needs its system libraries.
IFS=, read -ra browsers <<< "$BROWSERS"
installs=()
for b in "${browsers[@]}"; do [[ $b == chromium ]] && installs+=(chromium-headless-shell) || installs+=("$b"); done
npx -w examples/ouo-web playwright install ${CI:+--with-deps} "${installs[@]}" >/dev/null

log "serve on http://localhost:$PORT"
npm run -w examples/ouo-web preview -- --port "$PORT" --strictPort >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT" >/dev/null && break; sleep 1; done

status=0
for b in "${browsers[@]}"; do
  out="$here/journey-$b.json"
  log "journey in $b"
  node "$here/scripts/journey.mjs" --browser "$b" --url "http://localhost:$PORT" --backend "$VITE_BACKEND_URL" --out "$out" || { status=1; continue; }
  if [[ $VERIFY == 1 ]]; then
    python3 -I "$here/scripts/verify.py" --journey "$out" || status=1
  fi
done
exit $status
