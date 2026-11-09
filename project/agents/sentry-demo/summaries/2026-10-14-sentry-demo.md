# 2026-10-14 sentry-demo: Sentry-only Expo iOS app, journey, first real capture

## Done

- `examples/sentry-mobile`: an Expo 57 / RN 0.86.3 app (React Navigation native-stack, screens Home, Product, Cart) instrumented **only** with `@sentry/react-native` 8.30.0, which bundles sentry-cocoa 9.30.1. `src/sentry.ts` sets `tracesSampleRate: 1`, the React Navigation integration (TTID on), fetch tracing, `tracePropagationTargets` localhost, `enableAutoSessionTracking`, native crash handling, `mobileReplayIntegration()` with default masking, `replaysSessionSampleRate: 1` and `replaysOnErrorSampleRate: 1`. DSN, release (`sentry-demo@1.0.0+1`, dist `1`), environment (`development`), backend URL (`http://localhost:8082`) and debug flag come from `app.config.ts` `extra`, set by environment variables at build time. Debug logging is off by default (`SENTRY_DEBUG=1` turns it on).
- Actions (buttons and deep links `sentrydemo://action/<name>`, `sentrydemo://screen/<name>`): `fetch-ok`, `fetch-500`, `fetch-slow` (each in a `ui.action` transaction), `handled-error`, `message` (breadcrumb + `captureMessage`), `unhandled-rejection`, `js-fatal`, `native-crash`, `flush`.
- `src/mailbox.ts`: a prompt-free command channel. On iOS 27, `simctl openurl` raises an "Open in …?" alert for every custom-scheme URL, so it cannot run unattended (see kb).
- `scripts/build-ios.sh`: expo prebuild (first run or `--clean`), `pod install`, Release `xcodebuild` for the simulator with the JS bundle embedded, `simctl install`. Sentry uploads are disabled.
- `scripts/journey.sh`: an unattended journey with timestamped log. Phases: launch, nav, network, errors, replay wait, background 40 s (Settings), crash. Opt-in `--js-fatal`. Flags `--no-nav`, `--no-network`, `--no-errors`, `--no-background`, `--no-crash`, `--bg-seconds`, `--replay-wait`, `--device`, `--openurl`.
- `scripts/recorder.py` (stdlib fallback sink) and `scripts/analyze.py` (reads sentrytap and recorder captures; decodes envelopes and msgpack `replay_video`; can dump one segment).
- `project/kb-archive/sentry-react-native-demo.md` + kb index line, `project/agents/sentry-demo/` (index, tracker, this summary), and an `project/agents/index.md` line.

Dependencies added (inside the example only): `@sentry/react-native` 8.30.0 is the SDK under test, newest release. `expo-linking` provides deep links. `expo-file-system` runs the journey mailbox; its native module was already linked by `expo`.

Why 8.30.0 rather than Expo's pinned `~7.11.0`: it is the newest version, its peer ranges accept Expo ≥ 49 and RN ≥ 0.65, and it built and ran without patches. Real users of current Sentry will be on 8.x / cocoa 9.x. 7.11 (cocoa 8.58) is listed as open for range pinning.

## Verified, and how

