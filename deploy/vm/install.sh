#!/usr/bin/env bash
# One-command install / upgrade of ouo on a VM (Ubuntu 24.04; any Linux with Docker works).
#
#   curl -fsSL https://raw.githubusercontent.com/ouo11y/ouo11y/main/deploy/vm/install.sh \
#     | sudo bash -s -- --domain ouo.example.com --email you@example.com
#
# Idempotent: re-running with the same --dir keeps the checkout where it is (or moves it to
# --ref when given), keeps the existing tokens, passwords and project registry, rebuilds or
# pulls the images and re-applies `compose up -d`. Re-running with --ref <tag> is also the
# upgrade procedure (see README.md and docs/operations/upgrade.md).
#
# What it does, in order:
#   1. checks Docker + the compose plugin (installs them with apt on Ubuntu/Debian unless --no-install-docker)
#   2. clones the repo into --dir (default /opt/ouo) or fetches and checks out --ref in an existing clone
#   3. writes deploy/compose/.env with random tokens (openssl rand -hex 16, prefixed pt_ / mit_ /
#      mrt_ / mat_), random MinIO and Grafana admin passwords, and deploy/compose/projects.htpasswd with the
#      project's `{SHA}` line (ADR-0007: the collector authenticates SDKs with HTTP Basic);
#      existing values are never overwritten
#   4. builds the ouo collector distribution (ocb, from collector/), Muninn and the demo
#      backend; with --images it pulls the released ghcr.io/ouo11y/{collector,muninn} images
#      instead and builds only the demo backend
#   5. starts the stack with the TLS override, installs and enables the systemd unit
#   6. waits for readiness and prints the URLs, the Grafana login and the PUBLIC project credential
#
# Options:
#   --domain <host>        Grafana hostname (required on first run)
#   --otel-domain <host>   collector hostname, the SDK endpoint (default otel.<domain>)
#   --email <addr>         ACME account email -> Let's Encrypt certificates (needs public DNS, ports 80/443)
#   --tls-internal         self-signed certificates from Caddy's own CA (LAN, IP addresses); default when --email is absent
#   --project <id>         project id of the first project (default `default`; lower-case letters, digits, . _ -)
#   --ref <git ref>        branch, tag or sha to install (first run: default main; re-run: default
#                          the commit already checked out, so a re-run never moves the install)
#   --images               run the released images (deploy/compose/compose.images.yaml) instead of
#                          building from source. The images are public, no docker login.
#                          Remembered in .env (OUO_INSTALL_MODE)
#   --build                build from source again after an --images install
#   --image-version <v>    image tag for --images (default: the one in .env, else compose.images.yaml's)
#   --registry <prefix>    image registry prefix for --images (default ghcr.io/ouo11y)
#   --retention <list>     retention per signal, comma separated signal=duration pairs among
#                          logs, traces, metrics, replays (e.g. logs=720h,replays=168h; Go
#                          durations, logs at least 24h); written to .env as OUO_RETENTION_*.
#                          Defaults: logs 720h, traces 336h, metrics 2160h, replays 720h
#   --allowed-origins <l>  browser origins allowed to post to the collector, comma separated, no
#                          spaces (OUO_ALLOWED_ORIGINS, e.g. https://shop.example.com,https://*.example.com)
#   --repo <url>           git remote (default https://github.com/ouo11y/ouo11y.git)
#   --dir <path>           install directory (default /opt/ouo)
#   --no-install-docker    fail instead of apt-installing Docker when it is missing
#   --no-systemd           do not install the systemd unit
#   --no-wait              do not wait for readiness
set -euo pipefail

REPO="https://github.com/ouo11y/ouo11y.git"
REF=""
DIR="/opt/ouo"
DOMAIN="" OTEL_DOMAIN="" EMAIL="" PROJECT=""
TLS_INTERNAL=0 INSTALL_DOCKER=1 SYSTEMD=1 WAIT=1
MODE="" IMAGE_VERSION="" REGISTRY="" ORIGINS="" RETENTION=""
ARGS=("$@")

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
    --no-systemd) SYSTEMD=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    --images) MODE=images; shift ;;
    --build) MODE=build; shift ;;
    --image-version) IMAGE_VERSION="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --allowed-origins) ORIGINS="$2"; shift 2 ;;
    --retention) RETENTION="$2"; shift 2 ;;
    -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
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
if [[ -n "$RETENTION" ]]; then
  IFS=',' read -ra pairs <<< "$RETENTION"
  for p in "${pairs[@]}"; do
    [[ "$p" =~ ^(logs|traces|metrics|replays)=[0-9]+(h|m|s)$ ]] \
      || die "--retention: '$p' is not <logs|traces|metrics|replays>=<number>h (or m, s)"
  done
