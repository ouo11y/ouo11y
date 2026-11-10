# sentry-web: Sentry browser SDK research demo

A small Vite + React 19 app that exercises every feature of `@sentry/react` / `@sentry/browser` **11.11.0** against a Sentry endpoint, so the traffic can be recorded with `sentrytap`. Made for Step 6 (vendor research); the findings are in [project/kb/vendor-internals/sentry/browser-sdk/](../../project/kb/vendor-internals/sentry/browser-sdk/index.md). Not a product example.

All `@sentry/*` packages come from npm at exact versions. Nothing is loaded from a CDN at runtime.

## Run

Needs Node 24, Go 1.26 (for sentrytap) and a Sentry to send to (the Step 6 self-hosted one listens on `localhost:9000`).

```bash
cd examples/sentry-web
npm install
cp .env.example .env.local        # put the project's public key in VITE_SENTRY_DSN
(cd ../../collector/tools/sentrytap && go build -o /tmp/sentrytap .)
/tmp/sentrytap -listen 127.0.0.1:4520 -dir caps/fwd -forward http://localhost:9000 &
npm run build && npm run preview  # http://127.0.0.1:4521
```

Open the page and click the buttons, or call `window.demo.<name>()` from a driver. Decode what was captured:

```bash
python3 -I scripts/decode_captures.py caps/fwd
```

## Scenarios

| Button / `demo.*` | What it triggers |
|---|---|
| `thrown` | Error thrown in a `setTimeout` (global handler, `browserApiErrors` wrap) |
| `rejection` | Unhandled promise rejection |
| `message` | `captureMessage` (v11 adds a synthetic stack) |
| `linked` | `Error` with a `cause` (linked errors) |
| `attachment` | Error with a scope text attachment |
| `fetchOk` / `fetchFail` | `fetch` to the local `/api/hello` (echoes `sentry-trace`, `baggage`, `traceparent`) and `/api/fail` (503, `httpClientIntegration`) |
| `navigate` | `history.pushState` (navigation span, replay navigation breadcrumb) |
| `manualSpan` | `startSpan` with attributes and CPU work (profiling) |
| `logs` | `Sentry.logger.*`, `logger.fmt`, `console.warn` through `consoleLoggingIntegration` |
| `metrics` | `Sentry.metrics.count`, `gauge`, `distribution` |
| `feedback` | `captureFeedback` with a PNG screenshot attachment taken from the canvas |
| `dropMe` | `captureMessage('drop-me')`, dropped by `beforeSend` when `?drop=1` (client report) |
| `typeText`, `drawCanvas` | Input and canvas changes for replay |
| `flush`, `replayId`, `replayFlush` | `Sentry.flush`, `getReplay().getReplayId()`, `getReplay().flush()` |
| `react render error` | Render error reported by `reactErrorHandler` on `createRoot` |

URL parameters (see `src/sentry.js`): `?replay=buffer` (buffer / on-error mode), `?canvas=1`, `?static=1` (`traceLifecycle:'static'`), `?drop=1`, `?sample=0` (error `sampleRate: 0`), `?offline=1` (`makeBrowserOfflineTransport`), `?tap=<port>` (send to another sentrytap, e.g. a 429 sink).

The Vite config serves `Document-Policy: js-profiling` (needed by `browserProfilingIntegration`) and the `/api/*` endpoints, in both `dev` and `preview`.

## Rate-limit tests need CORS

`sentrytap -sink -status 429 -rate-limits …` answers without CORS headers, so the browser hides the response and the SDK sees a network error. Put a shim in front that adds `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: x-sentry-error,x-sentry-rate-limits,retry-after` (what Relay sends), then use `?tap=<shim port>`.

## Bundle size

`npm run size` builds one tree-shaken app per feature set and prints raw, gzip and brotli sizes ([scripts/size.mjs](scripts/size.mjs)). Results: [footprint.md](../../project/kb/vendor-internals/sentry/browser-sdk/footprint.md).
