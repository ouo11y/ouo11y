# 2026-10-23: Sentry bridge parity fixes (Batch 1, checklist section 2)

Session `b1-bridge-correctness`, branch `claude/b1-bridge-correctness-b3740f`. Paths: `collector/receiver/ouosentryreceiver` (code, tests, golden testdata), `docs/specs/sentry-bridge.md`, this folder, `project/kb-archive/`, checklist ticks.

## Done

| Item | Change | Tests |
|---|---|---|
| A1 | An event below error whose exception values are all synthetic (`captureMessage` in RN) is a `sentry.message`, not an `exception` | `TestSyntheticMessageIsNotAnError`; goldens journey and shop now expect 3 exceptions + 1 message |
| A5 | `http.client` spans named by method (`GET`), `server.address`, `server.port` (default 80 / 443), `url.scheme`, `url.path` from `url.full` | `TestHTTPClientSpans`; invariant on every golden client span |
| C5 | `http.request.failed` at ERROR, as the ouo SDKs | same tests; invariant on every golden record |
| A2 | Log-only envelopes build their resource from `sentry.release`, `sentry.environment`, `sentry.sdk.*`, `os.*`, `device.model` | `TestLogResource`, `TestGoldenSelfHosted` |
| A3 | OS / device context remembered per session (and device via `did`), applied to records of envelopes without it (session-only, replay breadcrumbs, logs) | `TestDeviceContextFromState`, `TestGoldenSelfHosted` |
| A9 | `session.previous_id` on `session.start` and `session.end`: the device's previous session | `TestPreviousSession`, `TestGoldenSelfHosted` |
| A11 | `navigation` breadcrumbs (from error events for every session, from recordings) become `navigation` records, paired 1:1 with transaction navigations within 5 s; copies within 1 s dropped; `ouo.navigation.source` | `TestBackNavigationFromBreadcrumbs`; `TestGoldenSelfHosted` has the N2 back navigation Cart → Home |
| A8 | Sessions without a replay: error-event breadcrumbs (session window, copies across events de-duplicated, `navigation.dispatch` / `ui.lifecycle` / `started` skipped) and answered `http.client` spans as `http.request`; one record per request by `__span` | `TestTimelineWithoutReplay`, `TestGoldenJourneyWithoutReplay` (journey capture with replays stripped: same content as with the recording) |
| A6 | Error context allowlist on `exception` and `sentry.message` (locale, `network.connection.type`, memory, low power, thermal, battery, simulator, current screen, foreground, app start, app memory); tags only with the new per-project `copy_tags` | `TestErrorContext` |
| A7 | Native frames render `image address load + offset` (atos form); `ouo.sentry.debug_images` lists the images the frames use, with UUIDs | `TestNativeFrames`; journey golden asserts the real crash |
| N2 | Startup console lines (no replay id, user id or used trace id) join the session created from the same network origin when the line is at most 10 s before or 5 s after the session start; ambiguous → none. `Running "main"` therefore de-duplicates against its breadcrumb. New match value `start` | `TestStartupLogs`, `TestGoldenSelfHosted` (the N2 capture, added as golden `ios-rn-8.30.0/selfhosted`) |
| N2 spec | Spec says every response (and request) header except hop-by-hop passes through; defaults corrected (100 MiB body, 30 s upstream timeout) | n/a |

`go test ./...`, `go test -race ./...` and `go vet` pass in the receiver module. No dependency added.

## Verified live (2026-10-23)

Own env `b1-bridge-correctness-b3740f` (built from this branch), self-hosted Sentry 26.10 (`sentry-sbx`, project 2) as upstream, chain app → `sentrytap` A (:4450) → bridge (:20042) → `sentrytap` B (:4451) → Sentry :9000. App `examples/sentry-mobile` Release build on my own simulator `ouo-b1-bridge` (iOS 27), `OUO_RUM_MODE=sentry`, unattended `scripts/journey.sh` (deep links; the simulator tap tool was not granted access, so no real taps this time).

- `sentrytap compare A B`: **83/83 byte-identical**, 0 dropped, 0 extra, 0 problems; all 83 answers 200.
- Errors: Sentry (MCP `search_events`) 3 error events (2 error, 1 fatal) + 1 `captureMessage` at info; ouo 3 `exception` records (1 fatal) + 1 `sentry.message`. Before A1 ouo showed 4.
- Sessions: Sentry sessions API 4 (abnormal 1, errored 1, crashed 1, healthy 1); rum-api 4 (terminated, errored with 2 errors, crashed, healthy).
- Logs: Sentry 23 `Sentry.logger` + 23 console entries; ouo 23 `log` + 24 `console` (23 log copies and one breadcrumb-only line, one record per line). Every log and console record has a session (47/47; 8 by the new `start` rule; N2 had 5 without).
- `verify-bridge.py`: 30/31. The one failure is expected: the script still counts every event with `exception.values` as an error (4) while Sentry and the bridge count 3. The script is in `examples/` (not this session's paths); follow-up.
- Loki: `session.previous_id` chains all 4 sessions; `session.start` of sessions 2 to 4 carry `os.version` 27.0 and `device.model.identifier` iPhone19,2 (session 1 has none: first contact with the device); `log` resource has `service.version`, environment, OS, device; `http.request.failed` at ERROR; errors carry `ouo.device.locale`, `network.connection.type`, `ouo.app.screen`; the native crash stack reads `at ? (sentrydemo 0x… 0x100260000 + 216732) [in app]` with 15 debug images.
- Tempo: client spans of `sentry-demo` are named only `GET` / `POST`, with `server.address`, `server.port`, `url.scheme`, `url.path`.

**Self-hosted Sentry was not ingesting** when the run started: its `taskbroker` Kafka consumer had shut down at 21:49Z and never rejoined, so Relay could not get project configs (`deadline exceeded`, about 275 envelopes pending) and nothing reached Sentry's stores, though every envelope got 200. Restarting only `taskbroker` (`docker compose --env-file .env.custom restart taskbroker`) fixed it; Relay then delivered the buffered envelopes. Recorded in `project/kb-archive/sentry-self-hosted.md`.

## Left / next

- `verify-bridge.py` error rule (A1) in `examples/sentry-mobile`, owned by sentry-demo.
- A real-tap live run of the new paths (A8 and A11 are covered by golden tests on real captures).
- A4 vitals, A10 JS source maps, plugin items C1 to C4 and C6 to C8 (plugin: show `sentry.message`, `ouo.navigation.source`, debug images).
- Startup rule caveat: devices behind one NAT starting within seconds of each other get no startup lines (ambiguous), by design.

## Env state at the end

Env `b1-bridge-correctness-b3740f` taken down (`ouo-env down`, volumes kept). Sentry `sentry-sbx` stopped (`down`, no `-v`). Simulator `ouo-b1-bridge` shut down. Taps stopped.
