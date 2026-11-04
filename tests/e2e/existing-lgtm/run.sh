#!/usr/bin/env bash
# Verifies docs/operations/existing-lgtm.md end to end: ouo (built from this tree) on a
# customer's existing, single-tenant Loki / Tempo / Mimir behind the customer's own OTel
# Collector (compose.yaml here), with Loki's default OTLP labels plus ouo's additive block.
#
#   tests/e2e/existing-lgtm/run.sh [--multitenant] [--keep]
#
# Steps (each fails the run with a FAIL line):
#   1. client Loki with its defaults only; the client's own logs; their stream labels recorded
#   2. Loki restarted with loki.client-plus-ouo.yaml; the defaults are still in /config
#   3. ouo up with compose.images.yaml (Grafana) + compose.external.yaml, collector and rum-api
#      built from this tree; deploy/scripts/e2e.sh against it
#   4. the client's logs again: same single series, same labels; ouo's streams have its labels
#   5. delete by user through rum-api; processed by the client's compactor; only that user's
#      lines are gone
#   6. (--multitenant) Loki with auth_enabled: true, OUO_LGTM_TENANT_ID, logs straight to Loki:
#      e2e.sh again, the run's lines are in the tenant, a delete lands in the tenant
# Two compose projects (OUO_R4_PROJECT, default r4lgtm: <p>-client and <p>-ouo) on host ports
# 20810-20827 (OUO_CLIENT_*_PORT / the ouo env below); both are torn down at the end unless --keep.
# Needs Docker Compose >= 2.24, node 24, python3, curl. The Mac has no `timeout`: bound the
# whole run with perl -e 'alarm 2400; exec @ARGV' tests/e2e/existing-lgtm/run.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
P="${OUO_R4_PROJECT:-r4lgtm}"
MT=0; KEEP=0
for a in "$@"; do case "$a" in --multitenant) MT=1 ;; --keep) KEEP=1 ;; *) echo "unknown argument $a" >&2; exit 2 ;; esac; done

LOKI=http://localhost:${OUO_CLIENT_LOKI_PORT:-20810}
CLIENT_OTLP=http://localhost:${OUO_CLIENT_OTLP_HTTP_PORT:-20814}
TMP="$(mktemp -d)"
ADMIN=at_dev_0000000000000000

client() { docker compose --progress quiet -p "$P-client" -f "$HERE/compose.yaml" "$@"; }
ouo() {
  docker compose --progress quiet -p "$P-ouo" --env-file "$TMP/ouo.env" -f "$ROOT/deploy/compose/compose.yaml" \
    -f "$ROOT/deploy/compose/compose.images.yaml" -f "$ROOT/deploy/compose/compose.external.yaml" \
    -f "$TMP/build.yaml" "$@"
}
cleanup() {
  if (( KEEP == 0 )); then
    ouo down -v >/dev/null 2>&1 || true
    client down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# e2e <result.json>: deploy/scripts/e2e.sh against ouo; the last line, or the whole log on failure.
e2e() {
  local log="${1%.json}.log"
  if OUO_ENV_FILE="$TMP/ouo.env" "$ROOT/deploy/scripts/e2e.sh" --out "$1" > "$log" 2>&1; then
    tail -1 "$log"
  else
    cat "$log" >&2; fail "deploy/scripts/e2e.sh"
  fi
}
wait_loki() { for _ in $(seq 60); do [[ "$(curl -s "$LOKI/ready")" == ready ]] && return 0; sleep 2; done; fail "client Loki not ready"; }
# loki_get <path> [curl args...]: GET on the client Loki, tenant header when set
loki_get() { local p="$1"; shift; curl -sfG ${TENANT:+-H "X-Scope-OrgID: $TENANT"} "$LOKI$p" "$@"; }
count() { # count <LogQL selector + filters>: lines in the last 2 h
  loki_get /loki/api/v1/query --data-urlencode "query=sum(count_over_time($1 [2h]))" --data-urlencode "time=$(date +%s)" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else 0)'
}
client_series() {
  loki_get /loki/api/v1/series --data-urlencode 'match[]={service_name="juhi-care-api"}' --data-urlencode "start=$(( $(date +%s) - 7200 ))" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; print(len(d), ",".join(sorted(d[0])) if d else "")'
}

