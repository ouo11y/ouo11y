#!/usr/bin/env bash
# Generate deploy/compose/quickstart.yaml: the whole stack in ONE compose file that a user
# copies into an empty folder, with no clone of this repo. The released ouo images replace
# the source builds, and every file compose.yaml bind-mounts (collector config + htpasswd,
# Loki, Tempo, Mimir, rum-api config, Grafana provisioning) is inlined as a top-level
# `configs:` entry with `content:`.
#
# The quickstart follows the latest release: the ouo images default to :latest, and the file
# records the version and digest it was generated for, the newest <image>-vX.Y.Z tag of each
# (rcs left out; release-images.yml moves :latest only to that one). Every config is read with
# `git archive` from the commit its image's release tag points at: collector/ from
# collector-v<x>, rum-api/ from rum-api-v<y>, grafana/ from grafana-v<z>; Loki, Tempo, Mimir and
# their upstream image tags from the newest of those three commits. Configs on main may already
# need a newer image (a released rum-api rejects config keys it does not know), so main's
# deploy/compose reaches the quickstart only when its image is released.
#
# Usage: deploy/scripts/gen-quickstart.sh              rewrite deploy/compose/quickstart.yaml
#                                                       (reads the digests from ghcr.io, anonymously)
#        deploy/scripts/gen-quickstart.sh --check      exit 1 when the committed file is stale or a
#                                                       newer release exists, its service blocks
#                                                       drift from the releases' compose files, the
#                                                       releases break docs/compatibility.md, or the
#                                                       pins in compose.images.yaml / .env.example
#                                                       are not the newest releases (CI; needs the
#                                                       release tags, fetch-depth 0)
#        ... --check --verify-digests                   also ask ghcr.io that the digests still match
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$ROOT/deploy/compose/quickstart.yaml"

# The newest final release of an image: highest <name>-vX.Y.Z tag, release candidates left out.
# It is the version :latest points at (release-images.yml moves :latest only to the newest).
newest() {
  git -C "$ROOT" tag -l "$1-v*" | sed -n "s/^$1-v\([0-9]*\.[0-9]*\.[0-9]*\)\$/\1/p" \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}
COLLECTOR="$(newest collector)"; RUM_API="$(newest rum-api)"; GRAFANA="$(newest grafana)"
for v in COLLECTOR RUM_API GRAFANA; do
  [[ -n "${!v}" ]] || { echo "gen-quickstart: no release tag for $v (git fetch --tags; CI needs fetch-depth: 0)" >&2; exit 1; }
done

# Each image's configs come from the commit its release tag points at, so a released image is
# never handed a config key it does not know. Loki, Tempo and Mimir belong to no ouo release:
# their configs and image tags come from the newest of the three release commits.
commit() { git -C "$ROOT" rev-parse --verify "refs/tags/$1^{commit}"; }
C_COLLECTOR="$(commit "collector-v$COLLECTOR")"; C_RUM_API="$(commit "rum-api-v$RUM_API")"
C_GRAFANA="$(commit "grafana-v$GRAFANA")"
C_NEWEST=""
for c in "$C_COLLECTOR" "$C_RUM_API" "$C_GRAFANA"; do
  if [[ -z "$C_NEWEST" ]] || git -C "$ROOT" merge-base --is-ancestor "$C_NEWEST" "$c"; then C_NEWEST="$c"; fi
done
for c in "$C_COLLECTOR" "$C_RUM_API" "$C_GRAFANA"; do
  git -C "$ROOT" merge-base --is-ancestor "$c" "$C_NEWEST" \
    || { echo "gen-quickstart: the release commits are not on one line of history" >&2; exit 1; }
done

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for c in "$C_COLLECTOR" "$C_RUM_API" "$C_GRAFANA" "$C_NEWEST"; do
  [[ -d "$TMP/$c" ]] && continue
  mkdir "$TMP/$c"; git -C "$ROOT" archive "$c" deploy/compose | tar -x -C "$TMP/$c"
done
at() { echo "$TMP/$1/deploy/compose"; }   # deploy/compose as of a release commit
C="$(at "$C_NEWEST")"
for t in "collector-v$COLLECTOR" "rum-api-v$RUM_API" "grafana-v$GRAFANA"; do
  [[ "$(commit "$t")" == "$C_NEWEST" ]] && { NEWEST_TAG="$t"; break; }
