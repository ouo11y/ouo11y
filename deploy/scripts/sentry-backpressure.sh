#!/usr/bin/env bash
# Back-pressure of the Sentry bridge + Muninn + LGTM collector (collector/config.muninn.yaml with
# config.muninn-sentry.yaml): does a down backend ever slow the bridge's answer to the SDK?
#
#   deploy/envs/ouo-env up <env> --muninn
#   deploy/scripts/sentry-backpressure.sh --env <env> [--passes 10] [--chunks 200]
#
# Phases, each with the same bridge load (examples/tools/sentryreplay.py: --passes journeys of the golden
# iOS capture, 60 envelopes each, 8 threads, no pauses) while the collector's memory is sampled:
#   baseline      every backend up
#   loki-down     Loki stopped during the load, started again; every pass's sessions must
#                 reach Loki afterwards (the exporter's queue and retries)
#   muninn-down   Muninn stopped; in parallel tests/e2e/muninn/load.mjs sends --chunks spec-wire
#                 replay chunks of 256 KiB to /v1/logs (they must all get 2xx, into the disk
#                 queue); Muninn started again, every chunk must be in Muninn
#   rumapi-down   rum-api (the bridged video replays' sink today) stopped and started again
# Prints one JSON line per phase, then the drop counters. Needs python3, node (tests/e2e/muninn's
# node_modules), docker. Stops and starts only this env's own containers.
#
# All the load comes from one address, so the collector's per-client bucket (100/s, burst 300)
# drops most of the bridge's translated output and 429s most chunks: that is the limiter
# working, and it hides what the outages do. To measure the outages alone, recreate the
# collector with OUO_RATELIMIT_{CLIENT,PROJECT}_{RATE,BURST}=100000 first (the report shows both).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_NAME="" PASSES=10 CHUNKS=200
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --passes) PASSES="$2"; shift ;;
    --chunks) CHUNKS="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