# ouo's environment: ports 20820-20827, the client stack as the existing LGTM.
cat > "$TMP/ouo.env" <<EOF
OUO_GRAFANA_PORT=20820
OUO_OTLP_HTTP_PORT=20821
OUO_REPLAY_PORT=20822
OUO_SENTRY_PORT=20823
OUO_OTLP_GRPC_PORT=20824
OUO_COLLECTOR_HEALTH_PORT=20825
OUO_RUM_API_PORT=20826
OUO_BACKEND_PORT=20827
OUO_RETENTION_LOGS=336h
OUO_RETENTION_REPLAYS=336h
OUO_EXTERNAL_LOKI_URL=http://host.docker.internal:${OUO_CLIENT_LOKI_PORT:-20810}
OUO_EXTERNAL_TEMPO_URL=http://host.docker.internal:${OUO_CLIENT_TEMPO_PORT:-20811}
OUO_EXTERNAL_MIMIR_URL=http://host.docker.internal:${OUO_CLIENT_MIMIR_PORT:-20812}/prometheus
OUO_EXTERNAL_OTLP_TRACES=host.docker.internal:${OUO_CLIENT_OTLP_GRPC_PORT:-20813}
OUO_EXTERNAL_OTLP_LOGS=http://host.docker.internal:${OUO_CLIENT_OTLP_HTTP_PORT:-20814}
OUO_EXTERNAL_OTLP_METRICS=http://host.docker.internal:${OUO_CLIENT_OTLP_HTTP_PORT:-20814}
OUO_LOKI_URL=$LOKI
OUO_TEMPO_URL=http://localhost:${OUO_CLIENT_TEMPO_PORT:-20811}
OUO_MIMIR_URL=http://localhost:${OUO_CLIENT_MIMIR_PORT:-20812}
EOF
# Collector and rum-api from this tree, under image names of their own (not ouo/collector).
cat > "$TMP/build.yaml" <<EOF
services:
  otel-collector:
    build: { context: $ROOT/collector }
    image: $P/collector
  rum-api:
    build: { context: $ROOT/services/rum-api }
    image: $P/rum-api
EOF

echo "== 1. client Loki with its own defaults"
OUO_CLIENT_LOKI_CONFIG=./loki.client.yaml client up -d >/dev/null
wait_loki
node "$HERE/client-logs.mjs" "$CLIENT_OTLP" before
for _ in $(seq 30); do [[ "$(count '{service_name="juhi-care-api"}')" == 3 ]] && break; sleep 2; done
BEFORE="$(client_series)"
echo "client series: $BEFORE"
[[ "$BEFORE" == 1\ *k8s_pod_name* ]] || fail "client stream not as expected: $BEFORE"

echo "== 2. Loki with ouo's additive otlp_config"
diff <(grep -v '^#' "$HERE/loki.client.yaml") <(grep -v '^#' "$HERE/loki.client-plus-ouo.yaml" | sed '/--- added for ouo ---/,/--- end ---/d') \
  || fail "loki.client-plus-ouo.yaml differs from loki.client.yaml outside the ouo block"
OUO_CLIENT_LOKI_CONFIG=./loki.client-plus-ouo.yaml client up -d loki >/dev/null
wait_loki
curl -sf "$LOKI/config" | python3 -c '
import sys,yaml
a=yaml.safe_load(sys.stdin)["limits_config"]["otlp_config"]["resource_attributes"]["attributes_config"]
names=[n for e in a for n in e["attributes"]]
assert "k8s.pod.name" in names and "service.instance.id" in names, names
assert names[-2:]==["ouo.platform","ouo.project.id"], names
print(f"attributes_config: {len(names)-2} Loki defaults + ouo.platform, ouo.project.id")' || fail "Loki /config"

echo "== 3. ouo on the existing stack"
ouo build otel-collector rum-api >/dev/null
ouo up -d >/dev/null
e2e "$TMP/e2e.json"
for ds in loki tempo mimir; do
  curl -sf -u admin:testing567 "http://localhost:20820/api/datasources/uid/$ds/health" | grep -q '"status":"OK"' || fail "grafana datasource $ds"
done
echo "grafana datasources loki, tempo, mimir: OK"

