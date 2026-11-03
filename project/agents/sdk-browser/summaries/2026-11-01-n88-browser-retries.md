# 2026-11-01 N88: the browser SDK retries only what can succeed

Branch `claude/n88-browser-retries`, checklist N88 (opened by N55, PR #145, which did the same for the mobile SDKs).

## What was done

- `sdk/browser/src/transport/retry.ts`: `classifyStatus` retries 429, 502, 503 and 504 (OTLP/HTTP's retryable set) besides network errors and timeouts; every other status is `drop`, counted as `rejected`. Before, 408 and every 5xx were retried.
- Every path reads that one function, so the rule is the same while the page is visible (retry loop), at page hide (keepalive, the plain request over the budget) and when the offline store drains. At page hide, a keepalive request answered 500 is now dropped instead of stored for the next page; over the keepalive budget, a plain request answered 500 deletes the copy stored for the next page, as a 2xx does.
- Review fix: over the keepalive budget, when the copy for the next page could not be stored (no store, larger than it) and the plain request was rejected, the request was counted as dropped twice; now once (test "counts one drop, not two").
- Doc comments (`delivery.ts`, `types.ts` `maxAttempts` and `dropReasons`, `ChunkRejectedError`), README (option table and the delivery table), kb `browser-delivery.md` and `mobile-delivery.md`.

## Why it is safe

The collector answers 429 or 503 for what may succeed later and 400 or 500 for what will not (the `ouoreplay` receiver's `statusFromConsumerError`; the OTLP receiver: 503 for a non-permanent pipeline error, 500 for a permanent one). nginx and Caddy in front answer 502 or 504 when the collector is down, and those stay retried. The Next.js rewrite and the Vite dev proxy answer 500 instead (found in review: vite 7's proxy calls `writeHead(500)`, next 15's `proxy-request.js` answers 500), so with this change what a page sends through them during a collector outage is dropped. `docs/first-party-endpoint.md` now asks a proxy to answer 502 to 504 when the collector cannot be reached, gives the Vite config an error handler that answers 502 (checked with vite 7 against a dead target: 500 without it, 502 with it, and `tsc --strict` on the snippet), and tells Next.js users to put nginx or Caddy in front or proxy with a route handler that answers 502. Retrying a 500 cost `maxAttempts` attempts, then a place in the offline store that every drain retried until the 24 h expiry.

## Verified, and how

- `sdk/browser`: typecheck clean, `vitest run` 185 tests pass. New in `test/transport.test.ts`: the status table (429 and 502–504 retry; 1xx, 3xx, 400–415, 408, 500, 501, 505, 599 drop), a 500 every time costs one attempt and no store entry, 502 and 504 retried, a keepalive 500 at page hide dropped not stored, over the budget a 500 removes the stored copy, a stored entry answered 500 dropped and the drain goes on. `test/uploader.test.ts`'s page-hide failure uses 503 (500 is final now). Negative control: with the old rule back in `retry.ts`, six of these tests fail.
- Build, `size:check` (core 44.0 KB gzip, at its budget) and `compat:check` pass.
- Playwright `e2e/delivery.spec.ts` in Chromium, Firefox and WebKit (30 tests): new "500 is final: sent once, dropped and counted, and the next request goes out" against the collector stub's `POST /__fault`. Full e2e suite (`npm run test:e2e`, three engines): 70 pass, 2 skipped (Chromium-only long-animation-frame test on Firefox and WebKit).
- No `ouo-env` was needed: the browser e2e runs against its own stub (`e2e/server.mjs`), and nothing on the backend changed.
- `lychee --offline` clean.

## What the next session must know

- The browser store still expires entries after 24 h by `Date.now()` (`transport.offline.maxAgeMs`), the clock problem N77 and N83 removed on mobile. Not changed here: on the web the store is per origin and shared by tabs, and the option is public API, so it is a separate decision: checklist N92.
- Left from review, checklist N93: over the keepalive budget without a store, a plain request that arrives counts `sent` on top of the `no_store` drop; the chunker's own retry in `sendLoop` never runs (the uploader resolves on every outcome but a rejection).
- `npm` in a worktree under the shared checkout needs `--prefix <worktree>` while that checkout is mid-merge.
