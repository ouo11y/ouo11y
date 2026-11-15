#!/usr/bin/env bash
# Generate deploy/compose/quickstart.yaml: the whole stack in ONE compose file that a user
# copies into an empty folder, with no clone of this repo. The released ouo images (collector,
# Muninn) replace the source builds, and every file compose.yaml bind-mounts (collector config +
# htpasswd, Loki, Tempo, Mimir, Muninn config, Grafana provisioning) is inlined as a top-level
# `configs:` entry with `content:`.
#
# The quickstart follows the latest release: the ouo images default to :latest, and the file
# records the version and digest it was generated for, the newest <image>-vX.Y.Z tag of each
# (rcs left out; release-images.yml moves :latest only to that one). The configs and the upstream
# image tags (Grafana, Loki, Tempo, Mimir) are read from deploy/compose of this checkout, so a
# config change reaches the quickstart with the next regeneration. Keep those configs loadable by
# the newest released images: collector 0.5.0 has every component ./collector/config.yaml uses
# (otlp_http, file_storage, routing), Muninn 0.2.0 every key of ./muninn/config.yaml.
#
# Usage: deploy/scripts/gen-quickstart.sh              rewrite deploy/compose/quickstart.yaml
#                                                       (reads the digests from ghcr.io, anonymously)
#        deploy/scripts/gen-quickstart.sh --check      exit 1 when the committed file is stale or a
#                                                       newer release exists, its service blocks
#                                                       drift from compose.yaml + compose.images.yaml,
#                                                       the releases break docs/compatibility.md, or
#                                                       the pins in compose.images.yaml / .env.example
#                                                       are not the newest releases (CI; needs the
#                                                       release tags, fetch-depth 0)
#        ... --check --verify-digests                   also ask ghcr.io that the digests still match
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
C="$ROOT/deploy/compose"
OUT="$C/quickstart.yaml"

# The newest final release of an image: highest <name>-vX.Y.Z tag, release candidates left out.
# It is the version :latest points at (release-images.yml moves :latest only to the newest).
newest() {
  git -C "$ROOT" tag -l "$1-v*" | sed -n "s/^$1-v\([0-9]*\.[0-9]*\.[0-9]*\)\$/\1/p" \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}
COLLECTOR="$(newest collector)"; MUNINN="$(newest muninn)"
for v in COLLECTOR MUNINN; do
  [[ -n "${!v}" ]] || { echo "gen-quickstart: no release tag for $v (git fetch --tags; CI needs fetch-depth: 0)" >&2; exit 1; }
done

# Tag of an upstream image in compose.yaml.
upstream() { sed -n "s#^ *image: \(grafana/$1:[^ ]*\)\$#\1#p" "$C/compose.yaml" | head -1; }
GRAFANA="$(upstream grafana)"; LOKI="$(upstream loki)"; TEMPO="$(upstream tempo)"; MIMIR="$(upstream mimir)"
for v in GRAFANA LOKI TEMPO MIMIR; do
  [[ -n "${!v}" ]] || { echo "gen-quickstart: cannot read the $v image" >&2; exit 1; }
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
D_COLLECTOR="$(digest collector "$COLLECTOR")"; D_MUNINN="$(digest muninn "$MUNINN")"

RELEASE="collector $COLLECTOR, muninn $MUNINN"

# One `configs:` entry. Compose interpolates `content`, so every `$` is doubled: the file
# reaches the container byte for byte (${env:...} for the collector, ${...} for Muninn,
# $${...} escapes in datasources.yaml all stay as they are).
inline() { # $1 config name, $2 path under deploy/compose
  printf '  %s:\n    # deploy/compose/%s\n    content: |\n' "$1" "$2"
  sed -e 's/\$/$$/g' -e 's/^/      /' -e 's/^ *$//' "$C/$2"
}

