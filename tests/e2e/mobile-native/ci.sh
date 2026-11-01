#!/bin/sh
# The native iOS suite as CI runs it on the Mac runner (checklist N78): the ouo stack, built from
# this checkout, in a Lima VM owned by the user that runs this; a new simulator; run.sh against
# both; then both torn down, whatever happened. The runner's user cannot reach the founder's
# Docker Desktop (project/kb/ci-runners.md), hence a VM of its own. The VM is kept stopped between
# runs, so its images and build cache stay; the first run creates it (about 5 minutes more).
#
# Usage: ci.sh          up, run.sh, down
#        ci.sh down     tear down what a run left (CI's always() step; safe to repeat)
#        ci.sh logs     the stack's last log lines (CI's failure() step)
# Env:   OUO_NATIVE_VM         Lima instance (default ouo-ci)
#        OUO_NATIVE_PORT_BASE  the stack's host ports are base+0..99 (default 29000)
#        OUO_NATIVE_OUT        build, logs, state (default $RUNNER_TEMP/ouo-native)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
PATH=$PATH:/opt/homebrew/bin # limactl and xcodegen are Homebrew's; the runner's PATH has none
VM=${OUO_NATIVE_VM:-ouo-ci}
BASE=${OUO_NATIVE_PORT_BASE:-29000}
OUT=${OUO_NATIVE_OUT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ouo-native}
export OUO_NATIVE_OUT="$OUT"
mkdir -p "$OUT/docker"
bounded() { s=$1; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

# Docker: the VM's socket, and the compose plugin from Docker Desktop's app bundle (the CLI finds
# it through the founder's ~/.docker, which another user cannot read).
export DOCKER_HOST="unix://$HOME/.lima/$VM/sock/docker.sock" DOCKER_CONFIG="$OUT/docker"
echo '{"cliPluginsExtraDirs":["/Applications/Docker.app/Contents/Resources/cli-plugins"]}' > "$DOCKER_CONFIG/config.json"
export OUO_NATIVE_COLLECTOR=ouo-native-otel-collector-1
# compose <seconds> <args>: bounded, as everything here that can hang.
compose() { s=$1; shift; bounded "$s" docker compose -p ouo-native -f "$ROOT/deploy/compose/compose.yaml" -f "$HERE/stack.compose.yaml" "$@"; }

# The stack's host ports (the VM forwards only base..base+99 to this Mac's loopback) and its URLs.
export OUO_GRAFANA_PORT=$BASE OUO_LOKI_PORT=$((BASE + 1)) OUO_TEMPO_PORT=$((BASE + 2)) OUO_MIMIR_PORT=$((BASE + 9)) \
  OUO_OTLP_GRPC_PORT=$((BASE + 17)) OUO_OTLP_HTTP_PORT=$((BASE + 18)) OUO_REPLAY_PORT=$((BASE + 19)) \
  OUO_SENTRY_PORT=$((BASE + 20)) OUO_COLLECTOR_HEALTH_PORT=$((BASE + 33)) OUO_RUM_API_PORT=$((BASE + 80)) \
  OUO_BACKEND_PORT=$((BASE + 81)) OUO_NATIVE_PROXY_PORT=$((BASE + 50))
set -a
eval "$("$ROOT/.github/scripts/stack-env.sh")"
set +a

running() { [ "$(limactl list --format '{{.Status}}' "$VM" 2>/dev/null)" = Running ]; }

down() {
  if [ -f "$OUT/udid" ]; then
    udid=$(cat "$OUT/udid")
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    xcrun simctl delete "$udid" && rm -f "$OUT/udid"
  fi
  if running; then
    compose 180 down -v --remove-orphans || true
    bounded 180 limactl stop "$VM"
  fi
}

up() {
  # The VM is created once and kept (stopped) for its image cache; a change to how it is created
  # (these lines) recreates it, since only the runner's user could delete it by hand.
  set -- --cpus 4 --memory 6 --disk 60 --set ".portForwards += [
    {\"guestPortRange\": [$BASE, $((BASE + 99))], \"hostIP\": \"127.0.0.1\"},
    {\"guestIP\": \"127.0.0.1\", \"guestPortRange\": [1, 65535], \"proto\": \"any\", \"ignore\": true},
    {\"guestIP\": \"0.0.0.0\", \"guestPortRange\": [1, 65535], \"proto\": \"any\", \"ignore\": true}]" template:docker
  made="$HOME/.lima/$VM/ouo-create-args"
  if [ -f "$made" ] && [ "$(cat "$made")" != "$*" ]; then
    echo "the VM's settings changed: recreating $VM"
    bounded 300 limactl delete -f "$VM"
  fi
  if ! limactl list --format '{{.Name}}' "$VM" >/dev/null 2>&1; then
    echo "creating the Lima VM $VM (once: about 5 minutes more)"
    bounded 600 limactl create --tty=false --name "$VM" "$@"
    echo "$*" > "$made"
  fi
  bounded 900 limactl start --tty=false "$VM"
  compose 1500 up -d --build --quiet-pull
  OUO_READY_TIMEOUT=240 "$ROOT/deploy/scripts/wait-ready.sh"

  # A new simulator: the newest iOS runtime, on the iPhone 18 Pro the suite was written on (else the
  # runtime's last iPhone).
  set -- $(xcrun simctl list -j runtimes available | node -e '
    const r = JSON.parse(require("fs").readFileSync(0)).runtimes.filter((x) => x.platform === "iOS" && x.isAvailable).at(-1);
    const phones = r.supportedDeviceTypes.filter((d) => d.productFamily === "iPhone");
    console.log((phones.find((d) => d.identifier.endsWith(".iPhone-18-Pro")) ?? phones.at(-1)).identifier, r.identifier);')
  xcrun simctl create "ouo-native-$(date +%s)" "$1" "$2" > "$OUT/udid"
  echo "simulator $(cat "$OUT/udid") ($1, $2)"
  bounded 300 xcrun simctl bootstatus "$(cat "$OUT/udid")" -b
}

case "${1:-all}" in
  down) down ;;
  logs) running && compose 60 logs --no-color --tail 200 || true ;;
  all)
    trap 'down' EXIT
    trap 'exit 130' INT TERM
    up
    "$HERE/run.sh" - "$(cat "$OUT/udid")"
    ;;
  *) echo "usage: ci.sh [all|down|logs]" >&2; exit 2 ;;
esac
