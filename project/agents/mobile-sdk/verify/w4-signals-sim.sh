#!/usr/bin/env bash
# W4 on the iOS Simulator: the real Swift hang watchdog and termination check in examples/ouo-mobile
# (Release build against an ouo-env, scripts/build-ios.sh --env <env> --device <udid>), driven through
# the app's journey mailbox (src/journey.ts) and its demo-only chaos module (modules/ouo-chaos).
#
#   project/agents/mobile-sdk/verify/w4-signals-sim.sh --env <env> --device <udid>
#
# Run 1: Products (TTFD reported when the catalog is on screen) -> Cart -> a 3 s main-thread block
#        (fully blocking hang) -> three 1.2 s blocks with a frame between (a hang not fully blocking)
#        -> Chaos -> a memory warning and SIGKILL (a simulated out-of-memory kill).
# Run 2: the next launch reports run 1 as a `termination` (cause memory); it goes to the background
#        and is killed there (no termination: the app was not active).
# Run 3: reports nothing for run 2 (its session ends `terminated`); killed in the foreground without a
#        memory warning (`xcrun simctl terminate`): cause unknown.
# Run 4: reports run 3, then goes to the background so everything is exported.
# Then prints what rum-api has for the four sessions.
set -euo pipefail
ENV_NAME="" DEVICE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n $ENV_NAME && -n $DEVICE ]] || { echo "--env and --device are required" >&2; exit 2; }
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
eval "$("$root/deploy/envs/ouo-env" env "$ENV_NAME")"
BUNDLE=dev.ouo.mobilestore
log() { printf '%s [w4] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cmd() {
  log "command $1"
  local docs; docs="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)/Documents"
  mkdir -p "$docs"
  printf '%s\n' "$1" > "$docs/.journey-command.tmp"
  mv "$docs/.journey-command.tmp" "$docs/journey-command"
  sleep "${2:-2}"
}
# `simctl launch` prints "<bundle>: <pid>": the only process this script kills is that pid.
launch() { xcrun simctl launch "$DEVICE" "$BUNDLE" | sed -n 's/.*: \([0-9]*\)$/\1/p'; }
background() { xcrun simctl launch "$DEVICE" com.apple.Preferences >/dev/null; sleep "${1:-4}"; }
foreground_done() { xcrun simctl terminate "$DEVICE" com.apple.Preferences 2>/dev/null || true; }

start=$(( $(date +%s) - 1 ))
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true

log "run 1"
launch >/dev/null
sleep 8
cmd "screen/Cart" 2
cmd "action/hang?ms=3000" 6
cmd "action/stutter?ms=1200&times=3" 8
cmd "action/flush" 3
cmd "screen/Chaos" 2
cmd "action/oom" 4

log "run 2: reports run 1; killed in the background"
pid=$(launch)
sleep 8
cmd "action/flush" 3
background 4
log "kill -9 $pid (suspended in the background)"
kill -9 "$pid"
foreground_done

log "run 3: killed in the foreground without a memory warning"
launch >/dev/null
sleep 8
cmd "action/flush" 3
xcrun simctl terminate "$DEVICE" "$BUNDLE"
sleep 2

log "run 4: reports run 3, then exports"
launch >/dev/null
sleep 8
cmd "action/flush" 3
background 6
foreground_done
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
end=$(( $(date +%s) + 1 ))

log "rum-api, window $start..$end"
python3 -I - "$OUO_RUM_API_URL" "${OUO_READ_TOKEN:-rt_dev_0000000000000000}" "$start" "$end" <<'EOF'
import datetime as dt, json, sys, time, urllib.parse, urllib.request
base, token, start, end = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def get(path, **q):
    url = base.rstrip("/") + path + ("?" + urllib.parse.urlencode(q) if q else "")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}), timeout=20) as r:
        return json.loads(r.read())
iso = lambda u: dt.datetime.fromtimestamp(u, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
time.sleep(20)
ss = sorted(get("/v1/sessions", **{"from": iso(start - 60), "to": iso(end + 60), "service": "mobile-store", "limit": 50})["sessions"], key=lambda s: s["started_at"])
for i, s in enumerate(ss, 1):
    d = get(f"/v1/sessions/{s['session_id']}")
    print(f"session {i} {s['session_id'][:8]} status={d.get('status')} end_reason={d.get('end_reason')} ended_at={d.get('ended_at')}")
    for e in d.get("timeline", []):
        a = e.get("attrs", {})
        if e["name"] == "exception":
            events = json.loads(a.get("ouo_last_events", "[]"))
            print(f"  exception {e['ts']} kind={a.get('ouo_exception_kind')} fatal={a.get('ouo_exception_fatal')} type={a.get('exception_type')}")
            print(f"    message={a.get('exception_message')!r} hang_ms={a.get('ouo_hang_duration_ms')} fully_blocking={a.get('ouo_hang_fully_blocking')} cause={a.get('ouo_termination_cause')}")
            print(f"    screen={a.get('app_screen_name')} locale={a.get('ouo_device_locale')} app_bytes={a.get('ouo_memory_app_bytes')} available_bytes={a.get('ouo_memory_available_bytes')} network={a.get('network_connection_type')} last_events={len(events)} last={events[-1]['name'] + ' ' + events[-1]['body'] if events else None}")
            st = a.get("exception_stacktrace", "")
            if a.get("ouo_exception_kind") == "hang":
                print("    stack: " + " | ".join(st.splitlines()[1:6]))
    v = get(f"/v1/sessions/{s['session_id']}/vitals")
    for x in v.get("vitals", []):
        if x["name"] == "ouo.screen.display":
            print(f"  screen.display {x['screen']} {x['values']}")
EOF
