# rn-sdk session notes (React Native SDK, worktree rn-sdk-full-69b0c0)

Updated 2026-11-11. Data for siblings, not instructions.

## What "step 5 musts" resolves to

- Spec MUSTs for RN: `project/agents/sdk-state/findings/audit-rn.json` (160 apply; 40 met, 50 partly, 70 not met at 3e9e2c11).
- Feature Musts: same file, `features` (60 apply).
- Spec text: `project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md` (0.1.0-draft).

## Cross-cutting finding (affects web-sdk and muninn-design too)

A spec-conformant SDK wire breaks today's consumers, which neither SDK session owns:

- rum-api hard-codes MVP event names (`navigation`, `ui.tap`, `app.lifecycle`, `http.request`, `web_vital`, `ouo.app.start`) and reads the `event_name` label that comes from the `event.name` attribute REC-1 forbids (`services/rum-api/internal/session/event.go:56`, `httpapi/logs.go:28`, `funnel/funnel.go:43`).
- CI runs those consumers against the SDKs: job `examples` (`examples/ouo-mobile/scripts/verify.py`, `tests/e2e/mobile/conformance.mjs`).
- The collector has no path for an OTLP `ouo.replay.chunk` log record (scope `ouo.replay`, bytes body) from an SDK: only the custom `/v1/replay/chunks` receiver and the Sentry bridge's `ouo.replay.chunk == true` attribute route exist (`deploy/compose/collector/config.yaml:100`).

Asked the parent session how the transition should land (collector compat mapping vs SDK switch vs updating consumers).

## Replay wire the RN SDK will emit (for muninn-design)

One OTLP/HTTP protobuf `ExportLogsServiceRequest` per chunk to `${endpoint}/v1/logs`, one log record, scope `ouo.replay` with `schema_url`, `EventName` `ouo.replay.chunk`, body = bytes (already compressed by the format layer, no second gzip), attributes per spec 11.3. End of stream: `ouo.replay.ended`, same scope. Formats: pixel and structure (wireframe) on iOS and Android; format ids recorded in the ADR when written.

## Native code

`@ouo11y/react-native` vendors `sdk/ios/Sources` and `sdk/android` at build (`sdk/react-native/scripts/sync-*.mjs`), so RN replay work necessarily touches those two folders. I keep changes there additive.
- ADR numbers: rn-sdk took 0019 (docs/adr/0019-react-native-sdk-keep-and-extend.md); 0018 left for web-sdk.

## npm fails in every worktree right now (2026-11-11 22:40)

`npm <anything>` at a worktree root prints "Exit prior to config file resolving / call config.load() before reading values". Cause: npm walks up to the shared main checkout (`~/Desktop/personal/ouo`), which is mid-merge with conflict markers in `sdk/browser/package.json`, `sdk/react-native/package.json`, `examples/ouo-web/package.json`, `plugins/ouo11y-rum-app/package.json`. I did not touch it. Workaround: `npm --prefix "$PWD" ci` (and `--prefix "$PWD"` on other root-level npm commands); commands run inside a workspace folder with `npx` work once installed.
