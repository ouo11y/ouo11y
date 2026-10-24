# 2026-10-24 N36 part B: page safety, compatibility, long sessions (N42, N43)

Owner: sdk-browser, session B of N36 (A: delivery, C: source maps, in parallel). Branch
`claude/web-sdk-safety-209ff7`. Env: `ouo-env up web-sdk-safety-209ff7` (admin / testing567),
torn down at the end of the run.

## Done

- **Every hook guarded** (`src/guard.ts`: `guard`, `attempt`, `quiet`): DOM and window listeners
  (activity, clicks, storage, visibility, pagehide, replay tab lease), patched `history` and
  `console.error`, fetch / XHR instrumentation hooks, `PerformanceObserver` / `MutationObserver` /
  web-vitals callbacks, every SDK timer (wrapped once in `systemClock`, which also covers
  `telemetry/batch.ts` and `replay/chunker.ts` without editing them), rrweb (`record()`, `emit`,
  stop, snapshots, custom events). Two real leaks into the page fixed: rrweb's `errorHandler`
  returned undefined, so rrweb rethrew every observer error to the page; a failed rrweb chunk
  import was an `unhandledrejection` (which the SDK then reported as the page's own error).
- **Patch hygiene:** the originals run first and their result and exceptions pass through; on
  uninstall a global is restored only if it is still the SDK's (a router's later wrapper survives).