done
PLUGIN="$(git -C "$ROOT" show "$C_GRAFANA:plugins/ouo11y-rum-app/package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')"

# Tag of an upstream image in the newest release's compose.yaml.
upstream() { sed -n "s#^ *image: \(grafana/$1:[^ ]*\)\$#\1#p" "$C/compose.yaml" | head -1; }
LOKI="$(upstream loki)"; TEMPO="$(upstream tempo)"; MIMIR="$(upstream mimir)"
for v in PLUGIN LOKI TEMPO MIMIR; do
  [[ -n "${!v}" ]] || { echo "gen-quickstart: cannot read the $v version" >&2; exit 1; }
done

# Digest of the multi-arch index each tested version had when the file was generated. Writing
# the file asks the registry; --check reads them back from the committed file, and --check
# --verify-digests asks the registry again. The images are public, so the registry is read
# with an anonymous pull token, or with GHCR_TOKEN when it is set (CI passes GITHUB_TOKEN); no
# Docker credentials either way.
registry_digest() {
  local bearer
  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    bearer="$(printf %s "$GHCR_TOKEN" | base64 | tr -d '\n')"
  else
    bearer="$(curl -fsS "https://ghcr.io/token?scope=repository:ouo11y/$1:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  fi
  curl -fsSI -H "Authorization: Bearer $bearer" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://ghcr.io/v2/ouo11y/$1/manifests/$2" | tr -d '\r' | sed -n 's/^docker-content-digest: //Ip'
}
committed_digest() { sed -n "s/^#   $1 *$2 *\(sha256:[0-9a-f]*\) .*/\1/p" "$OUT" 2>/dev/null | head -1; }
digest() {
  local d
  if [[ "$MODE" == write ]]; then
    d="$(registry_digest "$1" "$2")" \
      || { echo "gen-quickstart: cannot read ghcr.io/ouo11y/$1:$2 (network, or no such tag)" >&2; exit 1; }
  else
    d="$(committed_digest "$1" "$2")"
    [[ -n "$d" ]] || d="sha256:unknown"   # renders differently, so the check reports it stale
  fi
  echo "$d"
}
MODE="write"; VERIFY=false
[[ "${1:-}" == "--check" ]] && MODE=check
[[ "${2:-}" == "--verify-digests" ]] && VERIFY=true
D_COLLECTOR="$(digest collector "$COLLECTOR")"; D_RUM_API="$(digest rum-api "$RUM_API")"
D_GRAFANA="$(digest grafana "$GRAFANA")"

RELEASE="collector $COLLECTOR, rum-api $RUM_API, grafana $GRAFANA with plugin $PLUGIN"

# One `configs:` entry. Compose interpolates `content`, so every `$` is doubled: the file
# reaches the container byte for byte (${env:...} for the collector, ${OUO_READ_TOKEN} for
# the Grafana provisioner, $${...} escapes in datasources.yaml all stay as they are).
inline() { # $1 config name, $2 release tag it comes from, $3 path under deploy/compose
  printf '  %s:\n    # deploy/compose/%s at %s\n    content: |\n' "$1" "$3" "$2"
  sed -e 's/\$/$$/g' -e 's/^/      /' -e 's/^ *$//' "$(at "$(commit "$2")")/$3"
}