fi
ENV_FILE="$DIR/deploy/compose/.env"
HTPASSWD_FILE="$DIR/deploy/compose/projects.htpasswd"

# --- 1. Docker -------------------------------------------------------------------------
log "checking Docker"
if ! need docker || ! docker compose version >/dev/null 2>&1; then
  if [[ "$INSTALL_DOCKER" == "1" ]] && need apt-get; then
    log "installing docker.io, docker-compose-v2, docker-buildx, git, curl, openssl with apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # docker-buildx: without it `compose build` warns and falls back to the legacy builder.
    apt-get install -y -qq docker.io docker-compose-v2 docker-buildx git curl openssl ca-certificates
    systemctl enable --now docker
  else
    die "Docker with the compose plugin is required. Ubuntu 24.04: apt-get install -y docker.io docker-compose-v2 docker-buildx git curl openssl"
  fi
fi
for tool in git curl openssl; do need "$tool" || die "$tool is required (apt-get install -y $tool)"; done
docker info >/dev/null 2>&1 || die "docker daemon is not running (systemctl start docker)"
echo "docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short | sed 's/^/compose /')"

# --- 2. checkout -------------------------------------------------------------------------
if [[ -d "$DIR/.git" && -z "$REF" ]]; then
  log "keeping $DIR at the checked-out commit (pass --ref <tag> to upgrade)"
elif [[ -d "$DIR/.git" ]]; then
  log "updating $DIR to $REF"
  git -C "$DIR" fetch --tags --prune origin
  if git -C "$DIR" rev-parse --verify --quiet "refs/remotes/origin/$REF" >/dev/null; then
    git -C "$DIR" checkout --quiet --detach "origin/$REF"
  else
    git -C "$DIR" checkout --quiet --detach "$REF"
  fi
else
  REF="${REF:-main}"
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

# The checked-out release may carry a newer installer than the one running (an upgrade
# started with the old script, or `curl | bash` of main). Hand over to it once, so the
# layout, compose files and unit always match the release being installed. Only an installer
# that knows this hand-over is trusted with our arguments: one from before it (0.3.0 and
# older) may not know --images or the deploy/docker -> deploy/compose move, so this script
# carries on itself. The guard is an environment variable, not a flag, for the same reason.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
if [[ "${OUO_INSTALL_HANDED_OVER:-0}" != "1" && -f deploy/vm/install.sh ]] \
  && grep -q OUO_INSTALL_HANDED_OVER deploy/vm/install.sh && ! cmp -s "$SELF" deploy/vm/install.sh; then
  log "handing over to the installer of $(git rev-parse --short HEAD)"
  OUO_INSTALL_HANDED_OVER=1 exec bash deploy/vm/install.sh "${ARGS[@]}"
fi

# Releases up to 0.2.0 kept the compose project in deploy/docker/ (ADR-0010 moved it to
# deploy/compose/). The generated .env and project registry are gitignored and survive
# the checkout; carry them over once so tokens and passwords stay the same.
for f in .env projects.htpasswd; do
  if [[ -f "deploy/docker/$f" && ! -f "deploy/compose/$f" ]]; then
    log "moving deploy/docker/$f to deploy/compose/$f (layout of 0.3.0 and later)"
    mv "deploy/docker/$f" "deploy/compose/$f"
  fi
done

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
FIRST_RUN=0
if [[ ! -f "$ENV_FILE" ]]; then
  FIRST_RUN=1
  cat > "$ENV_FILE" <<'HDR'
