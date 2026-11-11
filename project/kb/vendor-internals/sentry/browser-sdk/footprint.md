# Sentry browser SDK: bundle size

- SDK: `@sentry/browser` **11.11.0** (2026-11-05), npm ESM production build (`build/npm/esm/prod`, resolved through the package `exports`). Research date 2026-11-10.
- `B` = `https://github.com/getsentry/sentry-javascript/blob/11.11.0`.
- CPU and memory overhead are not measured here (Step 5 measures overhead). Runtime cost notes below are cited, not measured.

## 1. Measured: tree-shaken app bundles (observed)

Method: [examples/sentry-web/scripts/size.mjs](../../../../../examples/sentry-web/scripts/size.mjs) builds one Vite 7.2.2 app per variant (Rollup tree-shaking, esbuild minify, Vite's default browser target, `__SENTRY_DEBUG__` defined as `false`). Each entry only imports `@sentry/browser` and calls `init` with the listed integrations. Sizes are of the emitted JS: raw, gzip level 9, brotli quality 11 (Node `zlib`). Run on 2026-11-10 with `npm run size`.

| Variant (cumulative) | raw KiB | gzip KiB | brotli KiB |
|---|---|---|---|
| errors only (default integrations) | 85.1 | 29.4 | 26.3 |
| + `browserTracingIntegration` | 149.3 | 51.3 | 45.2 |
| + `replayIntegration` | 273.8 | 90.7 | 78.6 |
| + `replayCanvasIntegration` | 288.2 | 95.6 | 81.7 |
| + `feedbackIntegration` (sync, with screenshot) | 336.8 | 113.6 | 96.9 |
| + `browserProfilingIntegration` | 343.6 | 115.7 | 98.6 |

| Variant (alone, on top of errors) | raw KiB | gzip KiB | brotli KiB |
|---|---|---|---|
| errors + replay | 220.6 | 72.4 | 63.2 |
| errors + feedback | 134.0 | 47.5 | 41.7 |
| errors + `Sentry.logger.info` + `Sentry.metrics.count` calls | 88.9 | 30.7 | 27.5 |

Increments (gzip): tracing +21.9, replay +39.4, canvas +4.9, feedback +18.0, profiling +2.1 KiB. Logs and metrics cost about 1.3 KiB because their code ships in core and is only pulled in when called.

The replay figure includes the compression worker, which is inlined as a string and started from a Blob URL. Setting `__SENTRY_EXCLUDE_REPLAY_WORKER__: true` and serving the worker yourself (`workerUrl`) removes it, as do `__RRWEB_EXCLUDE_SHADOW_DOM__` and `__RRWEB_EXCLUDE_IFRAME__` for rrweb features (code: `B/.size-limit.js#L14-L35`, `#L89-L110`; not measured here).

The full demo app (React 19 + `@sentry/react` with every integration above + http client + console logging) is 659 KiB raw, 219.7 KiB gzip (observed: `npx vite build` output).

## 2. CDN bundles (observed, 11.11.0)

Downloaded from `https://browser.sentry-cdn.com/11.11.0/<file>` and compressed locally (`gzip -9`). Brotli was not measured (no CLI on the Mac).

| CDN file | raw bytes | gzip bytes |
|---|---|---|
| `bundle.min.js` (errors) | 95,423 | 32,506 |
| `bundle.tracing.min.js` | 158,853 | 53,713 |
| `bundle.logs.metrics.min.js` | 102,088 | 34,782 |
| `bundle.replay.min.js` | 228,109 | 74,010 |
| `bundle.tracing.replay.min.js` | 281,078 | 92,006 |
| `bundle.tracing.replay.feedback.min.js` | 294,799 | 97,945 |
| `bundle.tracing.replay.feedback.logs.metrics.min.js` | 300,538 | 99,905 |
| `replay-canvas.min.js` (add-on) | 14,967 | 5,357 |
| `feedback.min.js` (add-on, lazy) | 24,236 | 9,462 |

In v11 the base CDN bundles no longer contain metrics; `Sentry.metrics.*` is a no-op shim outside the `*.logs.metrics` bundles (code/MIG, see [configuration.md](configuration.md)). The npm package ships no CDN bundles; they are built by the release pipeline (`B/packages/browser/rollup.bundle.config.mjs`).

## 3. Sentry's own size checks

`B/.size-limit.js` lists the entries Sentry tracks: `@sentry/browser` with `init` only, with and without tree-shaking flags, `incl. Tracing`, `incl. Tracing + Span Streaming`, `incl. Tracing, Profiling`, `incl. Tracing, Replay` (also with tree-shaking flags), `incl. Tracing, Replay with Canvas`, `incl. Tracing, Replay, Feedback`, `incl. Feedback`, `incl. sendFeedback`, `incl. FeedbackAsync`, `incl. Metrics`, `incl. Logs`, `incl. Metrics & Logs`, `@sentry/react` (+ Tracing), and each CDN bundle compressed and uncompressed (code: `B/.size-limit.js#L5-L335`). They are measured with webpack and gzip from `import { init, … }`.

At 11.11.0 the file has **no `limit:` values**. Limits moved to a CI action that compares each PR with a baseline and a weekly auto-bump (code: `B/CHANGELOG.md`, entries "ci: Check bundle size increases per PR (#24737)", "chore(size-limit): weekly auto-bump", "ci(size-limit): Measure bundles when increases are accepted (#25788)"). So there is no published number to cite at this tag; use the measurements above.

## 4. Runtime cost (cited only)

- Replay compresses in a Web Worker (fflate zlib) and keeps up to 20 MB of uncompressed events in memory before it stops (code, see [replay-browser.md](replay-browser.md) section 0).
- Buffer mode records continuously and takes a full snapshot every 60 s even when nothing is sent (code, [replay-browser.md](replay-browser.md) section 1.4).
- UI profiling samples the JS thread through the JS Self-Profiling API (Chromium only; needs `Document-Policy: js-profiling`); Sentry docs state profiling adds overhead and recommend sampling (docs, `https://docs.sentry.io/platforms/javascript/profiling/`, accessed 2026-11-10).
- Step 5 owns real CPU, memory and main-thread measurements.

## 5. Differences vs 10.78.0

Not measured for 10.78.0. Code-level changes that affect size in v11: metrics removed from the base CDN bundles; console breadcrumbs moved to `consoleIntegration`; user-timing moved out of `browserTracingIntegration` into its own integration; span streaming code added (`spanStreamingIntegration`). See [configuration.md](configuration.md) "Material differences".
