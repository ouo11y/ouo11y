#!/usr/bin/env bash
# One-command install / upgrade of ouo on a VM (Ubuntu 24.04; any Linux with Docker works).
#
#   curl -fsSL https://raw.githubusercontent.com/ouo11y/ouo11y/main/deploy/vm/install.sh \
#     | sudo bash -s -- --domain ouo.example.com --email you@example.com
#
# Idempotent: re-running with the same --dir updates the checkout to --ref, keeps the
# existing tokens, passwords and project registry, rebuilds the images and re-applies
# `compose up -d`. That is also the upgrade procedure (see README.md).
#
# What it does, in order:
#   1. checks Docker + the compose plugin (installs them with apt on Ubuntu/Debian unless --no-install-docker)
#   2. clones the repo into --dir (default /opt/ouo) or fetches and checks out --ref in an existing clone
#   3. writes deploy/compose/.env with random tokens (openssl rand -hex 16, prefixed pt_ / it_ / rt_)
#      and a random Grafana admin password, and deploy/compose/projects.htpasswd with the
#      project's `{SHA}` line (ADR-0007: the collector authenticates SDKs with HTTP Basic);
#      existing values are never overwritten
#   4. builds the Grafana plugin inside a node:24 container (no Node on the host), the ouo
#      collector distribution (ocb, from collector/), rum-api and the demo backend
#   5. starts the stack with the TLS override, installs and enables the systemd unit
#   6. waits for readiness and prints the URLs, the Grafana login and the PUBLIC project credential
#
# Options:
#   --domain <host>        Grafana hostname (required on first run)
#   --otel-domain <host>   collector hostname, the SDK endpoint (default otel.<domain>)
#   --email <addr>         ACME account email -> Let's Encrypt certificates (needs public DNS, ports 80/443)
#   --tls-internal         self-signed certificates from Caddy's own CA (LAN, IP addresses); default when --email is absent
#   --project <id>         project id of the first project (default `default`; lower-case letters, digits, . _ -)
#   --ref <git ref>        branch, tag or sha to install (default main)
#   --repo <url>           git remote (default https://github.com/ouo11y/ouo11y.git)
#   --dir <path>           install directory (default /opt/ouo)
#   --no-install-docker    fail instead of apt-installing Docker when it is missing
#   --skip-plugin          do not (re)build the Grafana plugin
#   --no-systemd           do not install the systemd unit
#   --no-wait              do not wait for readiness
set -euo pipefail

REPO="https://github.com/ouo11y/ouo11y.git"
REF="main"
DIR="/opt/ouo"
DOMAIN="" OTEL_DOMAIN="" EMAIL="" PROJECT=""
TLS_INTERNAL=0 INSTALL_DOCKER=1 BUILD_PLUGIN=1 SYSTEMD=1 WAIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --otel-domain) OTEL_DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --tls-internal) TLS_INTERNAL=1; shift ;;
    --project) PROJECT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-install-docker) INSTALL_DOCKER=0; shift ;;
    --skip-plugin) BUILD_PLUGIN=0; shift ;;
    --no-systemd) SYSTEMD=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n==> %s\n' "$*"; }
