# Sentry React Native demo app and what it really sends (iOS)

Question: how do we build an Expo app with only `@sentry/react-native` for the iOS Simulator, drive it unattended, and what does the SDK actually put on the wire? This answers the capture step of the Sentry bridge (ADR-0008, `docs/specs/sentry-bridge.md`) for iOS / React Native and corrects several guesses in `kb/sentry-envelope-format.md`.

Written 2026-10-14 by `sentry-demo`. App: `examples/sentry-mobile`. Captures (gitignored): `examples/sentry-mobile/captures/2026-10-14-journey/` (full journey) and `captures/2026-10-14-touch/` (taps plus a JS fatal).

## Versions

| Piece | Version |
|---|---|
| Expo / React Native | 57.0.28 / 0.86.3 (New Architecture, Hermes) |
| `@sentry/react-native` | 8.30.0 (JS core `@sentry/core` 10.76.0) |
| sentry-cocoa (bundled by the RN pod) | 9.30.1, as a prebuilt `Sentry.xcframework` |
| Xcode / simulator | 27.0 / iPhone 18 Pro, iOS 27.0 |

Why 8.30.0: it is the newest release (2026-10-08). Its peer ranges accept Expo 57 and RN 0.86 and it built and ran without patches. `npx expo install @sentry/react-native` would pick `~7.11.0` (Expo 57's `bundledNativeModules.json`, sentry-cocoa 8.58.0, January 2026). Capturing 7.11 as well is an open task, to pin the bridge's supported range.

## Build gotchas (all handled in `scripts/build-ios.sh` and `app.config.ts`)

- **Never upload to sentry.io.** The Sentry Expo plugin adds sentry-cli calls to the "Bundle React Native code and images" phase and an "Upload Debug Symbols to Sentry" phase. Use the plugin option `["@sentry/react-native", { disableAutoUpload: true }]`. It writes `export SENTRY_DISABLE_AUTO_UPLOAD=true` into both phases. The build script also exports it. The log then shows `SENTRY_DISABLE_AUTO_UPLOAD=true, skipping sourcemaps upload`. The generated `ios/sentry.properties` holds `defaults.url=https://sentry.io/`, but it is never used while uploads are off.
- `pod install` downloads `Sentry.xcframework` 9.30.1 from the sentry-cocoa GitHub release (SHA-256 checked) into `~/Library/Caches/sentry-react-native/xcframeworks/`. sentry-cocoa ≥ 9.20 is no longer on CocoaPods trunk, so `SENTRY_USE_XCFRAMEWORK=0` fails on purpose.
- iOS 27 needs the UIScene plugin (`plugins/withUIScene.js`, copied from `examples/mobile`, see `kb/xcode-setup.md`).
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` and `LANG=en_US.UTF-8` (CocoaPods) are enough. No `sudo xcode-select` is needed.
- A Release `xcodebuild -configuration Release -sdk iphonesimulator -destination id=<udid> CODE_SIGNING_ALLOWED=NO` embeds `main.jsbundle`, so Metro is not needed. First build about 1.5 min on this Mac, then about 1 min.
- ATS: `ios.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads, NSAllowsLocalNetworking }` for the plain-http DSN and backend (demo only).
- `SENTRY_DSN`, `BACKEND_URL` and `SENTRY_DEBUG` go through `app.config.ts` `extra` (expo-constants). They are baked in at build time, so rebuild after a change.

## Driving the app without taps

- **`xcrun simctl openurl` is not unattended on iOS 27.** Every custom-scheme URL shows an "Open in sentry-demo?" system alert. Taps injected by the simulator tool did not dismiss it. The alerts queue up, and while one is shown the app is *inactive*. Sentry replay only starts on `didBecomeActive` (log: `[Session Replay] Application did become active, starting replay`), so a launch with a pending alert produced **no replay at all**.
- Fix: a file mailbox. The journey writes the deep-link path (`action/handled-error`, `screen/cart`) into `$(xcrun simctl get_app_container booted dev.ouo.sentrydemo data)/Documents/journey-command`, writing a temp file and then `mv` it into place. `src/mailbox.ts` polls the file every 400 ms with `expo-file-system` (`File.exists`, `textSync`, `delete`) and runs the same handler as `Linking`. No network calls, so nothing extra lands in the Sentry data. Deep links still work for manual use (`--openurl`).
- `simctl launch <bundle>` on a running app brings it to the foreground (same process). `simctl launch booted com.apple.Preferences` moves the app to the background.
- `simctl terminate` is SIGKILL: no `willTerminate`, so the session is reported as **`abnormal`** on the next launch.
- Foreground `sleep` in the agent shell is blocked. Scripts can sleep. To wait from the agent, use `python3 -c "import time; time.sleep(n)"`.

## Fetch spans need an active span

The RN fetch integration records an `http.client` span only while a span is active. Inside a React Navigation transaction (screen load) this works. A button press later on has no active span, so **no span and no transaction**. The demo wraps fetch actions in `Sentry.startSpan({ op: "ui.action", forceTransaction: true })`, much like user-interaction tracing. Real apps without that have failed requests that never reach Sentry as spans. The bridge cannot derive `http.request.failed` from data that is not sent.

## What the capture shows (full journey, 36 requests)

Item counts: `replay_video` 16, `transaction` 11, `session` 8 (2 init in the journey proper, `ok` updates, `exited` 1, `crashed` 1, `abnormal` 1 left over from an earlier killed run), `event` 4 (handled error, info message, unhandled rejection, native crash), `client_report` 2. The touch run added a JS fatal `event` and `crashed`/`abnormal` sessions.

Transport:
- Every request is `POST /api/1/envelope/`, `Content-Encoding: gzip`, `Content-Type: application/x-sentry-envelope`. All are sent by the native transport: `User-Agent: sentry.cocoa.react-native/9.30.1`.
- **Auth is only the header**: `X-Sentry-Auth: Sentry sentry_version=7,sentry_client=sentry.cocoa.react-native/9.30.1,sentry_key=<key>`. There is no `sentry_key` query and no `dsn` in any envelope header. The envelope `trace` header (DSC) carries `public_key`.
- There is no `Origin` header.

SDK names (the spec assumed `sentry.cocoa`):
- Envelope header `sdk.name` is `sentry.javascript.react-native` 8.30.0 for everything the JS layer captures: transactions, JS events and, notably, most `replay_video` segments. It is `sentry.cocoa.react-native` 9.30.1 for session envelopes, the native crash, and a replay segment flushed natively after the crash.
- Bare `sentry.cocoa` never appears. The bridge must map `sentry.cocoa.react-native` and use `contexts.os.name` or `replay_event.platform: "cocoa"` for the platform.

Sessions (`session` items):
- Updates after the first **omit `init`** (they do not send `init: false`). `duration` is present only on terminal updates. `seq` increments. `did` equals the event `user.id` (`904F26CD-...`, the installation id). Rule 3 of the spec holds.
- `exited` is sent when the app **returns to the foreground** after more than 30 s in the background. Its `timestamp` is the moment the app went to the background and `duration` runs up to then. The new session's `init` follows about 100 ms later. The sid changes and the replay id changes too: one replay per session.
- Native crash: on relaunch the **new session's `init` is sent first**, then one envelope `event` (level `fatal`, `EXC_BAD_ACCESS`, mechanism `mach`, `handled: false`, `sdk sentry.cocoa.react-native`, `contexts.replay.replay_id` of the crashed session) + `session` (`crashed`, `errors: 0`). Then the crashed session's last replay segment follows.
- JS fatal (throw in `setTimeout`, Release): one envelope `event` (level `fatal`, mechanism `onerror`, `handled: false`) + `session` `crashed`, sent **before** the process dies.
- Killed process (`simctl terminate`): on the next launch `status: abnormal` with `timestamp == started`, `duration: 0`, and no `abnormal_mechanism`. There is no real end time, so the bridge must not use `timestamp` as the end.
- Handled errors and the unhandled rejection arrive as `event` + `session` (`ok`, `errors` incremented). The info message does not touch the session.
- The unhandled promise rejection is `mechanism.type: onunhandledrejection` with **`handled: true`**, and the session stays `ok`, never `unhandled`.

Events and transactions:
- JS events carry `contexts.replay.replay_id`. **Transactions do not.** They carry the replay id only in the envelope `trace.replay_id`. `replay_video` envelopes have no `trace` header.
- **Stale replay id**: after the background session rotation, transactions of the *new* session still carried the *previous* session's `trace.replay_id` (n=27 and n=29 in the journey capture). The native crash event in the same session had the correct new one. Spec rule 2 (replay → sid) would therefore put those transactions into the ended session. The bridge should accept a replay match only when the item timestamp falls inside that session's window, and otherwise fall through to the device rule.
- Transactions: the first screen is `op: ui.load` named after the route (`Home`), with measurements `app_start_warm` (both launches in the capture were warm), `time_to_initial_display`, `stall_*`. Later screens are `op: navigation`, plus frames measurements. The demo's actions are `op: ui.action` without `contexts.trace.status`. HTTP spans: `op: http.client`, description `GET http://localhost:8082/api/products`, `data["http.response.status_code"]` = 500 and span status `internal_error` for the 500.
- `client_report` items appear (`discarded_events` reason `no_parent_span`). The bridge ignores them.
- `release` = `sentry-demo@1.0.0+1`, `dist` = `1`, `environment` = `development`, `contexts.device.model` = `iPhone19,2`, `contexts.os` = `iOS 27.0`.

