# Browser SDK: never breaking the host page, long sessions, rrweb cost

Checklist N42 and N43 (part B of N36), 2026-10-24. Code: `sdk/browser/src/guard.ts` and its callers;
specs `e2e/faults.spec.ts`, `e2e/csp.spec.ts`, `e2e/soak.spec.ts`, `e2e/rrweb-cost.spec.ts`.

## Containing SDK errors

- One helper module (`guard.ts`): `guard(fn)` for callbacks the platform calls, `attempt(fn, fallback)`
  for synchronous SDK work inside a patched function or public method, `quiet(promise)` for SDK
  promises that must never become `unhandledrejection`. The counter `guardedFailures()` is what
  tests assert on.
- `systemClock.setTimeout` wraps its callback in `guard()`. Every SDK timer (batch processors,
  chunker, tracker, session manager) goes through it, so files outside B's scope are covered too.
- rrweb's `errorHandler` must **return `true`**, or rrweb rethrows the error after calling it
  (`callbackWrapper` in rrweb 2.x: `if (errorHandler && errorHandler(error) === true) return;`).
  Before N42 the handler returned undefined: every rrweb observer error reached the page.
- `import("rrweb")` rejecting (chunk blocked by CSP, ad blocker, offline) was an unhandled
  rejection on the page, which the SDK then reported as the page's own error. It now resolves and
  turns replay off.
- Patch hygiene: call the original first, return its value, let its exceptions through unchanged.
  On uninstall restore only when the global still points at our wrapper; otherwise leave it and
  make ours a pass-through with an `active` flag. Restoring unconditionally deletes a router's or
  another tool's wrapper installed later.
- Observe errors with `addEventListener("error" / "unhandledrejection")` only, never by assigning
  `window.onerror`: the page's handler, its `return true` and `preventDefault()` keep working.

## OpenTelemetry globals and re-init

- `WebTracerProvider.register()` sets three globals (tracer provider, propagator, context manager)
  and returns nothing; `logs.setGlobalLoggerProvider` returns the provider that won. To shut down
  cleanly do what `register()` does by hand and keep the booleans: `trace.setGlobalTracerProvider`,
  `propagation.setGlobalPropagator`, `context.setGlobalContextManager` return false when something
  is already registered (an app with its own OTel). Disable only the ones you set.
- `registerInstrumentations()` returns the function that disables them (unwraps fetch / XHR).
  The old `_uninstall` never called it, so a second `initRUM` after uninstall double-wrapped fetch.

## Server rendering and Next.js

- `initRUM` validates the config first (still throws on a missing id / token, like in a browser),
  then returns an inert instance when `window` or `document` is missing, without storing it, so
  the client's call later starts the real one.
- tsup: a `banner: { js: '"use client";' }` is dropped by tsup's rollup tree-shaking pass
  ("Module level directives cause errors when bundled") and by terser (`compress.directives`). The
  React entry is built separately with `treeshake: false` and esbuild's minifier; the core keeps
  terser. Output layout unchanged (two builds in one `defineConfig([...])`).
- A Next.js 15 scaffold writes `moduleResolution: "node"` into tsconfig.json, where package
  `exports` subpaths are invisible to TypeScript: `@ouo11y/browser/react` failed to type-check. Fix:
  `typesVersions: { "*": { "react": ["./dist/react.d.ts"] } }` in package.json.
- Next.js check that passed (not in CI: it needs `next` installed): `npm pack` the SDK into a
  scratch app with `app/layout.tsx` (server component) wrapping `{children}` in `OuoErrorBoundary`,
  `app/rum.tsx` (`"use client"`, `initRUM` at module scope, `useOuoRoute`), `next build && next
  start`, then Playwright: session id set on the client, no console errors. Keep the server and
  client text identical in the test component, or React reports hydration error #418.

## Storage

- `localStorage` failure modes: the getter throws `SecurityError` (sandboxed iframe without
  `allow-same-origin`, some third-party contexts), `setItem` throws `QuotaExceededError` (full;
  Safari private mode before 11 had quota 0), or both work for a while and writes start failing.
- Mixing stores is the trap: a write that fails goes to memory, the next read succeeds on the
  platform store and returns the stale record. `LocalStorage` switches to memory for good on the
  first failure, after copying the `ouo.*` keys it can still read; a probe write at construction
  catches the quota-0 case before the session is read.

## CSP and Trusted Types

- rrweb record (no canvas, no fonts, no inline images) and the SDK need no `unsafe-eval`, no
  `unsafe-inline`, `style-src 'self'` is enough, and `require-trusted-types-for 'script';
  trusted-types 'none'` produces no violation in Chromium, Firefox or WebKit (Playwright 1.64).
  rrweb's replayer is a different story (it writes styles), but it runs in Grafana, not on the page.