- **Lifecycle:** `initRUM` twice warns and returns the instance; new public `rum.shutdown()`
  (flush, then remove every listener, observer, timer, instrumentation; OTel globals only if the
  SDK registered them, so an app's own OTel stays) and `initRUM` again works. The old
  `_uninstall` never disabled the fetch / XHR instrumentations and left the OTel globals set. A
  start that fails part way warns, undoes what it installed and returns an inert instance; config
  errors still throw. Public methods never throw, `flush` / `shutdown` never reject.
- **SSR:** `initRUM` without `window` / `document` returns an inert instance and registers nothing.
  React entry built separately with a `"use client"` banner; `typesVersions` so the subpath's types
  resolve under `moduleResolution: node` (a Next.js 15 scaffold uses it and failed to type-check).
  Next.js 15.5 App Router production build checked by hand (kb has the recipe).
- **Storage:** `LocalStorage` switches to memory for good on the first failure (getter throwing,
  quota, later write failures), copying the `ouo.*` keys it can still read, with a probe write at
  start. Before, a failed write went to memory and the next read returned the stale record from
  storage. `sessionStorage` is not used by the SDK.
- **Browser support:** documented in the README ("Compatibility and safety"): supported = last 2
  years of Chrome / Edge / Firefox, Safari and iOS Safari 18+; syntax floor ES2022 (Chrome 94,
  Firefox 93, Safari 16.4) as an explicit tsup target per engine; `npm run compat:check`
  (es-check es2022 on every dist file + both entries imported in Node with `initRUM` inert) in the
  CI `node` job. Optional APIs feature-detected (unit test with PerformanceObserver,
  CompressionStream, BroadcastChannel, MutationObserver, requestIdleCallback, scheduler and
  `crypto.randomUUID` removed).
- **Replay limits:** new `replay.blockSelector` / `replay.maskTextSelector`. A full snapshot over
  the chunker's 2 MB buffer bound (about 20k simple elements) used to be dropped while mutations
  kept flowing: an unplayable replay. The recorder now stops replay for the page view and emits
  `ouo.replay.skipped` (`ouo.replay.skip_reason`, `ouo.replay.snapshot_bytes`).
- **Replay leak in Safari, found by the soak:** with patched DOM prototypes (Zone.js, another
  monitoring script, or the soak's probe) rrweb keeps a hidden helper iframe in the DOM on Safari,
  and each `checkoutEveryNms` snapshot attached a new set of observers to it (+2 listeners, +2
  observers every 5 min, released only on stop). Checkouts now restart the recording (same
  snapshot cost, everything released); rrweb's helper iframes are also always blocked. Kb has the
  diagnosis method.
- **Bundle:** core minified with terser (tsup `minify: "terser"`): index.js 44.0 -> 42.0 KB gzip
  (the guards alone had pushed esbuild's output 0.1 KB over the 44 KB budget), rrweb chunk 80.1 ->
  77.2 KB. Budget file unchanged. Output layout unchanged; C told through the orchestrator. C then
  found that tsup only chains terser's source map with `terserOptions.sourceMap: true` (the maps
  were esbuild's pre-terser ones and mapped nothing); fixed, and `compat:check` now proves each
  dist map resolves a known string to its source.
- **E2E (per PR, three engines):** shared `e2e/harness.ts`; collector stub fault switch
  (`POST /__fault`) for session A's network specs; `e2e/faults.spec.ts` (page transcript identical
  with and without the SDK: healthy collector, storage blocked, storage full, collector down);
  `e2e/csp.spec.ts` (`script-src 'self'`, `style-src 'self'`, `require-trusted-types-for 'script';
  trusted-types 'none'`: no violation, events + trace + replay delivered).
- **Long sessions (not per PR):** `e2e/soak.config.ts` with `soak.spec.ts` (busy SPA, replay on,
  probe counting window/document listeners, observers, timers, intervals, nodes in every engine;
  Chromium heap after GC and CDP listener / node counts) and `rrweb-cost.spec.ts`;
  `npm run test:soak`; `.github/workflows/browser-soak.yml` (workflow_dispatch only, Playwright
  image, JSON + HTML report artifact); `scripts/soak-report.mjs`.

## Dependencies added

- `es-check` 9.8.1 (dev): the syntax check of the built bundle the task asked for.
- `source-map` 0.7.6 (dev, already in the tree): resolves positions through the dist maps in `compat:check`.
- `terser` 5.46 (dev, was already in the tree through vite): tsup's terser minifier, 5 % smaller
  bundle, which keeps the size budget with the guards in.

## Verified, and how

- `npm run -w sdk/browser test`: 126 Vitest tests (19 files; new `safety`, `storage`, `ssr`, and
  a recorder case), green three times; `tsc --noEmit` clean.
- `npm run -w sdk/browser build && size:check && compat:check`: 42.0 / 0.6 / 77.2 KB within budget;
  es-check passes es2022 (fails es2020, so the check bites).
- Per-PR Playwright suite in `mcr.microsoft.com/playwright:v1.64.1-noble` (the CI image): 40
  passed, 2 skipped (LoAF outside Chromium) in Chromium, Firefox and WebKit, 2.3 min. Chromium and
  WebKit also on macOS.
- `examples/ouo-web/scripts/run.sh --env web-sdk-safety-209ff7 --browsers chromium,firefox,webkit
  --playwright-image <pinned> --port 4693`: 24/24, 23/23, 23/23, on the final build (terser with
  chained maps), with the env started by PR #65's ouo-env (network isolation; two earlier verifies
  had failed at random because envs resolved each other's Loki and Tempo).
- Next.js 15.5.4 + React 19.1 scratch app with the packed SDK: `next build` (prerender = SSR)
  and `next start`, Playwright: a session id on the client, no console errors.
- Soak, 60 min each, Chromium and WebKit on macOS: SOAK_RESULT.
- rrweb cost, Chromium and WebKit, 10k elements, and Chromium 50k: numbers in the kb entry and the
  report `project/agents/sdk-browser/reports/long-sessions-2026-10-24.html`.

## Left / next agent must know

- Firefox does not launch natively on this Mac (Playwright Firefox 157, "Could not find profile
  folder"); run Firefox specs in the Playwright image. The soak's second engine here was WebKit;
  the workflow defaults to Chromium + Firefox in the image.
- The first 60 min soak (build before the leak fix) failed: WebKit grew as above; Chromium was flat
  but its observer count (5 to 8 with idle spans open at sampling time) exceeded a slack of 1, now 3.
- Not done: a Next.js check in CI (it needs `next` as a dependency); the rrweb cost in Firefox.
- Session A: the fault switch and harness are described in the shared notes (`n36-b-safety.md`).
  A owns the chunker's bounds; the recorder's snapshot limit follows `DEFAULT_MAX_BUFFER_BYTES`.
- Session C: the build is two tsup configs now (core with terser, React entry with esbuild and the
  banner); source maps are still emitted by tsup next to each file.
- Environment: the main checkout (`/Users/ziadhassanin/Desktop/personal/ouo`) had merge-conflict
  markers in five workspace package.json files, which makes every npm / npx command in a worktree
  under it fail ("Exit prior to config file resolving"). Not touched; worked around with
  `npm --prefix`. Another session's preview held :4173, so ouo-web's journey needs `--port`.
- Ids: N41 was taken by C (source maps); B used N42 and N43; A takes N44+.
