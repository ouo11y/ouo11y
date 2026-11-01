# Browser SDK delivery: keepalive, beacons, retry, gzip, offline store

What `@ouo11y/browser` does so telemetry survives flaky networks, a busy collector and closed tabs (N36 part A, 2026-10-24), and the browser and collector behaviour that shaped it. Code: `sdk/browser/src/transport/`. User docs: the README's "Delivery" and [docs/first-party-endpoint.md](../../docs/first-party-endpoint.md).

## Page hide

- **The keepalive budget is shared and small.** Browsers refuse a `keepalive` fetch or a beacon once the bodies in flight would pass 64 KiB in total. Chromium also refuses more than 9 at once (whatwg/fetch#679). The SDK keeps one module-level counter (`transport/keepalive.ts`, 60 KB / 9) for OTLP and replay, reserves before every request and releases when it settles. At page hide the OTLP exporter halves a batch until each part fits what is left.
- **Nothing may be awaited before the request leaves at page hide.** After `pagehide` the page may be gone after the current task. `CompressionStream` is async, so page-hide requests go uncompressed. `Delivery.sendUrgent` calls `fetch` synchronously; an `async` function runs synchronously up to its first `await`.
- **Chromium fires `pagehide` while `document.visibilityState` is still `visible`** (then `visibilitychange`; see `telemetry/batch.ts`). So "is the page leaving" is a flag set by a capture-phase `pagehide` listener. The `Delivery` is created before `initRUM` adds its own `pagehide` flush, so the flag is set first. `pageshow` (bfcache restore) clears it.
- **`sendBeacon` cannot carry `Authorization`**, and the collector authenticates with `basicauth/server` only (ADR-0007). A beacon straight to the collector is a `401`. So `transport.beacon` is off by default and documented for a first-party proxy that injects the header. The default fallback beyond the budget is the offline store, plus a plain request in case the tab only went to the background.

## Retry

- Retry network errors, timeouts (AbortController, 30 s), 429, 502, 503 and 504 (OTLP/HTTP's retryable set, since N88; the mobile SDKs since N55). Every other status is final and counted as `rejected`: 408, 500, 501 and 505 included. The collector answers 429 or 503 for what may succeed later and 400 or 500 for what will not ([mobile-delivery.md](mobile-delivery.md), "Head-of-line blocking"), so retrying a 500 only cost the backoff, then a place in the offline store that the next page load retried again. Before N88 a request answered 500 every time was tried `maxAttempts` times, stored, and retried by every drain until its 24 h expiry.
- The page-hide paths follow the same rule: a keepalive request answered 500 is dropped, not stored for the next page; over the keepalive budget, a plain request answered 500 deletes the copy stored for the next page (as a 2xx does), where a retryable answer keeps it.
- Backoff is exponential with equal jitter: attempt n waits between half and all of `min(30 s, 1 s * 2^(n-1))`, so no retry is immediate and failed clients spread out. `Retry-After` (seconds or HTTP date) replaces the computed delay. Over 60 s, the request goes to the store with `notBefore` rather than waiting in memory.
- `send()` resolves after the first attempt; retries continue in the background. That keeps `rum.flush()` and the OTel batcher fast. The replay chunker's own retry now only sees refusals (`ChunkRejectedError`, `retryable: false`) and does not retry them.
- A retry waiting for its backoff is woken at page hide and goes out on the keepalive path.

## gzip

- The collector's OTLP receiver (4318, confighttp) and replay receiver (4319) both accept `Content-Encoding: gzip`. Checked with curl on an ouo-env, 2026-10-24: OTLP logs gzip 200, replay chunk gzip 202 with `bytes` reporting the decompressed size.
- Sizes from that check: a 13,504 B OTLP JSON batch of 50 log records is 582 B gzip (23x); a 6,846 B rrweb chunk is 312 B (22x). Bodies under 1 KB are sent plain, and a gzip that is not smaller is discarded.
- **A curl preflight is not a browser preflight.** confighttp's CORS (rs/cors) only answers `Access-Control-Request-Headers` in the form browsers send: lowercase and sorted (`authorization,content-encoding,content-type`). With an unsorted list (`authorization,content-type,content-encoding`) the 204 has no `Access-Control-Allow-*` headers. Sort the list before concluding CORS is broken.

## Offline store

- IndexedDB `ouo-delivery` with two object stores, `meta` (auto-increment id, url, headers, sizes, `notBefore`, `attempts`) and `body`. Eviction reads metadata only. `put` adds and evicts oldest-first in one readwrite transaction, so tabs writing at once cannot exceed the cap together.
- Failure modes handled by `ResilientStore`, which falls back to memory and never throws:
  - `indexedDB` is missing (jsdom);
  - reading the property throws `SecurityError` (sandboxed iframes, blocked storage);
  - `open` throws or errors (older Firefox private mode);
  - `onblocked` fires;
  - `open` hangs (seen in Safari, so there is a 3 s timeout).
  - `QuotaExceededError` on a write keeps that one entry in memory and stays on IndexedDB.
- The draining tab sends the store oldest first under the Web Lock `ouo-delivery-drain` (`ifAvailable`); other tabs skip. It stops at the first request that fails again and schedules the next drain with backoff (5 s to 5 min).
- Delivery is at least once. A request stored at page hide whose plain request also arrived is sent again by the next page load. Tempo keeps one span per span id, Loki drops identical lines, and the replay receiver keys chunks by `seq`.
- Stored entries keep `Authorization` (the public project token, ADR-0007), so the next page sends them with the credential they were made with.
- Unit tests use `fake-indexeddb`'s `IDBFactory` per test. Its structured clone returns the Node realm's `Uint8Array`, so `toBeInstanceOf(Uint8Array)` fails under jsdom; use `ArrayBuffer.isView`.

## Testing network faults

- Playwright `context.setOffline(true)` makes `navigator.onLine` false and fails fetch in Chromium, Firefox and WebKit, and `setOffline(false)` fires `online`. All three passed the offline specs.
- The e2e collector stub's `POST /__fault` switch was started by session B; A extended it. Fields: `{status, retryAfter, delayMs, count, paths}`. `{}` clears it. Delay alone gives a slow but successful collector.
- The stub must send `Access-Control-Expose-Headers: Retry-After`, as the real collector config does. Without it a cross-origin page cannot read the header, and the SDK falls back to backoff.
- Local Firefox 1555 (Playwright 1.64.1) fails with "Could not find profile folder" on this Mac, even with a custom TMPDIR. Run Firefox in the CI image instead: `docker run --ipc=host --network host -e OUO_E2E_PAGE_PORT=4380 -v "$PWD:$PWD" -w "$PWD/sdk/browser" mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test -c e2e/playwright.config.ts --project=firefox`.
- `OUO_E2E_PAGE_PORT` moves the e2e servers, with the collector stub on the next port. Parallel sessions otherwise share 4180/4181, and Playwright's `reuseExistingServer` silently tests another checkout's build.

## Worktree pitfalls seen in this run

- **npm walks up from a worktree into the parent checkout.** A worktree under `.claude/worktrees/` sits inside the main checkout. npm resolves the workspace root by walking up and reads the parent's workspace `package.json` files. When the parent was mid-merge (conflict markers), every root `npm` command failed with "Exit prior to config file resolving / call config.load() before reading values". `npm --prefix <worktree> ...` stops the walk. A shim on `PATH` does the same for scripts such as `ouo-env` and `run.sh`.
- **A partial install resolves packages from the parent's `node_modules`.** `npm ci` run inside one workspace installed only that workspace's dependencies. The ouo-web build then took `react-router-dom` from the parent checkout, with that checkout's React: "Cannot read properties of null (reading 'useRef')". Install from the worktree root with `npm --prefix "$PWD" ci`.
- Concurrent ouo-envs can cross-wire Loki and Tempo through the shared `ouo-proxy` network aliases (session C's finding). A verify that fails only on Loki or Tempo checks, while another env is up, is suspect: rerun with one env.