die()  { echo "install.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

[[ "$(id -u)" == "0" ]] || die "run as root (sudo): it installs packages, writes $DIR and a systemd unit"
if [[ -n "$PROJECT" ]] && ! [[ "$PROJECT" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
  die "--project must match ^[a-z0-9][a-z0-9._-]{0,63}$"
fi
ENV_FILE="$DIR/deploy/compose/.env"
HTPASSWD_FILE="$DIR/deploy/compose/projects.htpasswd"
COMPOSE=(docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml)

# --- 1. Docker -------------------------------------------------------------------------
log "checking Docker"
if ! need docker || ! docker compose version >/dev/null 2>&1; then
  if [[ "$INSTALL_DOCKER" == "1" ]] && need apt-get; then
    log "installing docker.io, docker-compose-v2, git, curl, openssl with apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-v2 git curl openssl ca-certificates
    systemctl enable --now docker
  else
    die "Docker with the compose plugin is required. Ubuntu 24.04: apt-get install -y docker.io docker-compose-v2 git curl openssl"
  fi
fi
for tool in git curl openssl; do need "$tool" || die "$tool is required (apt-get install -y $tool)"; done
docker info >/dev/null 2>&1 || die "docker daemon is not running (systemctl start docker)"
echo "docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short | sed 's/^/compose /')"

# --- 2. checkout -------------------------------------------------------------------------
if [[ -d "$DIR/.git" ]]; then
  log "updating $DIR to $REF"
  git -C "$DIR" fetch --tags --prune origin
  if git -C "$DIR" rev-parse --verify --quiet "refs/remotes/origin/$REF" >/dev/null; then
    git -C "$DIR" checkout --quiet --detach "origin/$REF"
  else
    git -C "$DIR" checkout --quiet --detach "$REF"
  fi
else
  log "cloning $REPO ($REF) into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$REPO" "$DIR"
  if git -C "$DIR" rev-parse --verify --quiet "refs/remotes/origin/$REF" >/dev/null; then
    git -C "$DIR" checkout --quiet --detach "origin/$REF"
  else
    git -C "$DIR" checkout --quiet --detach "$REF"
  fi
fi
cd "$DIR"
echo "at $(git rev-parse --short HEAD) ($(git log -1 --format=%s | cut -c1-70))"

# --- 3. .env and the project registry ----------------------------------------------------
# Existing keys win: tokens and passwords are generated once and never rotated by a rerun.
# A key passed on the command line (domain, email, project) updates the file.
set_env() { # $1 key, $2 value, $3 "keep" to leave an existing value alone
  local key="$1" value="$2" mode="${3:-replace}"
  if grep -q "^${key}=" "$ENV_FILE"; then
    [[ "$mode" == "keep" ]] && return 0
    # value may contain / and &; use a different sed delimiter and escape &
    sed -i "s|^${key}=.*|${key}=${value//&/\\&}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}
get_env() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
# `{SHA}` htpasswd hash: base64 of the raw SHA-1 of the token. Identical to
# `htpasswd -nbs <id> <token>` (apache2-utils), without needing that package. Cheap on
# purpose: it runs on every request and the token is public (ADR-0007 section 2).
sha_line() { printf '%s:{SHA}%s\n' "$1" "$(printf '%s' "$2" | openssl dgst -binary -sha1 | openssl base64)"; }
basic_b64() { printf '%s:%s' "$1" "$2" | openssl base64 -A; }

log "writing $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'HDR'
# Written by deploy/vm/install.sh. Read by docker compose (deploy/compose/compose.yaml +
# deploy/vm/compose.tls.yaml) and by deploy/scripts/*.sh. Keep this file private:
# OUO_INGEST_TOKEN, OUO_READ_TOKEN and OUO_GRAFANA_ADMIN_PASSWORD are secrets.
# OUO_PROJECT_ID / OUO_PROJECT_TOKEN are the PUBLIC credential SDKs send (HTTP Basic);
# the collector checks them against deploy/compose/projects.htpasswd. To rotate (cut-over,
# one line per project id is honoured): replace the project's line, `systemctl restart ouo`,
# ship the new token to the apps.
HDR
  chmod 600 "$ENV_FILE"
fi
if [[ -n "$DOMAIN" ]]; then set_env OUO_DOMAIN "$DOMAIN"; fi
DOMAIN="$(get_env OUO_DOMAIN || true)"
[[ -n "$DOMAIN" ]] || die "--domain is required on the first run (no OUO_DOMAIN in $ENV_FILE)"
[[ -n "$OTEL_DOMAIN" ]] || OTEL_DOMAIN="$(get_env OUO_OTEL_DOMAIN || true)"
[[ -n "$OTEL_DOMAIN" ]] || OTEL_DOMAIN="otel.$DOMAIN"
set_env OUO_OTEL_DOMAIN "$OTEL_DOMAIN"
if [[ -n "$EMAIL" ]]; then set_env OUO_TLS "$EMAIL"
elif [[ "$TLS_INTERNAL" == "1" ]]; then set_env OUO_TLS internal
else set_env OUO_TLS internal keep; fi
[[ -n "$PROJECT" ]] && set_env OUO_PROJECT_ID "$PROJECT"
set_env OUO_PROJECT_ID "default" keep
set_env OUO_PROJECT_TOKEN "pt_$(openssl rand -hex 16)" keep
set_env OUO_INGEST_TOKEN "it_$(openssl rand -hex 16)" keep
set_env OUO_READ_TOKEN "rt_$(openssl rand -hex 16)" keep
set_env OUO_GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 12)" keep
PROJECT_ID="$(get_env OUO_PROJECT_ID)"
PT="$(get_env OUO_PROJECT_TOKEN)"
BASIC="$(basic_b64 "$PROJECT_ID" "$PT")"
# The demo backend and rum-api send their own telemetry through the collector with this
# project's credential (`%20` is the OTLP env-var encoding of the space).
set_env OUO_BACKEND_OTLP_HEADERS "Authorization=Basic%20$BASIC"
echo "tls: $(get_env OUO_TLS)   grafana: https://$DOMAIN   collector: https://$OTEL_DOMAIN   project: $PROJECT_ID"

log "writing $HTPASSWD_FILE"
# Exactly one `<project id>:{SHA}<hash>` line per project (basicauth keeps only the last one).
# Hashes only, so the file is world-readable: the collector runs as a non-root user.
if [[ ! -f "$HTPASSWD_FILE" ]]; then
  printf '# ouo project registry (ADR-0007). One line per project token: <project id>:{SHA}<base64 sha1>.\n# Add a line with: deploy/vm/install.sh prints the command, or htpasswd -nbs <id> <token>.\n' > "$HTPASSWD_FILE"
  chmod 644 "$HTPASSWD_FILE"
fi
if ! grep -q "^${PROJECT_ID}:" "$HTPASSWD_FILE"; then
  sha_line "$PROJECT_ID" "$PT" >> "$HTPASSWD_FILE"
  echo "added project $PROJECT_ID"
else
  echo "project $PROJECT_ID already registered (kept)"
fi

# --- 4. build ----------------------------------------------------------------------------
if [[ "$BUILD_PLUGIN" == "1" ]]; then
  log "building the Grafana plugin in a node:24 container (plugins/ouo11y-rum-app/dist)"
  docker run --rm -v "$DIR:/src" -w /src node:24 \
    sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run -w plugins/ouo11y-rum-app build'
  chmod -R a+rX plugins/ouo11y-rum-app/dist
fi
log "building the ouo collector distribution (ocb), rum-api and the demo backend"
"${COMPOSE[@]}" build --quiet

# --- 5. start + systemd ------------------------------------------------------------------
log "starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans
if [[ "$SYSTEMD" == "1" ]] && need systemctl; then
  log "installing systemd unit ouo.service"
  sed "s|__OUO_DIR__|$DIR|g" deploy/vm/ouo.service > /etc/systemd/system/ouo.service
  systemctl daemon-reload
  systemctl enable --quiet ouo.service
fi

# --- 6. wait + print ---------------------------------------------------------------------
if [[ "$WAIT" == "1" ]]; then
  log "waiting for readiness (loopback ports)"
  OUO_ENV_FILE="$ENV_FILE" OUO_READY_TIMEOUT="${OUO_READY_TIMEOUT:-300}" deploy/scripts/wait-ready.sh
fi

cat <<SUMMARY

ouo is up.

  Grafana        https://$DOMAIN            login admin / $(get_env OUO_GRAFANA_ADMIN_PASSWORD)
  Plugin         https://$DOMAIN/a/ouo11y-rum-app/overview
  Collector      https://$OTEL_DOMAIN       OTLP/HTTP (/v1/traces, /v1/logs, /v1/metrics) and replay (/v1/replay/chunks)
  Project id     $PROJECT_ID
  Project token  $PT        (public: it goes into your SDK config)
  Basic header   Authorization: Basic $BASIC

  Browser SDK:  initRUM({ endpoint: "https://$OTEL_DOMAIN", projectId: "$PROJECT_ID", projectToken: "$PT", service: { name: "my-app", version: "1.0.0", environment: "production" } })
  Any OTel SDK: OTEL_EXPORTER_OTLP_ENDPOINT=https://$OTEL_DOMAIN OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20$BASIC

  Secrets stay in $ENV_FILE (ingest token, read token, Grafana password). Firewall: allow 22, 80, 443 only.
  Another project:  echo "<id>:{SHA}\$(printf '%s' '<token>' | openssl dgst -binary -sha1 | openssl base64)" >> $HTPASSWD_FILE && systemctl restart ouo
  Upgrade:  re-run this script with --ref <tag>.   Logs: docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml logs -f
SUMMARY
if [[ "$(get_env OUO_TLS)" == "internal" ]]; then
  cat <<NOTE
  TLS is Caddy's internal CA (self-signed). Trust its root on your machine, or use --email for Let's Encrypt:
    docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./ouo-root.crt
NOTE
fi