- Testing a policy: the page's own probe of a sink is a violation too, reported asynchronously;
  wait, then clear the violation list before driving the page.

## Fault-injection pattern

- A page that records everything its own handlers see into `window.transcript`
  (`e2e/pages/faults.js`), run in a fresh context with `?sdk=0` and `?sdk=1`, compared for
  equality. Variants come from `page.addInitScript` (storage blocked / full) and a dead collector
  port. Wait about 250 ms per step and poll until the transcript stops growing: fetch-to-nowhere
  rejections and XHR loads arrive late.
- The stub's fault switch (`POST :4181/__fault {status, retryAfter, delayMs}`) is for delivery's
  network specs (session A).

## Firefox on this Mac

- Playwright's Firefox 157 (revision 1555) exits with "Could not find profile folder" on macOS 27,
  sandboxed or not. Run Firefox specs in the CI image instead:
  `docker run --rm --ipc=host --network host -v "$PWD:$PWD" -w "$PWD/sdk/browser"
  mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b5... npx playwright test -c e2e/playwright.config.ts --project firefox`.

## Soak: measuring growth in every engine

- No heap API outside Chromium. The probe (`e2e/pages/soak-probe.js`, `addInitScript`) wraps
  `addEventListener` / `removeEventListener` (window and document only: listeners on nodes, XHRs and
  channels die with their target), `observe` / `disconnect` of the four observer types, and
  `setTimeout` / `setInterval`, and counts what is alive. Chromium adds CDP:
  `HeapProfiler.collectGarbage` then `Runtime.getHeapUsage`, and `Performance.getMetrics`
  (`JSEventListeners`, `Nodes`).
- Reset the collector stub every sample after counting, or it holds an hour of replay in memory.
- Separate `OUO_E2E_PAGE_PORT` / `OUO_E2E_COLLECTOR_PORT` per engine lets two soaks run at once.

## rrweb cost (Chromium, 10,000 elements, 2026-10-24)

| mode | full snapshot | start task time | script during 10 s of 10k text mutations/s | heap after GC | replay sent |
|---|---|---|---|---|---|
| no SDK | | 7 ms | 103 ms | 1.7 MB | |
| SDK, replay off | | 18 ms | 108 ms | 2.2 MB | |
| replay | 1045 KB | 67 ms (one 42 ms block) | 698 ms | 10.4 MB | 12.2 MB |
| replay, table blocked | 1 KB | 23 ms | 161 ms | 3.8 MB | 2 KB |

- At 50,000 elements the full snapshot (about 5 MB) is larger than the chunker's 2 MB buffer bound
  and was **dropped while mutations kept flowing**: a replay that cannot be played. The recorder
  now checks the snapshot size (it is emitted synchronously inside `record()`, before `record()`
  returns its stop function: check after it returns too) and stops replay for the page view with
  `ouo.replay.skipped`.
- WebKit has no CPU counters; the timer-lag meter there is dominated by the engine's own jitter
  (the no-SDK baseline lags as much as replay), so only the sizes are comparable across engines.
- `requestAnimationFrame` gaps are useless as a jank meter in headless runs (frames are throttled);
  a 10 ms `setTimeout` chain's lag works in every engine.

## Bundle size

- esbuild's minifier vs terser on the core entry: 44.0 vs 42.0 KB gzip (terser `passes: 2` in tsup,
  41.7 with the CLI). The guards cost about 1 KB gzip; terser pays for them and leaves room under
  the 44 KB budget.
- Per-call string labels in the guards (`guard("click listener", ...)`) cost about 0.3 KB gzip;
  dropped, the debug log prints the error with its stack instead.

## Local env quirks seen

- `npm` from a worktree under the main checkout walks up to the main checkout's package.json and
  parses its workspaces; when the main checkout has merge-conflict markers in a workspace
  package.json every npm and npx command dies with "Exit prior to config file resolving / call
  config.load() before reading values" (the real error, a JSONParseError, is hidden). `npm --prefix
  <worktree root>` avoids the walk.
- `examples/ouo-web/scripts/run.sh` serves on :4173 by default; when another session's preview
  holds that port, the journey silently runs against that session's build (another env's collector).
  Pass `--port`.
- The first ouo-web runs right after `ouo-env up` lost telemetry (accepted with 200, absent from
  Loki or Tempo) and failed verify; the same build passed 24/24 a few minutes later, and so did
  origin/main's build against the same env. Give a fresh env a few minutes before verify.
