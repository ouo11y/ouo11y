# web-bench: six browser SDKs, one page, one journey

The harness behind [Appendix M](../../../../kb/web-sdk-research/benchmark.md). It measures, on one
machine with headless Chromium, what `@ouo11y/browser`, `@sentry/browser`, `@datadog/browser-rum`,
`posthog-js`, Grafana Faro and `@splunk/otel-web` cost on the same page: bundle bytes, main-thread
and renderer CPU, long tasks, JS heap, and bytes on the wire (telemetry and replay apart). Every SDK
talks to a local intake. Nothing goes to a vendor endpoint: non-local hosts do not resolve in the
browser and every attempt is counted.

| File | What it is |
|---|---|
| `package.json` | the SDKs, Playwright and esbuild, exact versions |
| `cells.mjs` | the cells: SDK entry × replay on / off |
| `entries/*.js` | one init file per SDK, the exact options of every cell |
| `page/index.html`, `page/app.js` | the test page: about 2,500 DOM nodes, a list re-rendered every second, pushState routes, one fetch per click, a button that throws |
| `build.mjs` | bundles each cell with esbuild (`--bundle --minify --format=esm --target=es2022`, code splitting) and writes `dist/sizes.json` (gzip -9, eager and lazy) |
| `server.mjs` | one Node process, two localhost ports: the page server and the intake (200 + CORS, counts requests and bytes per SDK, wire and decoded) |
| `run.mjs` | N rounds, every cell once per round, order rotated each round; writes `results/<name>.json` |
| `report.mjs` | median [IQR] tables and paired deltas against `none`, as Markdown |
| `snapshot.mjs` | splits ouo's replay bytes by rrweb event type (full snapshot vs incremental) |
| `pin-ouo-deps.mjs` | pins the scratch copy of `sdk/browser/package.json` to the repo lockfile's versions |

## Run it

Node 24. Work in a scratch directory, not in the repository (installs and results stay out of git).

```bash
REPO=$(git rev-parse --show-toplevel)
WORK=/tmp/web-bench            # any scratch directory
mkdir -p $WORK/bench $WORK/ouo-build

# 1. Build @ouo11y/browser from the checkout, with the dependency versions of the repo lockfile.
cp -R $REPO/sdk/browser/{src,package.json,tsconfig.json,tsup.config.ts} $WORK/ouo-build/
cd $WORK/ouo-build
#    Pin what package-lock.json pins (2026-10-29: rrweb 2.1.7, @opentelemetry/* 2.11.0 / 0.222.0,
#    web-vitals 6.2.3); a fresh resolve of the ^ ranges picks newer ones (rrweb 2.2.0).
node $REPO/project/agents/web-sdk-research/tools/web-bench/pin-ouo-deps.mjs $REPO/package-lock.json
npm install --ignore-scripts
npx tsup                       # dist/index.js + dist/rrweb-*.js (prints "ouo: rrweb patched")

# 2. The harness.
cp -R $REPO/project/agents/web-sdk-research/tools/web-bench/. $WORK/bench/
cd $WORK/bench
npm install --ignore-scripts   # no browser download: uses the Playwright 1.64.1 Chromium already installed
npx playwright --version       # 1.64.1; `ls ~/Library/Caches/ms-playwright` must list chromium_headless_shell-1248
node build.mjs --ouo ../ouo-build

# 3. Measure (about 70 s per run; 12 cells x 10 rounds is about 2 h 20 min).
node run.mjs --rounds 1 --journey 8 --out results/smoke.json        # smoke: every cell sends, no errors
node run.mjs --rounds 5 --journey 6 --nodes 10000 \
  --cells none,ouo,sentry,datadog,posthog,splunk --out results/large-dom.json
node run.mjs --rounds 10 --journey 60 --out results/main.json
node report.mjs results/main.json results/large-dom.json
node snapshot.mjs --seconds 30   # ouo replay bytes by rrweb event type
```

`run.mjs` starts `server.mjs` as its child, keeps the PID and kills it when it ends; each run
launches and closes its own Chromium. Nothing else is started or stopped.

## One run

1. Fresh headless Chromium (`--host-resolver-rules` maps every host except 127.0.0.1 / localhost
   to NOTFOUND), new context, `/blank` on the page origin, CDP `Performance.enable`, intake counters
   reset.
2. Navigate to `/c/<cell>/home`, wait for `load` and the `sdk-init-done` mark, then 3 s for lazy
   chunks and the first replay snapshot. Load-phase metrics are taken here.
3. 60 s journey on a fixed clock: one action every 2 s (route change with fetch, "Load item" click
   with fetch, typing 12 characters into the search input, in turn), a list-row click every 10 s,
   and the throwing click at action 15 (about 30 s).
4. Journey metrics, long tasks from the page, a forced GC and the heap.
5. Navigate to `/blank` (pagehide, visibilitychange: every SDK flushes), wait 3 s, read the intake.

Metrics: CDP `Performance.getMetrics` `TaskDuration` / `ScriptDuration` (renderer main thread),
CDP `SystemInfo.getProcessInfo` renderer `cpuTime` (all renderer threads, so workers and
compression threads count), `PerformanceObserver` `longtask` (buffered, installed before any
script), `JSHeapUsedSize` after `HeapProfiler.collectGarbage`, intake bytes per request (body as
received, and decoded: HTTP `Content-Encoding` plus the SDK's own framing where known: Sentry
`replay_recording` zlib, Datadog multipart segment deflate, PostHog gzip).

## rrweb: full package against the record-only build

What ouo's lazy chunk would weigh with `@rrweb/record` instead of `import("rrweb")` (same bundler
flags as above; the published ouo chunk uses terser, a little smaller):

```bash
for v in 2.1.7 2.2.0; do
  mkdir -p $WORK/rrweb-$v && cd $WORK/rrweb-$v && echo '{"private":true,"type":"module"}' > package.json
  npm install --ignore-scripts rrweb@$v @rrweb/record@$v esbuild@0.28.2
  echo 'export * from "rrweb";'                  > ns.js      # what import("rrweb") loads
  echo 'export { record } from "rrweb";'         > rec.js
  echo 'export { record } from "@rrweb/record";' > recpkg.js
  for e in ns rec recpkg; do
    npx esbuild $e.js --bundle --minify --format=esm --target=es2022 --outfile=out-$e.js
    echo "$v $e $(gzip -9c out-$e.js | wc -c)"
  done
done
```