# Written by deploy/vm/install.sh. Read by docker compose (deploy/compose/compose.yaml +
# deploy/vm/compose.tls.yaml) and by deploy/scripts/*.sh. Keep this file private:
# OUO_MUNINN_*_TOKEN, OUO_MINIO_ROOT_PASSWORD, OUO_MUNINN_S3_SECRET_KEY and
# OUO_GRAFANA_ADMIN_PASSWORD are secrets. OUO_RETENTION_* is the retention per signal (docs/operations/data-lifecycle.md).
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
# Muninn's bearers: ingest (the collector's exporter), read, and admin (`ouo-erase`).
set_env OUO_MUNINN_INGEST_TOKEN "mit_$(openssl rand -hex 16)" keep
set_env OUO_MUNINN_READ_TOKEN "mrt_$(openssl rand -hex 16)" keep
set_env OUO_MUNINN_ADMIN_TOKEN "mat_$(openssl rand -hex 16)" keep
# MinIO (Muninn's object store): root password and the bucket-scoped key of Muninn's user.
set_env OUO_MINIO_ROOT_PASSWORD "$(openssl rand -hex 16)" keep
set_env OUO_MUNINN_S3_SECRET_KEY "$(openssl rand -hex 16)" keep
# Retention per signal (roadmap 8b): --retention overrides, otherwise kept or defaulted.
if [[ -n "$RETENTION" ]]; then
  for p in "${pairs[@]}"; do
    sig="${p%%=*}"; set_env "OUO_RETENTION_$(printf '%s' "$sig" | tr '[:lower:]' '[:upper:]')" "${p#*=}"
  done
fi
set_env OUO_RETENTION_LOGS 720h keep
set_env OUO_RETENTION_TRACES 336h keep
set_env OUO_RETENTION_METRICS 2160h keep
set_env OUO_RETENTION_REPLAYS 720h keep
set_env OUO_GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 12)" keep
# Sentry DSN public key of the bridge (ADR-0008); public like the project token. The
# development default in compose.yaml is the same on every laptop, so a new install gets its
# own. An install from before this key existed keeps the default: its apps' DSNs carry it.
if [[ "$FIRST_RUN" == "1" ]]; then set_env OUO_SENTRY_PUBLIC_KEY "$(openssl rand -hex 16)" keep; fi
[[ -n "$ORIGINS" ]] && set_env OUO_ALLOWED_ORIGINS "$ORIGINS"
[[ -n "$MODE" ]] && set_env OUO_INSTALL_MODE "$MODE"
set_env OUO_INSTALL_MODE build keep
MODE="$(get_env OUO_INSTALL_MODE)"
if [[ "$MODE" == "images" ]]; then
  [[ -n "$IMAGE_VERSION" ]] && for c in COLLECTOR MUNINN; do set_env "OUO_${c}_VERSION" "$IMAGE_VERSION"; done
  [[ -n "$REGISTRY" ]] && set_env OUO_IMAGE_REGISTRY "$REGISTRY"
fi
PROJECT_ID="$(get_env OUO_PROJECT_ID)"
PT="$(get_env OUO_PROJECT_TOKEN)"
BASIC="$(basic_b64 "$PROJECT_ID" "$PT")"
# The demo backend and Muninn send their own telemetry through the collector with this
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

COMPOSE_FILES=(deploy/compose/compose.yaml)
[[ "$MODE" == "images" ]] && COMPOSE_FILES+=(deploy/compose/compose.images.yaml)
COMPOSE_FILES+=(deploy/vm/compose.tls.yaml)
COMPOSE=(docker compose)
for f in "${COMPOSE_FILES[@]}"; do [[ -f "$f" ]] || die "$f missing at this ref"; COMPOSE+=(-f "$f"); done

# --- 4. build or pull ---------------------------------------------------------------------
if [[ "$MODE" == "images" ]]; then
  # Pull only what is not on the host yet (compose.images.yaml has pull_policy: missing), so
  # images loaded with `docker load` (air-gapped hosts) need no registry login.
  missing=()
  for img in $("${COMPOSE[@]}" config --images 2>/dev/null | grep -E '/(collector|muninn):'); do
    docker image inspect "$img" >/dev/null 2>&1 || missing+=("$img")
  done
  log "released images: ${#missing[@]} to pull ${missing[*]:-(all present)}"
  for img in "${missing[@]}"; do
    if ! docker pull --quiet "$img" 2>"$DIR/.pull.err"; then
      cat "$DIR/.pull.err" >&2
      if grep -qiE 'denied|unauthorized|403' "$DIR/.pull.err"; then
        die "ghcr.io refused the pull of $img. The ouo images are public, so root (the installer and ouo.service pull as root) most likely has an old, expired ghcr.io login:
  sudo docker logout ghcr.io
A --registry other than ghcr.io/ouo11y may need its own sudo docker login.
No route to ghcr.io (offline VM): docker save the images on a machine that has them and docker load them here, or install without --images."
      fi
      die "pull of $img failed (see above)"
    fi
  done
  rm -f "$DIR/.pull.err"
  log "building the demo backend (the only service not released as an image)"
  "${COMPOSE[@]}" build --quiet backend