echo "== 4. client labels unchanged, ouo labels present"
node "$HERE/client-logs.mjs" "$CLIENT_OTLP" after
for _ in $(seq 30); do [[ "$(count '{service_name="juhi-care-api"}')" == 6 ]] && break; sleep 2; done
AFTER="$(client_series)"
echo "client series: $AFTER"
[[ "$AFTER" == "$BEFORE" ]] || fail "client labels changed: $BEFORE -> $AFTER"
OUO_LABELS="$(loki_get /loki/api/v1/series --data-urlencode 'match[]={service_name="qa-web"}' --data-urlencode "start=$(( $(date +%s) - 7200 ))" \
  | python3 -c 'import sys,json; print(",".join(sorted(json.load(sys.stdin)["data"][0])))')"
echo "ouo series: $OUO_LABELS"
for l in event_name ouo_platform ouo_project_id; do [[ ",$OUO_LABELS," == *",$l,"* ]] || fail "ouo stream lacks $l"; done

delete_user() { # delete_user <user>: through rum-api, wait until Loki processed it
  local user="$1" before other
  before="$(count "{service_name=~\".+\"} | ouo_project_id=\"demo\" | user_id=\"$user\"")"
  other="$(count '{service_name=~".+"} | ouo_project_id="demo" | user_id="qa-user-w-1"')"
  curl -sf -X DELETE -H "Authorization: Bearer $ADMIN" "http://localhost:20826/v1/admin/users/$user?project=demo&reason=existing-lgtm-e2e" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("deletion", d["status"], "sessions", d["session_count"], "replays", d["replays"]["deleted"], "loki", d["loki"]["status"]); assert d["loki"]["status"]=="submitted", d["loki"]' \
    || fail "delete $user"
  local st=""
  for i in $(seq 40); do
    st="$(loki_get /loki/api/v1/delete | U="user_id=\"$user\"" python3 -c 'import sys,json,os; u=os.environ["U"]; print(",".join(sorted({r["status"] for r in json.load(sys.stdin) if u in r["query"]})))' 2>/dev/null || true)"
    [[ "$st" == processed ]] && break; sleep 15
  done
  [[ "$st" == processed ]] || fail "delete request for $user not processed ($st)"
  local after other_after client_lines
  after="$(count "{service_name=~\".+\"} | ouo_project_id=\"demo\" | user_id=\"$user\"")"
  other_after="$(count '{service_name=~".+"} | ouo_project_id="demo" | user_id="qa-user-w-1"')"
  echo "processed after ~$((i * 15)) s: $user lines $before -> $after, qa-user-w-1 $other -> $other_after"
  [[ "$after" == 0 && "$other_after" == "$other" && "$before" != 0 ]] || fail "delete removed the wrong lines"
}
echo "== 5. delete by user"
delete_user qa-user-w-0
CLIENT_LINES="$(count '{service_name="juhi-care-api"}')"
[[ "$CLIENT_LINES" == 6 ]] || fail "client lines after delete: $CLIENT_LINES"
echo "client lines kept: $CLIENT_LINES"

if (( MT == 1 )); then
  echo "== 6. multi-tenant Loki, OUO_LGTM_TENANT_ID=juhi"
  sed 's/^auth_enabled: false/auth_enabled: true/' "$HERE/loki.client-plus-ouo.yaml" > "$TMP/loki.mt.yaml"
  OUO_CLIENT_LOKI_CONFIG="$TMP/loki.mt.yaml" client up -d loki >/dev/null
  wait_loki
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$LOKI/loki/api/v1/labels")" == 401 ]] || fail "Loki answers without a tenant"
  printf 'OUO_LGTM_TENANT_ID=juhi\nOUO_EXTERNAL_OTLP_LOGS=http://host.docker.internal:%s/otlp\n' "${OUO_CLIENT_LOKI_PORT:-20810}" >> "$TMP/ouo.env"
  ouo up -d otel-collector rum-api grafana >/dev/null
  e2e "$TMP/e2e-mt.json"
  RUN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$TMP/e2e-mt.json")"
  IN_TENANT="$(TENANT=juhi count "{service_name=~\"qa-.+\"} | session_id=~\"qa-$RUN-.*\"")"
  IN_FAKE="$(TENANT=fake count "{service_name=~\"qa-.+\"} | session_id=~\"qa-$RUN-.*\"")"
  echo "run $RUN: $IN_TENANT lines in tenant juhi, $IN_FAKE in fake"
  [[ "$IN_TENANT" != 0 && "$IN_FAKE" == 0 ]] || fail "tenant routing"
  TENANT=juhi delete_user qa-user-w-2
fi

echo "existing-lgtm OK"
