#!/usr/bin/env bash
# The ADR-0022 demo, end to end, from the repo root after `npm ci`:
# build ouo-web minified with hidden source maps, inject debug ids, capture a real exception
# from @ouo11y/browser in headless Chromium, upload the maps with the unchanged ouo-sourcemaps
# CLI to the prototype's upload route, resolve the stack, and measure.
# Output goes to $OUT (default: a temporary directory). The Mac has no `timeout`; nothing here
# runs long. The only process started is ouo-symdemo serve, stopped by its PID.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
here="$root/project/agents/symbolication/prototype"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
cd "$root"
[[ -f sdk/browser/dist/index.js ]] || npm --prefix "$root" run -w sdk/browser build >/dev/null
[[ -f sdk/sourcemaps/dist/cli.js ]] || npm --prefix "$root" run -w sdk/sourcemaps build >/dev/null
VITE_OTLP_ENDPOINT=http://127.0.0.1:14318 npm --prefix "$root" run -w examples/ouo-web build >/dev/null
rm -rf "$OUT/dist" && cp -R examples/ouo-web/dist "$OUT/dist"
node sdk/sourcemaps/dist/cli.js inject "$OUT/dist"
node "$here/demo/capture.mjs" "$OUT/dist" "$OUT/capture"
(cd "$here" && go build -o "$OUT/ouo-symdemo" ./cmd/ouo-symdemo)

"$OUT/ouo-symdemo" serve -data "$OUT/store" >"$OUT/serve.log" &
pid=$!
trap 'kill $pid' EXIT
sleep 1
store="$(awk '/^store/{print $2}' "$OUT/serve.log")" edge="$(awk '/^edge/{print $2}' "$OUT/serve.log")"
node sdk/sourcemaps/dist/cli.js upload "$OUT/dist" --url "$edge" --token ut_demo --release 1.4.2
"$OUT/ouo-symdemo" resolve -store "$store" -release 1.4.2 -stack "$OUT/capture/stack.txt" \
  -debug-ids "$OUT/capture/debug-ids.json" >"$OUT/capture/resolved.json"
echo "--- minified"; cat "$OUT/capture/stack.txt"
echo "--- resolved"; node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stacktrace)' "$OUT/capture/resolved.json"
main="$(ls "$OUT"/dist/assets/index-*.js.map)"
"$OUT/ouo-symdemo" measure -runs 30 -map "$main" -stack "$OUT/capture/stack.txt" -debug-ids "$OUT/capture/debug-ids.json" >"$OUT/measure-web.json"
echo "--- measurements in $OUT/measure-web.json"
