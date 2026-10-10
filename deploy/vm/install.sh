#!/usr/bin/env bash
# One-command install / upgrade of ouo on a VM (Ubuntu 24.04; any Linux with Docker works).
#
#   curl -fsSL https://raw.githubusercontent.com/ZiadMansourM/ouo/main/deploy/vm/install.sh \
#     | sudo bash -s -- --domain ouo.example.com --email you@example.com
#
# Idempotent: re-running with the same --dir updates the checkout to --ref, keeps the
# existing tokens and passwords in deploy/docker/.env, rebuilds the images and
# re-applies `compose up -d`. That is also the upgrade procedure (see README.md).
#
# What it does, in order:
#   1. checks Docker + the compose plugin (installs them with apt on Ubuntu/Debian unless --no-install-docker)
#   2. clones the repo into --dir (default /opt/ouo) or fetches and checks out --ref in an existing clone
#   3. writes deploy/docker/.env with random tokens (openssl rand -hex 16, prefixed pt_ / rt_)
#      and a random Grafana admin password; existing values are never overwritten
#   4. builds the Grafana plugin inside a node:24 container (no Node on the host), builds rum-api and the demo backend
#   5. starts the stack with the TLS override, installs and enables the systemd unit
#   6. waits for readiness and prints the URLs, the Grafana login and the PUBLIC project token
#
# Options:
#   --domain <host>        Grafana hostname (required on first run)
#   --rum-domain <host>    rum-api hostname (default rum.<domain>)
#   --email <addr>         ACME account email -> Let's Encrypt certificates (needs public DNS, ports 80/443)
#   --tls-internal         self-signed certificates from Caddy's own CA (LAN, IP addresses); default when --email is absent
#   --allowed-origins <p>  comma separated browser origins allowed to send telemetry (default https://<rum-domain>,https://<domain>)
#   --ref <git ref>        branch, tag or sha to install (default main)
#   --repo <url>           git remote (default https://github.com/ZiadMansourM/ouo.git)
#   --dir <path>           install directory (default /opt/ouo)
#   --no-install-docker    fail instead of apt-installing Docker when it is missing
#   --skip-plugin          do not (re)build the Grafana plugin
#   --no-systemd           do not install the systemd unit
#   --no-wait              do not wait for readiness
set -euo pipefail

REPO="https://github.com/ZiadMansourM/ouo.git"
REF="main"
DIR="/opt/ouo"
DOMAIN="" RUM_DOMAIN="" EMAIL="" ORIGINS=""
TLS_INTERNAL=0 INSTALL_DOCKER=1 BUILD_PLUGIN=1 SYSTEMD=1 WAIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --rum-domain) RUM_DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --tls-internal) TLS_INTERNAL=1; shift ;;
    --allowed-origins) ORIGINS="$2"; shift 2 ;;
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
ENV_FILE="$DIR/deploy/docker/.env"
COMPOSE=(docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml)

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

# --- 3. .env -----------------------------------------------------------------------------
# Existing keys win: tokens and passwords are generated once and never rotated by a rerun.
# A key passed on the command line (domain, email, origins) updates the file.
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

log "writing $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'HDR'
# Written by deploy/vm/install.sh. Read by docker compose (deploy/docker/compose.yaml +
# deploy/vm/compose.tls.yaml) and by deploy/scripts/*.sh. Keep this file private:
# OUO_READ_TOKEN and OUO_GRAFANA_ADMIN_PASSWORD are secrets. OUO_PROJECT_TOKEN is the
# public identifier browsers send; rotate it by editing here and `systemctl restart ouo`.
HDR
  chmod 600 "$ENV_FILE"
fi
if [[ -n "$DOMAIN" ]]; then set_env OUO_DOMAIN "$DOMAIN"; fi
DOMAIN="$(get_env OUO_DOMAIN || true)"
[[ -n "$DOMAIN" ]] || die "--domain is required on the first run (no OUO_DOMAIN in $ENV_FILE)"
[[ -n "$RUM_DOMAIN" ]] || RUM_DOMAIN="$(get_env OUO_RUM_DOMAIN || true)"
[[ -n "$RUM_DOMAIN" ]] || RUM_DOMAIN="rum.$DOMAIN"
set_env OUO_RUM_DOMAIN "$RUM_DOMAIN"
if [[ -n "$EMAIL" ]]; then set_env OUO_TLS "$EMAIL"
elif [[ "$TLS_INTERNAL" == "1" ]]; then set_env OUO_TLS internal
else set_env OUO_TLS internal keep; fi
[[ -n "$ORIGINS" ]] && set_env OUO_ALLOWED_ORIGINS "$ORIGINS"
set_env OUO_ALLOWED_ORIGINS "https://$RUM_DOMAIN,https://$DOMAIN" keep
set_env OUO_PROJECT_ID "default" keep
set_env OUO_PROJECT_TOKEN "pt_$(openssl rand -hex 16)" keep
set_env OUO_READ_TOKEN "rt_$(openssl rand -hex 16)" keep
set_env OUO_GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 12)" keep
echo "tls: $(get_env OUO_TLS)   grafana: https://$DOMAIN   rum-api: https://$RUM_DOMAIN"

# --- 4. build ----------------------------------------------------------------------------
if [[ "$BUILD_PLUGIN" == "1" ]]; then
  log "building the Grafana plugin in a node:24 container (plugins/ouo-rum-app/dist)"
  docker run --rm -v "$DIR:/src" -w /src node:24 \
    sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run -w plugins/ouo-rum-app build'
  chmod -R a+rX plugins/ouo-rum-app/dist
fi
log "building rum-api and the demo backend"
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

PT="$(get_env OUO_PROJECT_TOKEN)"
cat <<SUMMARY

ouo is up.

  Grafana      https://$DOMAIN            login admin / $(get_env OUO_GRAFANA_ADMIN_PASSWORD)
  Plugin       https://$DOMAIN/a/ouo-rum-app/overview
  rum-api      https://$RUM_DOMAIN/readyz
  Project id   $(get_env OUO_PROJECT_ID)
  Project token (public, goes into your SDK config):
               $PT

  Browser SDK:  initRUM({ endpoint: "https://$RUM_DOMAIN", projectToken: "$PT", service: { name: "my-app", version: "1.0.0", environment: "production" } })
  Any OTel SDK: OTEL_EXPORTER_OTLP_ENDPOINT=https://$RUM_DOMAIN/ingest/otlp OTEL_EXPORTER_OTLP_HEADERS=X-Ouo-Project-Token=$PT

  Secrets stay in $ENV_FILE (read token, Grafana password). Firewall: allow 22, 80, 443 only.
  Upgrade:  re-run this script with --ref <tag>.   Logs: docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml logs -f
SUMMARY
if [[ "$(get_env OUO_TLS)" == "internal" ]]; then
  cat <<NOTE
  TLS is Caddy's internal CA (self-signed). Trust its root on your machine, or use --email for Let's Encrypt:
    docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./ouo-root.crt
NOTE
fi