ENV_NAME="${ENV_NAME:-$("$ROOT/deploy/envs/ouo-env" slug)}"
eval "$("$ROOT/deploy/envs/ouo-env" env "$ENV_NAME")"
[[ -n "${OUO_MUNINN_URL:-}" ]] || { echo "env $ENV_NAME was not started with --muninn" >&2; exit 2; }
SENTRY="${OUO_SENTRY_URL:-http://sentry-bridge.$ENV_NAME.ouo.localhost}"
P="$OUO_COMPOSE_PROJECT"
COL="$P-otel-collector-1"
OUT="${OUO_DEMO_OUT:-$(mktemp -d)}"
dc() { docker compose -p "$P" "$@"; }
log() { printf '%s [backpressure] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# Peak collector memory (MiB) while the given PID runs.
mem_peak() {
  local pid=$1 peak=0 m
  while kill -0 "$pid" 2>/dev/null; do
    m="$(docker stats --no-stream --format '{{.MemUsage}}' "$COL" | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); v*=1024} else sub(/MiB/,"",v); print int(v)}')"
    (( m > peak )) && peak=$m
    sleep 2
  done
  echo "$peak"
}

bridge_load() {  # $1 phase name; prints the replay summary JSON, writes $OUT/$1.json
  python3 -I "$ROOT/examples/tools/sentryreplay.py" --bridge "$SENTRY" --passes "$PASSES" --concurrency 8 --gap 0 \
    --manifest "$OUT/$1.json" >"$OUT/$1.out" 2>&1 &
  local pid=$!
  local peak; peak="$(mem_peak $pid)"
  wait $pid || true
  echo "{\"phase\":\"$1\",\"collector_mem_peak_mib\":$peak,\"bridge\":$(tail -1 "$OUT/$1.out")}"
}

sessions_in_loki() {  # $1 manifest; prints "found/total" over every pass's sessions
  python3 -I - "$1" "$OUO_LOKI_URL" <<'EOF'
import json, sys, time, urllib.parse, urllib.request
m = json.load(open(sys.argv[1])); loki = sys.argv[2]
sids = [s for p in m["passes"] for s in p["sessions"]]  # session_id is the Sentry sid as sent
found = 0
for sid in sids:
    q = urllib.parse.urlencode({"query": '{service_name="sentry-demo"} | session_id="%s"' % sid,
                                "start": int((time.time() - 3600) * 1e9), "limit": 1})
    r = json.load(urllib.request.urlopen(f"{loki}/loki/api/v1/query_range?{q}"))
    found += bool(r["data"]["result"])
print(f"{found}/{len(sids)}")
EOF
}

log "env $ENV_NAME, bridge $SENTRY, $PASSES journeys per phase, output $OUT"

log "baseline"
bridge_load baseline | tee "$OUT/baseline.result"

log "loki-down: stopping Loki"
dc stop loki >/dev/null 2>&1
bridge_load loki-down | tee "$OUT/loki-down.result"
log "starting Loki, waiting for its queue to drain"
dc start loki >/dev/null 2>&1
until [[ "$(curl -s -m5 "$OUO_LOKI_URL/ready")" == ready ]]; do sleep 5; done
sleep 60
echo "{\"phase\":\"loki-down\",\"sessions_in_loki_after_restart\":\"$(sessions_in_loki "$OUT/loki-down.json")\"}"

log "muninn-down: stopping Muninn, $CHUNKS replay chunks of 256 KiB to /v1/logs next to the bridge load"
dc stop muninn >/dev/null 2>&1
(cd "$ROOT/tests/e2e/muninn" && node load.mjs --chunks "$CHUNKS" --bytes 262144 --concurrency 8) >"$OUT/muninn-load.json" &
lpid=$!
bridge_load muninn-down | tee "$OUT/muninn-down.result"
wait $lpid
echo "{\"phase\":\"muninn-down\",\"otlp_replay_load\":$(cat "$OUT/muninn-load.json")}"
qbytes="$(docker run --rm -v "${P}_replay-queue:/q:ro" --entrypoint du "${OUO_MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}" -sk /q | awk '{print $1}')"
echo "{\"phase\":\"muninn-down\",\"disk_queue_kib\":$qbytes}"
log "starting Muninn, waiting for the disk queue to drain"
dc start muninn >/dev/null 2>&1
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session"])' "$OUT/muninn-load.json")"
# Chunks answered 2xx are the ones the collector accepted; a 429 or 503 was never accepted.
ACCEPTED="$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["codes"]; print(sum(n for k, n in c.items() if k.startswith("2")))' "$OUT/muninn-load.json")"
for i in $(seq 1 60); do
  n="$(curl -s -H "Authorization: Bearer ${OUO_MUNINN_READ_TOKEN:-mrt_dev_0000000000000000}" -H "X-Scope-OrgID: anonymous" \
       "$OUO_MUNINN_URL/api/v1/projects/demo/sessions/$SID/replays" | python3 -c 'import json,sys
try: print(sum(r["chunk_count"] for r in json.load(sys.stdin)["replays"]))
except Exception: print(0)')"
  [[ "$n" -ge "$ACCEPTED" ]] && break
  sleep 5
done
echo "{\"phase\":\"muninn-down\",\"chunks_in_muninn_after_restart\":\"$n/$ACCEPTED accepted ($CHUNKS sent)\",\"seconds_to_drain\":$((i * 5))}"

log "rumapi-down: stopping rum-api"
dc stop rum-api >/dev/null 2>&1
bridge_load rumapi-down | tee "$OUT/rumapi-down.result"
dc start rum-api >/dev/null 2>&1

log "drop counters (Mimir, pushed every 15 s)"
sleep 20
for q in 'sum by (reason) (ouo_sentry_translate_dropped_total)' 'sum by (key_kind) (ouo_ratelimit_rejected_total)'; do
  echo "{\"query\":\"$q\",\"result\":$(curl -s --get "$OUO_MIMIR_URL/prometheus/api/v1/query" --data-urlencode "query=$q" |
    python3 -c 'import json,sys; print(json.dumps({",".join(r["metric"].values()) or "all": r["value"][1] for r in json.load(sys.stdin)["data"]["result"]}))')}"
done
log "done; results in $OUT"