- `npx tsc --noEmit` is clean. `scripts/build-ios.sh` gives `** BUILD SUCCEEDED **` (Xcode 27.0, iPhone 18 Pro iOS 27 simulator D64DE653…) and installs `dev.ouo.sentrydemo`. The build log shows `SENTRY_DISABLE_AUTO_UPLOAD=true, skipping sourcemaps upload`.
- Capture: `collector/tools/sentrytap -listen 127.0.0.1:4400 -dir captures/2026-10-14-journey -sink` (built from the parallel agent's source), then `scripts/journey.sh` (full journey, 2 min 10 s), then `scripts/analyze.py`. A second short capture `captures/2026-10-14-touch` holds three injected taps/swipes and `--js-fatal`.
- Full journey, 36 requests, all `POST /api/1/envelope/`, all `Content-Encoding: gzip`:

| Item type | Count |
|---|---|
| replay_video | 16 (3 replays, one per session) |
| transaction | 11 (`ui.load` ×2, `navigation` ×6, `ui.action` ×3; fetch 500 span with status code 500 / `internal_error`) |
| session | 8 (init ×3; ok ×2; `exited` ×1; `crashed` ×1; `abnormal` ×1 from an earlier `simctl terminate`) |
| event | 4 (handled error, info message, unhandled rejection, native crash `EXC_BAD_ACCESS` level fatal) |
| client_report | 2 |

  Touch run: JS fatal `event` (level `fatal`, mechanism `onerror`, `handled: false`) + session `crashed`, 8 `replay_video` items, and touch events.
- `sdk.name` values seen (envelope header): `sentry.javascript.react-native` 8.30.0 (transactions, JS events, most replay segments) and `sentry.cocoa.react-native` 9.30.1 (sessions, native crash, a natively flushed replay segment). User-Agent is always `sentry.cocoa.react-native/9.30.1`.
- `replay_video` is msgpack: first byte `0x83` (fixmap 3), `str8` keys, `bin32` values. `replay_recording` is uncompressed JSON. `replay_video` is mp4 (`ftypmp42`). One segment is dumped in `captures/2026-10-14-journey-replay-segment/` (`replay_event.json`, `replay_recording.bin`, `segment.mp4`).
- Answers to the open questions in `project/kb-archive/sentry-envelope-format.md` are in `project/kb-archive/sentry-react-native-demo.md`: did = user.id; `exited` is sent on the next foreground; touches are in video (point) space on iOS; events carry `contexts.replay.replay_id`; transactions only carry envelope `trace.replay_id`.

## Captures

`examples/sentry-mobile/captures/` (gitignored):
- `2026-10-14-journey/`: the raw request set (sentrytap layout `<NNNNNN>/request.json`, `body.bin` gzip as received, `response.json`).
- `2026-10-14-journey.log`: the journey's timestamped log.
- `2026-10-14-journey-summary.json`: analyze.py output.
- `2026-10-14-journey-replay-segment/`: one decoded segment.
- `2026-10-14-touch/`: a small extra set with touches and a JS fatal.

The orchestrator's two synthetic smoke envelopes (`com.acme.smoke@9.1.0+7`) landed in an early smoke directory, which was deleted. They are in none of the kept captures.

## What the bridge must know (spec deltas)

1. Auth comes only in the `X-Sentry-Auth` header: no `sentry_key` query, no envelope `dsn`. The DSC `trace.public_key` is present on event and transaction envelopes.
2. `sdk.name` is `sentry.cocoa.react-native` / `sentry.javascript.react-native`, never bare `sentry.cocoa`. Platform should come from `contexts.os.name` or `replay_event.platform` (`cocoa`).
3. msgpack key order in `replay_video` varies, so decode it as a map.
4. `replay_start_timestamp` is on every segment and equals that segment's start.
5. Touch moves are `source: 6` with `positions[]` (`timeOffset` ms), not `source 2 type 8`. Video and touches are both in points on iOS (402×874).
6. Session updates omit `init` after the first. `abnormal` has `timestamp == started` and duration 0. The crashed session arrives after the next session's `init`.
7. **Stale `trace.replay_id`** on JS transactions after a background session rotation: they point at the previous session's replay. Replay-based session resolution must check the session time window.
8. The unhandled rejection is `handled: true` and never sets session `unhandled`.
9. Without an active span, fetch produces no span at all. Navigation-less failed requests are invisible unless the app has user-interaction tracing or its own spans.
10. `client_report` items show up; ignore them.

## Left

- Android (no SDK on this Mac).
- A capture with `@sentry/react-native` 7.11 (Expo's pin) and with a native-only sentry-cocoa app, to pin the version range.
- Check whether JS *events* (not only transactions) also carry a stale replay id after rotation. The journey had no JS error after the background phase; add `link action/handled-error` after the background phase to test it.
- `ui.action.touch` transactions (`enableUserInteractionTracing`) are not exercised.

## Next agent

Build with `cd examples/sentry-mobile && npm ci && scripts/build-ios.sh`. Record with sentrytap on 127.0.0.1:4400, or point `SENTRY_DSN` at the `ouosentry` receiver (port 4320) and rebuild. Run `scripts/journey.sh`. Analyse with `python3 -I scripts/analyze.py captures/<dir>`.