render() {
  sed -e "s#@COLLECTOR@#$COLLECTOR#g" -e "s#@RUM_API@#$RUM_API#g" -e "s#@GRAFANA@#$GRAFANA#g" \
      -e "s#@D_COLLECTOR@#$D_COLLECTOR#g" -e "s#@D_RUM_API@#$D_RUM_API#g" -e "s#@D_GRAFANA@#$D_GRAFANA#g" \
      -e "s#@PLUGIN@#$PLUGIN#g" -e "s#@NEWEST@#$NEWEST_TAG#g" \
      -e "s#@LOKI@#$LOKI#g" -e "s#@TEMPO@#$TEMPO#g" -e "s#@MIMIR@#$MIMIR#g" <<'EOF'
# ouo quickstart: the whole local stack in one file, on the latest ouo release.
# GENERATED by deploy/scripts/gen-quickstart.sh; do not edit by hand.
#
# The ouo images default to :latest, the newest release. This file was generated for, and its
# configs come from, these releases (digest = the multi-arch image index at that version):
#
#   collector  @COLLECTOR@  @D_COLLECTOR@  OUO_COLLECTOR_VERSION
#   rum-api    @RUM_API@  @D_RUM_API@  OUO_RUM_API_VERSION
#   grafana    @GRAFANA@  @D_GRAFANA@  OUO_GRAFANA_VERSION (plugin ouo11y-rum-app @PLUGIN@)
#
# To stay on exactly these, put e.g. OUO_GRAFANA_VERSION=@GRAFANA@ (or @GRAFANA@@sha256:...) in a .env
# file next to this one. Each config below comes from its image's release commit; Loki, Tempo
# and Mimir from @NEWEST@. A later release that needs new configs comes with a regenerated
# file: fetch it again (deploy/compose/quickstart.yaml in the ouo11y/ouo11y repo).
#
# Copy this file into an empty folder as compose.yaml, then (the images are public, no docker login):
#
#   docker compose up -d
#
# Grafana          http://localhost:3000      admin / testing567, More apps -> ouo11y RUM
# OTLP/HTTP        http://localhost:4318      /v1/traces /v1/logs /v1/metrics
# Replay           http://localhost:4319      /v1/replay/chunks
# Credential       HTTP Basic, project id `demo`, project token `pt_dev_demo_0000000000000000`
#                  (Authorization: Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw)
#
# Ports collide? Set OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT, ... in a .env
# file next to this one (names and defaults: deploy/compose/.env.example in the repo). An SDK
# then needs both URLs, e.g. endpoint :14318 and replayEndpoint :14319.
# Stop: `docker compose down`; wipe the data too: `docker compose down -v`.
#
# Development tokens only (they are public): fine on a laptop, never on a reachable host.
# A server install is deploy/vm/install.sh. Needs Docker Compose >= 2.24 (`configs.content`).
#
# No `name:` on purpose: the project is named after the folder, so two copies of this file in
# two folders are two separate stacks (a fixed name would make `down -v` in one remove the other).

services:
  grafana:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/grafana:${OUO_GRAFANA_VERSION:-latest}
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${OUO_GRAFANA_ADMIN_PASSWORD:-testing567}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_DEFAULT_THEME: dark
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: ouo11y-rum-app
      GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS: ouo11y-rum-app
      # Read by the plugin provisioning file; must equal rum-api's OUO_READ_TOKEN.
      OUO_READ_TOKEN: ${OUO_READ_TOKEN:-rt_dev_0000000000000000}
      # Grafana feature toggles the plugin can use (comma-separated), empty by default.
      OUO_FEATURE_TOGGLES_ENABLE: ${OUO_FEATURE_TOGGLES_ENABLE:-}
    configs:
      - source: grafana-datasources
        target: /etc/grafana/provisioning/datasources/datasources.yaml
      - source: grafana-plugin-app
        target: /etc/grafana/provisioning/plugins/ouo11y-rum-app.yaml
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      grafana-plugin:
        condition: service_completed_successfully
      loki:
        condition: service_started
      tempo:
        condition: service_started
      mimir:
        condition: service_started
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 30

  # The grafana-data volume hides the plugin the image ships in /var/lib/grafana/plugins;
  # copy it onto the volume before every start so an image upgrade also upgrades the plugin.
  grafana-plugin:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/grafana:${OUO_GRAFANA_VERSION:-latest}
    entrypoint: ["sh", "-ec"]
    command:
      - |
        mkdir -p /pvc/plugins
        rm -rf /pvc/plugins/ouo11y-rum-app
        cp -a /var/lib/grafana/plugins/ouo11y-rum-app /pvc/plugins/ouo11y-rum-app
        echo "ouo11y-rum-app $$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /pvc/plugins/ouo11y-rum-app/plugin.json | head -1) installed"
    volumes:
      - grafana-data:/pvc
    restart: "no"

  loki:
    image: @LOKI@
    command: ["-config.file=/etc/loki/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_LOKI_PORT:-3100}:3100"
    environment:
      OUO_RETENTION_LOGS: ${OUO_RETENTION_LOGS:-720h}
      OUO_LOKI_COMPACTION_INTERVAL: ${OUO_LOKI_COMPACTION_INTERVAL:-10m}
      OUO_LOKI_RETENTION_DELETE_DELAY: ${OUO_LOKI_RETENTION_DELETE_DELAY:-2h}
      OUO_LOKI_DELETE_CANCEL_PERIOD: ${OUO_LOKI_DELETE_CANCEL_PERIOD:-24h}
    configs:
      - source: loki
        target: /etc/loki/config.yaml
      - source: loki-runtime
        target: /etc/loki/runtime.yaml
    volumes:
      - loki-data:/loki

  tempo:
    image: @TEMPO@
    command: ["-config.file=/etc/tempo/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_TEMPO_PORT:-3200}:3200"
    environment:
      OUO_RETENTION_TRACES: ${OUO_RETENTION_TRACES:-336h}
    configs:
      - source: tempo
        target: /etc/tempo/config.yaml
    volumes:
      - tempo-data:/var/tempo

  mimir:
    image: @MIMIR@
    command: ["-config.file=/etc/mimir/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_MIMIR_PORT:-9009}:9009"
    environment:
      OUO_RETENTION_METRICS: ${OUO_RETENTION_METRICS:-2160h}
    configs:
      - source: mimir
        target: /etc/mimir/config.yaml
    volumes:
      - mimir-data:/data

  # The only ingest (ADR-0007): OTLP on 4318 and replay chunks on 4319, both behind HTTP
  # Basic project credentials checked against the projects-htpasswd config below.
  otel-collector:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/collector:${OUO_COLLECTOR_VERSION:-latest}
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_OTLP_GRPC_PORT:-4317}:4317"
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_REPLAY_PORT:-4319}:4319"
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      OUO_INGEST_TOKEN: ${OUO_INGEST_TOKEN:-it_dev_0000000000000000}
      OUO_ALLOWED_ORIGINS: ${OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
      OUO_RATELIMIT_CLIENT_KEY: ${OUO_RATELIMIT_CLIENT_KEY:-address}
      OUO_RATELIMIT_PROJECT_RATE: ${OUO_RATELIMIT_PROJECT_RATE:-1000}
      OUO_RATELIMIT_PROJECT_BURST: ${OUO_RATELIMIT_PROJECT_BURST:-5000}
      OUO_RATELIMIT_CLIENT_RATE: ${OUO_RATELIMIT_CLIENT_RATE:-100}
      OUO_RATELIMIT_CLIENT_BURST: ${OUO_RATELIMIT_CLIENT_BURST:-300}
      OUO_SENTRY_UPSTREAM: ${OUO_SENTRY_UPSTREAM:-none}
      OUO_SENTRY_PROJECT_ID: ${OUO_SENTRY_PROJECT_ID:-1}
      OUO_SENTRY_PUBLIC_KEY: ${OUO_SENTRY_PUBLIC_KEY:-publickey0000000000000000000000}
      OUO_SENTRY_SERVICE_NAME: ${OUO_SENTRY_SERVICE_NAME:-sentry-demo}
    configs:
      - source: collector
        target: /etc/otelcol/config.yaml
      - source: projects-htpasswd
        target: /etc/otelcol/projects.htpasswd
    depends_on:
      - loki
      - tempo
      - mimir

  # Internal: replay chunk sink and the plugin's API. SDKs never talk to it.
  rum-api:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/rum-api:${OUO_RUM_API_VERSION:-latest}
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_RUM_API_PORT:-8080}:8080"
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}
      OUO_INGEST_TOKEN: ${OUO_INGEST_TOKEN:-it_dev_0000000000000000}
      OUO_READ_TOKEN: ${OUO_READ_TOKEN:-rt_dev_0000000000000000}
      # Operator API /v1/admin/* and the per-project source-map upload tokens (ADR-0011).
      OUO_ADMIN_TOKEN: ${OUO_ADMIN_TOKEN:-at_dev_0000000000000000}
      OUO_UPLOAD_TOKENS: ${OUO_UPLOAD_TOKENS:-demo:ut_dev_demo_0000000000000000}
      REPLAY_RETENTION: ${OUO_RETENTION_REPLAYS:-720h}
      LOG_RETENTION: ${OUO_RETENTION_LOGS:-720h}
      REPLAY_SWEEP_INTERVAL: ${OUO_REPLAY_SWEEP_INTERVAL:-1h}
      # The image runs as nonroot. A named volume mounted on the existing nonroot home is
      # seeded with that owner; one mounted on /data would be root-owned and unwritable.
      DATA_DIR: /home/nonroot
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: ${OUO_BACKEND_OTLP_HEADERS:-Authorization=Basic%20aW50ZXJuYWw6cHRfZGV2X2ludGVybmFsXzAwMDAwMDAwMDAwMDAw}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: rum-api
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=local
    configs:
      - source: rum-api
        target: /etc/rum-api/config.yaml
    volumes:
      - rum-api-data:/home/nonroot
    depends_on:
      - loki
      - tempo
      - otel-collector

volumes:
  grafana-data:
  loki-data:
  tempo-data:
  mimir-data:
  rum-api-data:

EOF
  echo "configs:"
  inline collector "collector-v$COLLECTOR" collector/config.yaml
  inline projects-htpasswd "collector-v$COLLECTOR" collector/projects.htpasswd
  inline loki "$NEWEST_TAG" loki/config.yaml
  inline loki-runtime "$NEWEST_TAG" loki/runtime.yaml
  inline tempo "$NEWEST_TAG" tempo/config.yaml
  inline mimir "$NEWEST_TAG" mimir/config.yaml
  inline rum-api "rum-api-v$RUM_API" rum-api/config.yaml
  inline grafana-datasources "grafana-v$GRAFANA" grafana/provisioning/datasources/datasources.yaml
  inline grafana-plugin-app "grafana-v$GRAFANA" grafana/provisioning/plugins/ouo11y-rum-app.yaml
}

