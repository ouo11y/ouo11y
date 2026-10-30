#!/usr/bin/env bash
# W7 end to end: a real native crash, symbolicated through rum-api from an uploaded dSYM.
#
#   eval "$(deploy/envs/ouo-env env <env>)" && project/agents/mobile-sdk/verify/w7-dsym-e2e.sh
#
# 1. builds and crashes sdk/ios's OuoCrashProbe (SIGSEGV in crashSegv), makes its dSYM;
# 2. turns the crash report into exception attributes with the React Native SDK's own
#    nativeCrashAttributes (sdk/react-native/src/crash.ts) and sends session.start + exception
#    as OTLP/JSON through the collector;
# 3. uploads the dSYM with `ouo-sourcemaps upload-dsym` (sdk/sourcemaps, built);
# 4. reads the session from rum-api and checks every probe frame against `atos -i`: same
#    function, file and line. atos demangles Swift names (`level2(_:)`); rum-api shows the
#    DWARF name (`level2`), so the parameter list is left out of the comparison.
# macOS with Xcode command line tools, Node 24, the repo's node_modules (npm ci).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
OTLP="${OUO_OTLP_URL:?eval \"\$(deploy/envs/ouo-env env <env>)\" first}"
RUM_API="${OUO_RUM_API_URL:?}"
PROJECT_ID="${OUO_PROJECT_ID:-demo}"
TOKEN="${OUO_PROJECT_TOKEN:-pt_dev_demo_0000000000000000}"
UPLOAD_TOKEN="${OUO_UPLOAD_TOKEN:-ut_dev_demo_0000000000000000}"
READ_TOKEN="${OUO_READ_TOKEN:-rt_dev_0000000000000000}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Crash.
(cd "$root/sdk/ios" && swift build --product OuoCrashProbe >/dev/null)
probe="$root/sdk/ios/.build/debug/OuoCrashProbe"
dsymutil "$probe" -o "$tmp/OuoCrashProbe.dSYM"
session="$(openssl rand -hex 16)"
mkdir "$tmp/crash"
"$probe" "$tmp/crash" "$session" segv && fail "the probe did not crash" || true
[[ -s "$tmp/crash/report.json" ]] || fail "no crash report"

# 2. The SDK's attributes, as OTLP/JSON.
cat >"$tmp/attrs.mts" <<EOF
import { readFileSync } from "node:fs";
import { nativeCrashAttributes, parseNativeCrash } from "$root/sdk/react-native/src/crash.ts";
console.log(JSON.stringify(nativeCrashAttributes(parseNativeCrash(readFileSync(process.argv[2], "utf8"))!)));
EOF
"$root/node_modules/.bin/esbuild" "$tmp/attrs.mts" --bundle --platform=node --format=esm --log-level=error \
  --external:expo-modules-core --external:react-native --outfile="$tmp/attrs.mjs"
node "$tmp/attrs.mjs" "$tmp/crash/report.json" >"$tmp/attrs.json"
node - "$tmp/attrs.json" "$session" >"$tmp/logs.json" <<'EOF'
const [file, session] = process.argv.slice(2);
const attrs = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
const v = (x) => (typeof x === "boolean" ? { boolValue: x } : typeof x === "number" ? { intValue: String(x) } : { stringValue: String(x) });
const kv = (o) => Object.entries(o).map(([key, x]) => ({ key, value: v(x) }));
const ns = (ms) => String(BigInt(ms) * 1000000n);
const crashAt = attrs["ouo.crash.timestamp"];
const rec = (name, ms, a) => ({ timeUnixNano: ns(ms), observedTimeUnixNano: ns(Date.now()), severityNumber: name === "exception" ? 21 : 9,
  eventName: name, body: { stringValue: name }, attributes: kv({ "event.name": name, "session.id": session, "ouo.platform": "react-native", ...a }) });
console.log(JSON.stringify({ resourceLogs: [{
  resource: { attributes: kv({ "service.name": "ouo-crash-probe", "service.version": "1.0.0", "ouo.platform": "react-native" }) },
  scopeLogs: [{ scope: { name: "ouo.w7.e2e" }, logRecords: [
    rec("session.start", crashAt - 5000, { "ouo.session.started_at": String(crashAt - 5000) }),
    rec("exception", crashAt, attrs),
  ] }] }] }));
EOF
code=$(curl -s -o "$tmp/r" -w '%{http_code}' -X POST "$OTLP/v1/logs" -H "Content-Type: application/json" \
  -H "Authorization: Basic $(printf '%s:%s' "$PROJECT_ID" "$TOKEN" | base64 | tr -d '\n')" --data-binary @"$tmp/logs.json")
[[ "$code" == 200 ]] || fail "OTLP logs -> $code: $(cat "$tmp/r")"
echo "ok: crash sent (session $session)"

# 3. Upload.
node "$root/sdk/sourcemaps/dist/cli.js" upload-dsym "$tmp/OuoCrashProbe.dSYM" --url "$RUM_API" --token "$UPLOAD_TOKEN" --release 1.0.0

# 4. Read back and compare with atos.
python3 - "$tmp/crash/report.json" >"$tmp/atos-args" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
img = r["images"][0]
print(img["image_addr"], *[hex(int(f["instruction_addr"], 16) - (1 if i else 0))
      for i, f in enumerate(r["frames"]) if f.get("image_addr") == img["image_addr"]])
EOF
read -r load addrs <"$tmp/atos-args"
# shellcheck disable=SC2086
atos -i -arch arm64 -o "$tmp/OuoCrashProbe.dSYM/Contents/Resources/DWARF/OuoCrashProbe" -l "$load" $addrs | grep . >"$tmp/atos"
for _ in $(seq 1 30); do
  curl -s -H "Authorization: Bearer $READ_TOKEN" "$RUM_API/v1/sessions/$session" >"$tmp/s.json" || true
  python3 -c 'import json,sys; t=json.load(open(sys.argv[1])).get("timeline",[]); sys.exit(0 if any(i.get("symbolicated") for i in t) else 1)' "$tmp/s.json" 2>/dev/null && break
  sleep 2
done
python3 - "$tmp/s.json" "$tmp/atos" <<'EOF'
import json, re, sys
item = next(i for i in json.load(open(sys.argv[1]))["timeline"] if i.get("symbolicated"))
sym = item["symbolicated"]
print(sym["stacktrace"])
got = [f"{f['original']['function']} (in OuoCrashProbe) ({f['original']['file'].rsplit('/', 1)[-1]}:{f['original']['line']})"
       for f in sym["frames"] if f["status"] == "mapped"]
# atos: "level2(_:) (in OuoCrashProbe) (main.swift:47)" -> "level2 (in OuoCrashProbe) (main.swift:47)"
want = [re.sub(r"\(.*\)(?= \(in )", "", l.strip()) for l in open(sys.argv[2])]
if got != want:
    sys.exit(f"FAIL: rum-api frames differ from atos\n  rum-api: {got}\n  atos:    {want}")
print(f"ok: {len(got)} frames match atos -i; status {sym['status']}, {sym['mapped']}/{len(sym['frames'])} mapped")
EOF