render() {
  sed -e "s#@COLLECTOR@#$COLLECTOR#g" -e "s#@MUNINN@#$MUNINN#g" \
      -e "s#@D_COLLECTOR@#$D_COLLECTOR#g" -e "s#@D_MUNINN@#$D_MUNINN#g" \
      -e "s#@GRAFANA@#$GRAFANA#g" -e "s#@LOKI@#$LOKI#g" -e "s#@TEMPO@#$TEMPO#g" -e "s#@MIMIR@#$MIMIR#g" <<'EOF'
# ouo quickstart: the whole local stack in one file, on the latest ouo release.
# GENERATED by deploy/scripts/gen-quickstart.sh; do not edit by hand.
#
# The ouo images default to :latest, the newest release. This file was generated for these
# releases (digest = the multi-arch image index at that version):
#
#   collector  @COLLECTOR@  @D_COLLECTOR@  OUO_COLLECTOR_VERSION
#   muninn     @MUNINN@  @D_MUNINN@  OUO_MUNINN_VERSION
#
# To stay on exactly these, put e.g. OUO_MUNINN_VERSION=@MUNINN@ (or @MUNINN@@sha256:...) in a .env
# file next to this one. A later release that needs new configs comes with a regenerated file:
# fetch it again (deploy/compose/quickstart.yaml in the ouo11y/ouo11y repo).
#
# Copy this file into an empty folder as compose.yaml, then (the images are public, no docker login):
#
#   docker compose up -d
#
# Grafana          http://localhost:3000      admin / testing567 (Explore: Loki, Tempo, Mimir)
# OTLP/HTTP        http://localhost:4318      /v1/traces /v1/logs /v1/metrics (replay: scope ouo.replay on /v1/logs)
# Sentry bridge    http://localhost:4320      Sentry SDK DSN host (ADR-0008)
# Muninn           http://127.0.0.1:3400      replay store, read token mrt_dev_0000000000000000
# Credential       HTTP Basic, project id `demo`, project token `pt_dev_demo_0000000000000000`
#                  (Authorization: Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw)
#
# Ports collide? Set OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_MUNINN_PORT, ... in a .env
# file next to this one (names and defaults: deploy/compose/.env.example in the repo).
# Stop: `docker compose down`; wipe the data too: `docker compose down -v`.
#
# Development tokens only (they are public): fine on a laptop, never on a reachable host.
# A server install is deploy/vm/install.sh. Needs Docker Compose >= 2.24 (`configs.content`).
#
# No `name:` on purpose: the project is named after the folder, so two copies of this file in
# two folders are two separate stacks (a fixed name would make `down -v` in one remove the other).

services:
  grafana:
    image: @GRAFANA@
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${OUO_GRAFANA_ADMIN_PASSWORD:-testing567}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_DEFAULT_THEME: dark
    configs:
      - source: grafana-datasources
        target: /etc/grafana/provisioning/datasources/datasources.yaml
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - loki
      - tempo
      - mimir
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 30

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

  # The only ingest (ADR-0007): OTLP on 4318 behind HTTP Basic project credentials checked
  # against the projects-htpasswd config below, the Sentry bridge on 4320. Replay chunks
  # (scope ouo.replay on /v1/logs) go to Muninn through a disk queue.
  otel-collector:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/collector:${OUO_COLLECTOR_VERSION:-latest}
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_OTLP_GRPC_PORT:-4317}:4317"
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      MUNINN_ENDPOINT: http://muninn:3400
      MUNINN_INGEST_TOKEN: ${OUO_MUNINN_INGEST_TOKEN:-mit_dev_0000000000000000}
      MUNINN_TENANT: anonymous
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
    volumes:
      - replay-queue:/var/lib/otelcol/replay-queue
    depends_on:
      - loki
      - tempo
      - mimir

  # MinIO: Muninn's object store (internal).
  minio:
    image: ${OUO_MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}
    command: ["server", "/data", "--console-address", ":9001"]
    ports:
      - "127.0.0.1:${OUO_MINIO_PORT:-9000}:9000"
      - "127.0.0.1:${OUO_MINIO_CONSOLE_PORT:-9001}:9001"
    environment:
      MINIO_ROOT_USER: ${OUO_MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${OUO_MINIO_ROOT_PASSWORD:-minioadmin}
    volumes:
      - minio-data:/data

  # Bucket and a Muninn user whose policy reaches only that bucket. Idempotent.
  muninn-init:
    image: ${OUO_MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}
    depends_on:
      - minio
    environment:
      MINIO_ROOT_USER: ${OUO_MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${OUO_MINIO_ROOT_PASSWORD:-minioadmin}
      BUCKET: ${OUO_MUNINN_S3_BUCKET:-ouo-muninn}
      MUNINN_KEY: ${OUO_MUNINN_S3_ACCESS_KEY:-muninn}
      MUNINN_SECRET: ${OUO_MUNINN_S3_SECRET_KEY:-muninn-dev-secret-0000}
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - |
        i=0; until mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
          i=$$((i+1)); [ $$i -lt 60 ] || { echo "minio not reachable"; exit 1; }; sleep 1; done
        mc ready local
        mc mb --ignore-existing "local/$$BUCKET"
        cat > /tmp/muninn-policy.json <<POLICY
        {"Version":"2012-10-17","Statement":[
          {"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::$$BUCKET"]},
          {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:GetObjectTagging","s3:PutObjectTagging"],"Resource":["arn:aws:s3:::$$BUCKET/*"]}]}
        POLICY
        mc admin policy create local muninn /tmp/muninn-policy.json
        mc admin user add local "$$MUNINN_KEY" "$$MUNINN_SECRET"
        mc admin policy attach local muninn --user "$$MUNINN_KEY" || true
        echo "bucket $$BUCKET and user $$MUNINN_KEY ready"

  # Muninn (ADR-0019): the internal replay store. SDKs never talk to it.
  muninn:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/muninn:${OUO_MUNINN_VERSION:-latest}
    command: ["-config.file=/etc/muninn/config.yaml", "-config.expand-env=true"]
    ports:
      - "127.0.0.1:${OUO_MUNINN_PORT:-3400}:3400"
    environment:
      MUNINN_INGEST_TOKEN: ${OUO_MUNINN_INGEST_TOKEN:-mit_dev_0000000000000000}
      MUNINN_READ_TOKEN: ${OUO_MUNINN_READ_TOKEN:-mrt_dev_0000000000000000}
      MUNINN_ADMIN_TOKEN: ${OUO_MUNINN_ADMIN_TOKEN:-mat_dev_0000000000000000}
      OUO_UPLOAD_TOKEN_DEMO: ${OUO_UPLOAD_TOKEN_DEMO:-ut_dev_demo_0000000000000000}
      MUNINN_S3_BUCKET: ${OUO_MUNINN_S3_BUCKET:-ouo-muninn}
      MUNINN_S3_ACCESS_KEY: ${OUO_MUNINN_S3_ACCESS_KEY:-muninn}
      MUNINN_S3_SECRET_KEY: ${OUO_MUNINN_S3_SECRET_KEY:-muninn-dev-secret-0000}
      OUO_RETENTION_REPLAYS: ${OUO_RETENTION_REPLAYS:-720h}
      OUO_REPLAY_SWEEP_INTERVAL: ${OUO_REPLAY_SWEEP_INTERVAL:-1h}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: ${OUO_BACKEND_OTLP_HEADERS:-Authorization=Basic%20aW50ZXJuYWw6cHRfZGV2X2ludGVybmFsXzAwMDAwMDAwMDAwMDAw}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: muninn
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=local
    configs:
      - source: muninn
        target: /etc/muninn/config.yaml
    depends_on:
      muninn-init:
        condition: service_completed_successfully

volumes:
  grafana-data:
  loki-data:
  tempo-data:
  mimir-data:
  minio-data:
  replay-queue:

EOF
  echo "configs:"
  inline collector collector/config.yaml
  inline projects-htpasswd collector/projects.htpasswd
  inline loki loki/config.yaml
  inline loki-runtime loki/runtime.yaml
  inline tempo tempo/config.yaml
  inline mimir mimir/config.yaml
  inline muninn muninn/config.yaml
  inline grafana-datasources grafana/provisioning/datasources/datasources.yaml
}

# The service blocks above are written by hand, so --check also compares them with the stack
# as Compose itself resolves it (compose.yaml + compose.images.yaml, variables left
# uninterpolated): same services, images (up to the version default), commands, entrypoints,
# environment and ports, and every read-only file compose.yaml bind-mounts is a config at the
# same target. Allowed difference: no backend (demo code built from source).
check_services() {
  python3 - <(cd "$C" && docker compose -f compose.yaml -f compose.images.yaml config --no-interpolate --format json) \
    <(docker compose -f "$OUT" config --no-interpolate --format json) <<'PY'
import json, os, re, sys
load = lambda p: json.load(open(p))["services"]
ref, qs = map(load, sys.argv[1:])
SKIP = {"backend"}
# ${OUO_X_VERSION:-0.5.0} in compose.images.yaml, ${OUO_X_VERSION:-latest} in the quickstart.
unpin = lambda image: re.sub(r"(_VERSION):-[^}]*\}", r"\1}", image or "")
errors = [f"service {n} is in compose.yaml but not in quickstart.yaml" for n in ref if n not in SKIP and n not in qs]
for name, q in qs.items():
    r = ref.get(name)
    if r is None:
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
        if renv.get(k) != qenv.get(k):
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
# collector and Muninn lines in use is met by the others.
check_compat() {
  python3 - "$ROOT/docs/compatibility.md" "$COLLECTOR" "$MUNINN" <<'PY'
import sys
md, *vs = sys.argv[1:]
have = dict(zip(("collector", "muninn"), vs))
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
  for name in COLLECTOR MUNINN; do
    for file in compose.images.yaml .env.example; do
      pins="$(sed -n -e "s/.*\${OUO_${name}_VERSION:-\([^}]*\)}.*/\1/p" -e "s/^OUO_${name}_VERSION=//p" \
        "$C/$file" | sort -u)"
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
  for image in collector:COLLECTOR muninn:MUNINN; do
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
    echo "deploy/compose/quickstart.yaml services differ from compose.yaml: update the service blocks in deploy/scripts/gen-quickstart.sh" >&2
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
