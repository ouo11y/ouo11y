# Web overhead harness

ouo's browser SDK against Sentry's on one page and one journey, in headless Chromium, with a fake collector that records every ingest request as it arrives. Written for Step 5 ([overhead.md](../../../../kb/client-sdk-state/overhead.md)); the numbers in `results/` are the ones the report uses.

## Variants

| Variant | Entry | Configuration |
|---|---|---|
| `none` | [entries/none.js](entries/none.js) | No SDK: the baseline every cost is measured against |
| `ouo-core` | [entries/ouo-core.js](entries/ouo-core.js) | `@ouo11y/browser` defaults, replay off |
| `ouo-replay` | [entries/ouo-replay.js](entries/ouo-replay.js) | Same, replay on at sample rate 1 (rrweb is a lazy chunk) |
| `sentry-errors` | [entries/sentry-errors.js](entries/sentry-errors.js) | `@sentry/browser` 11.11.0 defaults (bundle size only) |
| `sentry-core` | [entries/sentry-core.js](entries/sentry-core.js) | Plus `browserTracingIntegration`, `tracesSampleRate: 1` |
| `sentry-replay` | [entries/sentry-replay.js](entries/sentry-replay.js) | Plus `replayIntegration` defaults, `replaysSessionSampleRate: 1` |

Both SDKs run at 100 % sampling with their default privacy settings (text masked in replay).

## The page and journey

[page.html](page.html) is a three-route single-page shop (a 200-item list, a fetch that appends 50 items, a cart with 24 cards, a checkout POST, a button that throws). [run.mjs](run.mjs) drives 60 s of real input every 2.3 s (route clicks, typing, a fetch, scrolling, checkout) and one unhandled error halfway, then closes the page so the SDKs flush at `pagehide`. Rounds are interleaved and alternate direction. [server.mjs](server.mjs) serves the page and plays both intakes on the same origin (ouo `/v1/*`, Sentry `/api/1/envelope/`).

| Metric | How |
|---|---|
| Init | `performance.now()` around the synchronous init call |
| Main-thread task time | CDP `Performance.getMetrics` `TaskDuration`, journey window |
| Renderer CPU | CDP `SystemInfo.getProcessInfo` CPU time of the renderer process (all its threads, workers included) |
| Heap | `JSHeapUsedSize` after a forced GC at the end |
| Interaction task | Chrome trace: the main-thread task that dispatched each click, key, pointer or wheel event |
| Bytes | Request bodies as received by `server.mjs`, compressed where the SDK compresses, including the page-close flush |

## Run it

From this folder, after building the SDK at the repo root (`npm ci`, then `npm run build -w sdk/browser`):

```bash
npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts
mkdir -p node_modules/@ouo11y
ln -sfn ../../../../../../../sdk/browser node_modules/@ouo11y/browser
node bundle.mjs
ROUNDS=5 OUT=results/runtime-1x.json node run.mjs
ROUNDS=3 CPU_THROTTLE=4 OUT=results/runtime-4x.json node run.mjs
```

The `@ouo11y/browser` link resolves its own dependencies through the repo root `node_modules`. `run.mjs` uses the Chromium that Playwright 1.64.1 already installed; it downloads nothing. On the Mac, bound each run: `perl -e 'alarm 3000; exec @ARGV' node run.mjs`.

To compare OTLP/JSON with OTLP/protobuf on the same records, save the request bodies of one run and re-encode them:

```bash
SAVE_BODIES=results/bodies VARIANTS=ouo-replay ROUNDS=1 OUT=results/bodies-run.json node run.mjs
python3 json_vs_proto.py results/bodies
```

Then rebuild the findings and the report from the repo root: `python3 project/agents/sdk-state/scripts/summarize_overhead.py && python3 project/agents/sdk-state/scripts/build_report.py`.

## Limits

- One Chromium build, headless, on a shared Mac. Firefox and WebKit were not measured.
- The journey is light (a few hundred DOM nodes). Heavy DOMs make replay cost grow with mutations; the archived web benchmark measured a 10,000-node page.
- `run.mjs` reports the load average with each run (`loadavg1`). Variants ran in the same rounds, so contention affects them alike, but absolute CPU numbers move with load.