# The service blocks above are written by hand, so --check also compares them with the
# released stack as Compose itself resolves it (compose.yaml + compose.images.yaml at the
# release commit the service's configs come from, variables left uninterpolated): same
# services, images (up to the version default), commands, environment and ports, and every
# read-only file compose.yaml bind-mounts is a config at the same target. Allowed differences:
# no backend / minio (source build, s3 profile), rum-api's data dir, and the grafana-plugin
# init service when the release does not have it yet.
resolved() { (cd "$(at "$1")" && docker compose -f compose.yaml -f compose.images.yaml config --no-interpolate --format json); }
check_services() {
  python3 - <(resolved "$C_NEWEST") <(resolved "$C_COLLECTOR") <(resolved "$C_RUM_API") <(resolved "$C_GRAFANA") \
    <(docker compose -f "$OUT" config --no-interpolate --format json) <<'PY'
import json, os, re, sys
load = lambda p: json.load(open(p))["services"]
newest, collector, rum_api, grafana, qs = map(load, sys.argv[1:])
by_service = {"otel-collector": collector, "rum-api": rum_api, "grafana": grafana, "grafana-plugin": grafana}
SKIP, EXTRA_ENV, EXTRA_SERVICES = {"backend", "minio", "minio-init"}, {"rum-api": {"DATA_DIR"}}, {"grafana-plugin"}
# ${OUO_X_VERSION:-0.5.0} in compose.images.yaml, ${OUO_X_VERSION:-latest} in the quickstart.
unpin = lambda image: re.sub(r"(_VERSION):-[^}]*\}", r"\1}", image or "")
errors = [f"service {n} is in compose.yaml but not in quickstart.yaml" for n in newest if n not in SKIP and n not in qs]
for name, q in qs.items():
    r = by_service.get(name, newest).get(name)
    if r is None:
        if name not in EXTRA_SERVICES:
            errors.append(f"service {name} is in quickstart.yaml but not in compose.yaml")
        continue
    for key in ("image", "command", "entrypoint", "ports"):
        rv, qv = r.get(key), q.get(key)
        if key == "image":
            rv, qv = unpin(rv), unpin(qv)
        if rv != qv:
            errors.append(f"{name}.{key}: compose {rv!r} != quickstart {qv!r}")
    renv, qenv = r.get("environment") or {}, q.get("environment") or {}
    for k in sorted(set(renv) | set(qenv)):
        if renv.get(k) != qenv.get(k) and k not in EXTRA_ENV.get(name, ()):
            errors.append(f"{name}.environment.{k}: compose {renv.get(k)!r} != quickstart {qenv.get(k)!r}")
    want = set()
    for v in r.get("volumes") or []:
        if v.get("type") != "bind" or not v.get("read_only"):
            continue  # named volumes and writable data dirs are not configs
        src = v["source"]
        if os.path.isdir(src):
            want |= {os.path.join(v["target"], os.path.relpath(os.path.join(d, f), src))
                     for d, _, fs in os.walk(src) for f in fs if not f.startswith(".")}
        else:
            want.add(v["target"])
    have = {c["target"] for c in q.get("configs") or []}
    for t in sorted(want - have):
        errors.append(f"{name}: compose.yaml mounts {t}, quickstart.yaml has no config for it")
for e in errors:
    print("quickstart:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
}

# The release set must be one docs/compatibility.md allows: every `Needs <x>` minimum of the
# collector, rum-api, grafana and plugin lines in use is met by the others.
check_compat() {
  python3 - "$ROOT/docs/compatibility.md" "$COLLECTOR" "$RUM_API" "$GRAFANA" "$PLUGIN" <<'PY'
import sys
md, *vs = sys.argv[1:]
have = dict(zip(("collector", "rum-api", "grafana", "plugin"), vs))
ver = lambda v: tuple(int(x) for x in v.split("-")[0].split("."))
lines = open(md).read().split("<!-- compat:lines -->", 1)[1].strip().split("\n")
cells = lambda l: [c.strip() for c in l.strip().strip("|").split("|")]
head, rows = cells(lines[0]), [cells(l) for l in lines[2:] if l.startswith("|")]
errors = []
for comp, v in have.items():
    row = next((r for r in rows if r[0] == comp and r[1] == ".".join(v.split(".")[:2])), None)
    if row is None:
        errors.append(f"docs/compatibility.md has no {comp} {'.'.join(v.split('.')[:2])} line")
        continue
    for col, cell in zip(head, row):
        need = col.removeprefix("Needs ")
        if col.startswith("Needs ") and need in have and cell.startswith(">= ") and ver(have[need]) < ver(cell[3:]):
            errors.append(f"{comp} {v} needs {need} {cell}, the newest {need} release is {have[need]}")
for e in errors:
    print("quickstart:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
}

# The in-repo pins (compose.images.yaml, .env.example) stay exact versions, at the newest
# releases, so a checkout's released-images path does not fall behind the quickstart.
check_pins() {
  local ok=true name pins file pin
  for name in COLLECTOR RUM_API GRAFANA; do
    for file in compose.images.yaml .env.example; do
      pins="$(sed -n -e "s/.*\${OUO_${name}_VERSION:-\([^}]*\)}.*/\1/p" -e "s/^OUO_${name}_VERSION=//p" \
        "$ROOT/deploy/compose/$file" | sort -u)"
      for pin in ${pins:-none}; do
        if [[ "$pin" != "${!name}" ]]; then
          echo "quickstart: deploy/compose/$file pins OUO_${name}_VERSION to $pin, the newest release is ${!name}" >&2
          ok=false
        fi
      done
    done
  done
  $ok
}

