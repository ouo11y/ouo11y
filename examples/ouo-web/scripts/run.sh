#!/usr/bin/env bash
# Build ouo-web against a stack, serve it, run the scripted journey and verify it.
#
#   examples/ouo-web/scripts/run.sh                 # plain compose stack on the stock ports (.env)
#   examples/ouo-web/scripts/run.sh --env <name>    # an ouo-env (deploy/envs/ouo-env)
#   examples/ouo-web/scripts/run.sh --no-verify     # journey only
#   examples/ouo-web/scripts/run.sh --browsers chromium,firefox,webkit   # cross-browser matrix
#   examples/ouo-web/scripts/run.sh --playwright-image mcr.microsoft.com/playwright:v1.64.1-noble
#       # the journey runs in that image (browsers and their system libraries included, host network)
#   examples/ouo-web/scripts/run.sh --first-party   # the SDK posts to /otel on the app's own origin,
#       # proxied to the collector by scripts/serve-first-party.mjs (docs/first-party-endpoint.md)
#
# The build is minified with hidden source maps: they get debug ids (`ouo-sourcemaps inject`), go to
# rum-api with the demo project's upload token (OUO_UPLOAD_TOKEN, ADR-0011) and are deleted before the
# app is served, so verify can check that rum-api symbolicates the render error back to its source.
#
# Stock ports: OTLP 4318, replay 4319, backend 8081, Tempo 3200, rum-api 8080, overridden by
# examples/ouo-web/.env (copy .env.example). With --env the URLs come from `ouo-env env/url`.
# Needs Node 24 and `npm ci` at the repo root; the first run downloads Playwright's browsers.
# Each browser runs the journey and verify in turn, with its own session (journey-<browser>.json).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
ENV_NAME="" FIRST_PARTY=0 VERIFY=1 PORT="${OUO_WEB_PORT:-4173}" BROWSERS="${OUO_WEB_BROWSERS:-chromium}" IMAGE="${OUO_WEB_PLAYWRIGHT_IMAGE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --no-verify) VERIFY=0 ;;
    --first-party) FIRST_PARTY=1 ;;
    --port) PORT="$2"; shift ;;
    --browsers) BROWSERS="$2"; shift ;;
    --playwright-image) IMAGE="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
# The proxy forwards to the collector; the SDK only sees its own origin.
export OUO_OTLP_URL="${OUO_OTLP_URL:-$VITE_OTLP_ENDPOINT}" OUO_REPLAY_URL="${OUO_REPLAY_URL:-${VITE_OUO_REPLAY_ENDPOINT:-${VITE_OTLP_ENDPOINT%:4318}:4319}}"
if [[ $FIRST_PARTY == 1 ]]; then export VITE_OTLP_ENDPOINT=/otel VITE_OUO_REPLAY_ENDPOINT=""; fi
export OUO_TEMPO_URL="${OUO_TEMPO_URL:-http://localhost:3200}" OUO_RUM_API_URL="${OUO_RUM_API_URL:-http://localhost:8080}"

cd "$root"
[[ -f sdk/browser/dist/index.js ]] || { log "build @ouo11y/browser"; npm run -w sdk/browser build >/dev/null; }
log "build (OTLP $VITE_OTLP_ENDPOINT, backend $VITE_BACKEND_URL)"
npm run -w examples/ouo-web build >/dev/null
[[ -f sdk/sourcemaps/dist/cli.js ]] || { log "build @ouo11y/sourcemaps"; npm run -w sdk/sourcemaps build >/dev/null; }
release="${VITE_APP_VERSION:-1.4.2}"
log "source maps: inject debug ids, upload to $OUO_RUM_API_URL (release $release), delete them from dist"
node sdk/sourcemaps/dist/cli.js inject examples/ouo-web/dist >/dev/null
node sdk/sourcemaps/dist/cli.js upload examples/ouo-web/dist --url "$OUO_RUM_API_URL" \
  --token "${OUO_UPLOAD_TOKEN:-ut_dev_demo_0000000000000000}" --project "${VITE_OUO_PROJECT_ID:-demo}" \
  --release "$release" --delete-after | tail -1
# On a fresh Linux CI runner the browser also needs its system libraries.
IFS=, read -ra browsers <<< "$BROWSERS"
if [[ -n $IMAGE ]]; then
  # The image has the browsers and their libraries: no apt (a slow Ubuntu mirror timed CI out).
  docker pull -q "$IMAGE" >/dev/null
else
  installs=()
  for b in "${browsers[@]}"; do [[ $b == chromium ]] && installs+=(chromium-headless-shell) || installs+=("$b"); done
  npx -w examples/ouo-web playwright install ${CI:+--with-deps} "${installs[@]}" >/dev/null
fi
journey() {
  if [[ -n $IMAGE ]]; then
    # Same paths inside (the repo mounted at its own path), host network for the stack. The built app
    # is served inside the container (a static server is enough: the journey loads / and navigates by
    # clicking), because Docker Desktop's host network does not reach a server on the Mac's loopback.
    docker run --rm --ipc=host --network host -v "$root:$root" -w "$here" -e FIRST_PARTY="$FIRST_PARTY" -e OUO_OTLP_URL -e OUO_REPLAY_URL "$IMAGE" sh -c '
      if [ "$FIRST_PARTY" = 1 ]; then node scripts/serve-first-party.mjs "$0" >/dev/null 2>&1 &
      else python3 -m http.server "$0" --bind 127.0.0.1 --directory dist >/dev/null 2>&1 & fi
      for _ in $(seq 1 30); do curl -sf "http://localhost:$0" >/dev/null && break; sleep 1; done
      exec node scripts/journey.mjs "$@"' "$PORT" "$@"
  else
    node "$here/scripts/journey.mjs" "$@"
  fi
}

if [[ -z $IMAGE ]]; then
  log "serve on http://localhost:$PORT"
  if [[ $FIRST_PARTY == 1 ]]; then node "$here/scripts/serve-first-party.mjs" "$PORT" >/dev/null 2>&1 &
  else npm run -w examples/ouo-web preview -- --port "$PORT" --strictPort >/dev/null 2>&1 & fi
  server=$!
  trap 'kill $server 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT" >/dev/null && break; sleep 1; done
else
  log "serve on http://localhost:$PORT inside $IMAGE"
fi

status=0
for b in "${browsers[@]}"; do
  out="$here/journey-$b.json"
  log "journey in $b"
  journey --browser "$b" --url "http://localhost:$PORT" --backend "$VITE_BACKEND_URL" --out "$out" || { status=1; continue; }
  if [[ $VERIFY == 1 ]]; then
    python3 -I "$here/scripts/verify.py" --journey "$out" || status=1
  fi
done
exit $status
