# 2026-11-12: `@ouo11y/browser` rebuilt on the client SDK spec

Branch `claude/web-sdk-full-8e1953`. Decision record: [ADR-0020](../../../../docs/adr/0020-web-sdk-rebuilt-on-the-spec.md). Nothing is merged: the founder merges.

## What was done

- **Audit.** The Step 5 report ([compliance.md](../../../kb/client-sdk-state/compliance.md)) is the definition of full-feature: 157 MUSTs apply to the web, 42 were met by 0.3.1.
- **Decision.** Keep the package, the OpenTelemetry base, the build and the safety pieces; rewrite the API, sessions, sampling, signals, privacy, transport queues and replay. Spec wire only, no compatibility mode (founder, relayed 2026-11-12).
- **Build.** `sdk/browser/src` is new except `guard`, the clock, gzip, the keepalive budget and the storage wrapper. Module map: [how-the-web-sdk-is-built.md](../../../kb/client-sdk-web/architecture/how-the-web-sdk-is-built.md).
- **Replay.** `ouo.replay.chunk` / `ouo.replay.ended` log records as OTLP protobuf on `/v1/logs`. `replay.mode` names the technique (founder, 2026-11-12): the web has one, `structure/dom`, sent as `ouo.replay.format: rrweb/2`; any other value leaves replay off with a warning. Whether a session records is decided by `replay.sessionRate` and `replay.bufferRate` alone (ADR-0020 says why). The pixel recorder was removed from the public config and the build: its source stays in `src/replay/pixel.ts`, marked under development, and its browser test was removed.
- **Failure isolation.** Every public function, listener, observer, timer and patched function contains its errors; `_internal.injectFault` is the test hook; after 20 internal errors the SDK emits `ouo.sdk.disabled` once and turns itself off.
- **Demo app.** `examples/ouo-web` moved to the new API; `scripts/verify.py` checks the spec wire.

## What was verified, and how

| Check | Result |
|---|---|
| `npm test` in `sdk/browser` (vitest, jsdom, a fake Collector that decodes OTLP JSON and protobuf) | 181 tests in 9 files pass |
| Fault injection: a throw at each of 10 named SDK internals, and at all of them at once | The page sees no error, its handlers, requests and history calls are unchanged (`test/safety.test.ts`) |
| `npm run test:e2e` (Playwright 1.64.1: Chromium, Firefox, WebKit) | 54 of 54 pass: page lifecycle, the Web Lock paths (session end at shutdown and consent withdrawal, last tab), two tabs, IndexedDB, structure replay, strict CSP with Trusted Types, and one page journey compared with the SDK off and under 8 faults |
| `npm run test:soak`, 2 minutes per engine with replay on | Listeners, observers, pending timers and (Chromium) heap do not grow |
| `npm run size:check`, `npm run compat:check` | Pass. Initial JS 49.4 KB gzip (index 41.7 + shared chunk 7.0 + two small chunks); engine 7.3, structure 55.4 |
| Live stack: `deploy/envs/ouo-env up websdk`, then `examples/ouo-web/scripts/run.sh --env websdk` (Chromium) | 39 of 39 checks pass: spec event names in Loki, 13 backend requests as 13 one-span traces plus one `documentLoad` in Tempo, `session.id` from baggage on every backend span, rum-api lists the session and symbolicates the render error |
| Per requirement | [web-sdk-compliance.html](../../../kb/client-sdk-web/compliance/web-sdk-compliance.html): 157 of 157 MUSTs recorded as met, each with its test |

Not verified: a real back/forward-cache restore and a real prerender (both shown with synthetic events in jsdom); the Step 5 overhead harness (CPU, memory, bytes per minute) was not re-run, only the bundle size; Firefox and WebKit were not run against the live stack locally (CI does).

## Review (PR #182, second session)

Verdict on the first round: changes needed, eleven findings. All were fixed or answered in the PR's `Author:` comment. The recurring cause: paths that depend on Web Locks, several tabs or a consent race were tested only in jsdom, which has no Web Locks. The fixes: a reused `fetch` init no longer carries a stale `traceparent`; `session.end` is emitted at shutdown (last tab, counted with `locks.query()`) and at consent withdrawal; recovery of a dead replay stream no longer silences the live one (one record factory); held records are dropped when consent is denied; a cleared user stays cleared across tabs; a failed batch has one owner (no duplicate after an outage); a replay chunk is sent only after it is stored. Regression tests: `sdk/browser/test/review.test.ts`, `sdk/browser/e2e/locks.spec.ts`. Lessons: [otel-js-and-browser-quirks.md](../../../kb/client-sdk-web/lessons/otel-js-and-browser-quirks.md).

## What is left, and what the next agent must know

- **CI.** The `examples` job runs `verify.py`, which now checks the spec wire. `tests/e2e` and the rum-api checks that read MVP event names were not changed; if a job fails on the spec wire it is listed in the PR, not skipped.
- **The MVP read path.** rum-api still lists sessions, timelines, traces and symbolicated errors. It does not classify the new event names as vitals, clicks or navigations. Replay chunks reach the collector on `/v1/logs`, and the current collector config forwards them to Loki with their body (a 20 KB base64 line in the demo; up to 256 KiB on a large page): the Grafana player cannot play them. The collector to Muninn route (PR #180) is the fix. No collector, rum-api or plugin file was edited.
- **A spec deviation to carry into Step 7:** the spec's `replay.mode` (`off` / `session` / `buffer`) no longer exists as an option; the rates decide. The wire attribute `ouo.replay.mode` is unchanged.
- **Open for the founder:** the structure recorder is upstream `rrweb` 2.1.7, not Sentry's fork.
- **Removed on purpose:** anonymous user id, `device.id`, `console.error` as an error, `http.request.failed`, click and soft-navigation spans, long-task events, `sendBeacon`, `replay.excludeRoutes` (use `replay.stop()` / `replay.start()`), the old soak report and rrweb-cost spec, the playground (the e2e page replaces it).
- **Kept from an MVP founder decision, outside the spec:** setting a different identified user starts a new session (N45), with end reason `manual`.
- **Not built (Should or checklist items beyond the spec's MUSTs):** remote kill switch (GR-KILL-2, GR-KILL-3), Global Privacy Control, feature-flag evaluations, feedback API, console capture, view-scoped attributes, bot filtering, co-existence matrix with Sentry and Datadog in one page (GR-HAND-4).
- **Other folders that still use the old API:** `project/agents/sdk-state/measure/web/entries/*.js` and `project/agents/web-sdk-research/tools/web-bench/entries/ouo.js` (the overhead harnesses) need the new function names before they are run again.
- **Open PRs this overlaps:** #148 (retry rule), #159 (consent) and #152 (`@rrweb/record`) change the old sources; this branch covers the first two. #152's smaller recorder (22 KB instead of 55) is worth redoing on top of `src/replay/structure.ts`.
- **React Native** was not touched and no shared core package exists. Pure helpers RN may copy: `sdk/browser/src/core/`.
- **npm in a worktree on this Mac** fails at the root; use `npm --prefix "$PWD"` ([lessons](../../../kb/client-sdk-web/lessons/otel-js-and-browser-quirks.md)).

## Dependencies

None added. Removed: `@opentelemetry/instrumentation-document-load` (the SDK makes the one `documentLoad` span itself). `web-vitals` is now imported through its attribution build (INP attribution, SIG-02). `@opentelemetry/sdk-trace-web` is used for `StackContextManager` only. Licences: OpenTelemetry and web-vitals Apache-2.0, rrweb MIT. No source was copied from Sentry, Datadog or PostHog.