check_digests() {
  local ok=true image name digest got
  for image in collector:COLLECTOR rum-api:RUM_API grafana:GRAFANA; do
    name="${image#*:}"; image="${image%%:*}"; digest="D_$name"
    got="$(registry_digest "$image" "${!name}" || true)"
    if [[ "$got" != "${!digest}" ]]; then
      echo "quickstart: ghcr.io/ouo11y/$image:${!name} is ${got:-unreadable}, quickstart.yaml says ${!digest}" >&2
      ok=false
    fi
  done
  $ok
}

if [[ "$MODE" == check ]]; then
  if ! diff -u "$OUT" <(render) >&2; then
    echo "deploy/compose/quickstart.yaml is stale or a newer release exists: run deploy/scripts/gen-quickstart.sh and commit it" >&2
    exit 1
  fi
  if ! check_services; then
    echo "deploy/compose/quickstart.yaml services differ from the released compose.yaml: update the service blocks in deploy/scripts/gen-quickstart.sh" >&2
    exit 1
  fi
  check_compat || { echo "the newest releases are not a compatible set (docs/compatibility.md)" >&2; exit 1; }
  check_pins || { echo "bump the pins to the newest releases (docs/releasing.md, after the tag)" >&2; exit 1; }
  if $VERIFY; then
    check_digests || { echo "cannot read a digest (network / GHCR_TOKEN), or a tag was re-pushed: run deploy/scripts/gen-quickstart.sh and commit it" >&2; exit 1; }
  fi
  echo "quickstart.yaml is up to date ($RELEASE)"
else
  render > "$OUT"
  echo "wrote $OUT ($RELEASE)"
fi