`replay_video` (confirmed msgpack, iOS):
- Payload is a msgpack `fixmap(3)` with `str8` keys and `bin32` values (first byte `0x83`): `replay_event`, `replay_recording`, `replay_video`. **The key order varies between segments** (an NSDictionary, for example `replay_video, replay_event, replay_recording`). The spec's "in that order" is Android-only. Decode it as a map.
- `replay_event`: `type: "replay_video"`, `replay_id` (also the `event_id`), `segment_id`, `replay_type: "session"`, `platform: "cocoa"`, `timestamp` (segment end, float seconds), `replay_start_timestamp` **on every segment, equal to that segment's start** (not only the first), `trace_ids`, `urls` (screen names), `user`, `contexts`, `release`, `dist`, `environment`, `sdk` (`sentry.javascript.react-native`).
- `replay_recording`: `{"segment_id":n}\n` + JSON array, **not gzip**. Events: `type 4` (meta: width, height), `type 5` `tag: "video"` (payload `segmentId`, `size`, `duration` 5000 to 6000 ms, `frameCount` = seconds, `frameRate` 1, `width` 402, `height` 874, `encoding h264`, `container mp4`, `left`, `top`, plus `timestamp` in seconds), `type 5` `tag: "breadcrumb"` (console, navigation, http), `type 5` `tag: "options"` on segment 0.
- `replay_video`: mp4 (`ftypmp42`, ISO 14496-14), 5 to 16 KB per 5 s segment, at 1 fps.
- **Video size is in points** (402×874 on a 1206×2622 px iPhone 18 Pro, replay scale 1.0), and **touches are in the same point space**. Tapping (201, 417) pt recorded `x: 201, y: 417`, so no scaling is needed on iOS.
- Touches: `type 3`, `source 2`, `data.type` 7 (start) and 9 (end), `pointerType 2`, `pointerId` increasing per gesture, `id 0`. **Moves are `source 6` (TouchMove) with a `positions` array** (`x`, `y`, `id`, `timeOffset` ms, negative = before the event timestamp), not `source 2 type 8` as the spec assumed.
- A segment is sent about every 5 s while in the foreground. The last partial segment is sent when the app goes to the background (the 2 s segment 9).

## Tools

- `collector/tools/sentrytap -listen 127.0.0.1:4400 -dir <dir> -sink`: preferred recorder. It stores `<NNNNNN>/request.json` + `body.bin`.
- `examples/sentry-mobile/scripts/recorder.py`: stdlib fallback (`requests.jsonl` + `NNNN-<types>.bin`).
- `examples/sentry-mobile/scripts/analyze.py <dir> [--json f] [--dump-replay dir]`: reads both layouts. It reports transport and auth, item counts, sdk names, session updates, events, transactions, and replay segments (msgpack layout, recording events, mp4 header), and it can dump one segment.