fi
if [[ "$MODE" != "images" ]]; then
  log "building the ouo collector distribution (ocb), Muninn and the demo backend"
  "${COMPOSE[@]}" build --quiet
fi

# --- 5. start + systemd ------------------------------------------------------------------
log "starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans
if [[ "$SYSTEMD" == "1" ]] && need systemctl; then
  log "installing systemd unit ouo.service"
  # The unit must run the same compose files as this install (build or images mode), or
  # `systemctl start` would recreate the stack differently. The ExecStart / ExecStop lines are
  # rewritten whatever the checked-out template says: a release before the
  # __OUO_COMPOSE_FILES__ placeholder (0.3.0 and older) hard-codes the build-mode files.
  files=""; for f in "${COMPOSE_FILES[@]}"; do files+=" -f $f"; done
  sed -E -e "s|__OUO_DIR__|$DIR|g" \
    -e "s|^ExecStart=/usr/bin/docker compose .* up |ExecStart=/usr/bin/docker compose$files up |" \
    -e "s|^ExecStop=/usr/bin/docker compose .* down|ExecStop=/usr/bin/docker compose$files down|" \
    deploy/vm/ouo.service > /etc/systemd/system/ouo.service
  systemctl daemon-reload
  # enable for boot, and start so `systemctl status ouo` reports active (exited); `start` is a
  # no-op on a re-run (the stack is already up), unlike `restart`, which would run `compose down`.
  systemctl enable --quiet --now ouo.service
fi

# --- 6. wait + print ---------------------------------------------------------------------
if [[ "$WAIT" == "1" ]]; then
  log "waiting for readiness (loopback ports)"
  OUO_ENV_FILE="$ENV_FILE" OUO_READY_TIMEOUT="${OUO_READY_TIMEOUT:-300}" deploy/scripts/wait-ready.sh
fi

SENTRY_PROJECT="$(get_env OUO_SENTRY_PROJECT_ID || true)"; SENTRY_PROJECT="${SENTRY_PROJECT:-1}"
SENTRY_UPSTREAM="$(get_env OUO_SENTRY_UPSTREAM || true)"; SENTRY_UPSTREAM="${SENTRY_UPSTREAM:-none, answered locally}"
cat <<SUMMARY

ouo is up.

  Grafana        https://$DOMAIN            login admin / $(get_env OUO_GRAFANA_ADMIN_PASSWORD)
  Collector      https://$OTEL_DOMAIN       OTLP/HTTP (/v1/traces, /v1/logs incl. replay, /v1/metrics)
  Sentry DSN     https://$(get_env OUO_SENTRY_PUBLIC_KEY || echo publickey0000000000000000000000)@$OTEL_DOMAIN/$SENTRY_PROJECT   (Sentry SDK bridge, ADR-0008; upstream: ${SENTRY_UPSTREAM})
  Project id     $PROJECT_ID
  Project token  $PT        (public: it goes into your SDK config)
  Basic header   Authorization: Basic $BASIC

  Browser SDK:  initRUM({ endpoint: "https://$OTEL_DOMAIN", projectId: "$PROJECT_ID", projectToken: "$PT", service: { name: "my-app", version: "1.0.0", environment: "production" } })
  Any OTel SDK: OTEL_EXPORTER_OTLP_ENDPOINT=https://$OTEL_DOMAIN OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20$BASIC

  Secrets stay in $ENV_FILE (Muninn tokens, MinIO and Grafana passwords). Firewall: allow 22, 80, 443 only.
  Another project:  echo "<id>:{SHA}\$(printf '%s' '<token>' | openssl dgst -binary -sha1 | openssl base64)" >> $HTPASSWD_FILE && systemctl restart ouo
  Upgrade:  re-run this script with --ref <tag>.   Logs: cd $DIR && ${COMPOSE[*]} logs -f
SUMMARY
if [[ "$(get_env OUO_TLS)" == "internal" ]]; then
  cat <<NOTE
  TLS is Caddy's internal CA (self-signed). Trust its root on your machine, or use --email for Let's Encrypt:
    cd $DIR && ${COMPOSE[*]} cp caddy:/data/caddy/pki/authorities/local/root.crt ./ouo-root.crt
NOTE
fi
