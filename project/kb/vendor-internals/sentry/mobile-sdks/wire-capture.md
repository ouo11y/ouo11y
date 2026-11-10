# Sentry mobile SDKs on the wire: what iOS and Android actually send (React Native)

- **Versions:** @sentry/react-native 8.34.0 with @sentry/core 10.78.0. It bundles sentry-cocoa 9.33.0 (iOS) and sentry-android 8.62.0 (Android). Self-hosted Sentry 26.10.0 (`sentry-sbx`).
- **Date:** captured 2026-11-10. Android ran from 03:52 to 03:56 UTC and from 07:18 to 07:26 UTC; iOS ran from 07:16 to 07:28 UTC.
- **Method:** observed. Release builds of `examples/sentry-mobile` (Expo 57, RN 0.86.3, Hermes, New Architecture) on an iOS 27.0 simulator (iPhone 18 Pro) and an Android 15 / API 35 emulator (Pixel 6 profile). `collector/tools/sentrytap` sat between app and Sentry, recording each request byte for byte and forwarding it:
  - iOS: `127.0.0.1:4530` → `http://localhost:9000`, project `step6-react-native` (5).
  - Android: `10.0.2.2:4531` → `http://localhost:9000`, project `step6-android` (7).
- **Build flags:** `SENTRY_CAPTURE_ALL=1` turns on `attachScreenshot`, `attachViewHierarchy`, `profilesSampleRate: 1` and `enableCaptureFailedRequests`. The demo's own defaults also apply: `tracesSampleRate: 1`, `enableLogs`, replay at 100 % and `propagateTraceparent`.
- **Decoding:** `scripts/extract.py` decoded every request into readable parts. Fixtures are in [fixtures/](fixtures/index.md); the replay numbers are in [replay-mobile.md](replay-mobile.md).
- **Not re-specified here:** the normative envelope and item format is in [wire-format/envelope.md](../wire-format/envelope.md) and [wire-format/replay-wire.md](../wire-format/replay-wire.md). This file records what the mobile SDKs put on it, and where iOS and Android differ.

## 1. Runs

| Run | Driver | Requests | Wire bytes | Replays |
|---|---|---|---|---|
| iOS full journey | `scripts/journey.sh --js-fatal`: nav, network, shop, errors, feedback, 40 s background, JS fatal, native crash | 80 | 2,732,428 | 4 |
| Android full journey | `scripts/android-journey.py`: the same phases with real taps | 80 | 1,615,851 | 3 |
| iOS replay, unmasked / default masking | `scripts/replay-journey.sh --seconds 120` | 91 / 90 | see [replay-mobile.md](replay-mobile.md) | 1 / 1 |
| Android replay, unmasked / default masking | `scripts/android-journey.py --phases replay` | 64 / 63 | see [replay-mobile.md](replay-mobile.md) | 1 / 1 |

Sentry answered every request `200` with body `{}`. There was no rate-limit header and no 413. Sentry stored every event and replay. The ids are in `step6-sentry-mobile-captures.md` in the Step 6 shared notes, outside the repo.

## 2. Transport (both platforms)

| | iOS | Android | Fixture |
|---|---|---|---|
| Request | `POST /api/<project>/envelope/`, no query | same | `*/01-session-init/request.json` |
| Sender | Always the **native** transport, also for JS-captured data: `User-Agent: sentry.cocoa.react-native/9.33.0` | `User-Agent: sentry.java.android.react-native/8.62.0` | |
| Auth | `X-Sentry-Auth: Sentry sentry_version=7,sentry_client=<ua>,sentry_key=<key>`. No `sentry_key` query, no `dsn` in the envelope header | same | |
| Compression | `Content-Encoding: gzip` on every request | same | |
| Other headers | `Accept: */*`, `Accept-Encoding: gzip, deflate`, `Accept-Language` | `Accept: application/json`, `Accept-Encoding: gzip` | |
| One envelope per request | yes | yes | |

## 3. SDK name per envelope (`sdk.name` in the envelope header)

| Data | iOS | Android |
|---|---|---|
| JS errors, transactions, logs, feedback, **replay segments** | `sentry.javascript.react-native` 8.34.0 | `sentry.javascript.react-native` 8.34.0 |
| Release-health sessions (standalone) | `sentry.cocoa.react-native` | `sentry.java.android.react-native` |
| Native crash event | `sentry.cocoa.react-native` (next launch) | `sentry.java.android.react-native` (sent at crash time) |
| Replay segment recovered after a native crash | `sentry.cocoa.react-native` | n/a: the last segment was flushed by the JS-named path |
| Hand-built legacy `user_report` | no `sdk` header | no `sdk` header |
| Replay envelope header extras | `sdk.packages: []`, `integrations: []`, `settings.infer_ip: never`; **no `trace` header** | `sdk.packages` (maven `sentry`, `sentry-android-core`, `-replay`, `-ndk` 8.62.0, npm `@sentry/react-native`), the 18 native integration names, **and a `trace` (DSC) header with `sample_rand` and `replay_id`** |

Totals for the full journeys: iOS had 72 JS-named, 7 cocoa-named and 1 unnamed envelope. Android had 62 JS-named, 17 java-named and 1 unnamed.

## 4. Release-health sessions: the largest iOS and Android difference

| | iOS | Android | Fixture |
|---|---|---|---|
| `sid` format | Upper-case UUID with dashes | 32 lower-case hex, no dashes | `*/01-session-init` |
| `seq` | 1, 2, ... | absent on `init`, then the **Unix time in ms** (`1794282749447`) | |
| `did` | UUID (installation id) | 32 hex | |
| Handled JS error | `session` update in the same envelope as the event (`status: ok`, `errors` +1). **Same session continues** | **The session ends** (`exited`, `errors: 1`) and **a new session starts** (`init`). The event's envelope then carries the old sid with `status: ok, errors: 1`. Seen for the handled error, `captureMessage`, the unhandled rejection and the feedback error: **5 health sessions in 3 minutes of foreground**, while iOS had 1 | android `07-…`, `08-…`, `09-…` |
| App start | One `init` | `init` sent **twice** with the same sid, then `exited` 1.2 s after start with the same sid, which then stays in use. Cause not confirmed | android `01-…`, `02-…` |
| Background > 30 s | `exited` sent on return to the foreground, `timestamp` = the moment it went to the background (87.5 s), new `init` | Same, plus the `exited` update sent twice | ios `09-…` |
| JS fatal | event `level: fatal`, mechanism `onerror`, `handled: false` + session `crashed`, **sent before the process died** (07:19:15.78, right after the throw) | event + `crashed` **stored, sent at the next launch** after the new session's `init` | ios `10-…`, android `12-…` |
| Native crash | Next launch: new `init` first, then one envelope `event` (`EXC_BAD_ACCESS`, mechanism `mach`, level fatal) + screenshot + view hierarchy + `crashed` session; then the crashed replay's last segment | `Sentry.nativeCrash()` on Android throws a JVM `RuntimeException`. The event (mechanism `expoReactHost`) + `crashed` session + screenshot + view hierarchy + `client_report` was **sent from the dying process** 1 s after the tap, then one more replay segment. The relaunch 5 s later sent nothing in 15 s (cause not confirmed) | ios `11-…`, `12-…`; android `13-…`, `14-…` |

The Android rotation matches the source. `InternalSentrySdk.captureEnvelope(bytes, maybeStartNewSession = !hardCrashed)` calls `scopes.startSession()` after **any** session update. Its Javadoc says "after a crashed session is cleared". See [InternalSentrySdk.java#L186-L200](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-core/src/main/java/io/sentry/android/core/InternalSentrySdk.java#L186-L200), called from [RNSentryModuleImpl.java#L647-L654](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L647-L654).

The iOS JS fatal being sent at once differs from the RN source reading, where `hardCrashed` means native `store`. See [react-native/reliability.md](react-native/reliability.md) section 2. The 8.30 capture in the archive saw the same: `project/kb-archive/sentry-react-native-demo.md`.

## 5. Errors, attachments, feedback

| Item | iOS | Android | Fixture |
|---|---|---|---|
| JS error `event` | `contexts.replay.replay_id` set. The envelope `trace` DSC carries `trace_id`, `release`, `environment`, `public_key`, `replay_id` | same | `*/…error-js-handled…/item-0-event.json` |
| Screenshot `attachment` | `content_type: image/png`, `filename: screenshot.png`, 108 KB (1206x2622) | 31 KB, 1080x2400. The native crash's screenshot also has `attachment_type: event.attachment` | `…attachment.screenshot.png` |
| Screenshot masking | masked by default | **fully masked by default, although replay masking was off** (independent `screenshot` options) | android `09-…` |
| View hierarchy `attachment` | `attachment_type: event.view_hierarchy`, `application/json`, `{rendering_system, windows}`, 73 KB | same shape, 10 KB | `…item-1-attachment.json` |
| `feedback` item | Event of type `feedback` with `contexts.feedback {contact_email, name, message}`, 21 KB | same, 28 KB | `*/…feedback/` |
| Legacy `user_report` item | `{event_id, name, email, comments}`, envelope without `sdk` | same | `*/…user-report-legacy/` |
| Failed-request events (`enableCaptureFailedRequests: true`) | **none observed**. `fetch-500` gave only an `http.client` span with `http.response.status_code` 500 | none observed | — |

## 6. Transactions, profiles, logs, client reports

| Item | iOS | Android |
|---|---|---|
| First screen | `op: ui.load`, `Home`, measurements `app_start_cold` (first launch) / `app_start_warm`, `time_to_initial_display`, `stall_*` | `ui.load`, `app_start_cold` (2 launches), `frames_*` |
| Navigation | `op: navigation`, TTID, `stall_*`, `frames_*` on some | same |
| Actions | `op: ui.action`, `http.client` child spans | same |
| `profile` (one per transaction, `profilesSampleRate: 1`) | `platform: javascript`, `version: 1`, Hermes sample format (`samples`, `stacks`, `frames`, `thread_metadata`), **about 470 KB uncompressed and 50 to 70 KB gzip each**: 1.23 MB of the 2.73 MB iOS wire total | `platform: android`, legacy Android profile with `sampled_profile` and a nested `js_profile`, 30 to 134 KB each |
| `profile_chunk` | not sent (UI profiling not enabled) | not sent |
| `log` | header `{type: log, item_count, content_type: application/vnd.sentry.items.log+json}`, payload `{version: 2, items}` | same |
| `client_report` reasons seen | `no_parent_span` (span), `event_processor` (profile), **`before_send` (error) right after the JS fatal**, which is the native duplicate-suppression `beforeSend` dropping the native copy of the JS fatal | `no_parent_span`, `event_processor` (transaction, and error at the JVM crash). Native client reports use an **ISO timestamp string**, JS ones a float |

## 7. Byte level: one replay segment

Envelope as sent by iOS (decompressed, first bytes of `caps/ios-full/000004/body.bin`):

```text
{"event_id":"1f83973a…","sdk":{"version":"8.34.0","name":"sentry.javascript.react-native",…},"sent_at":"2026-11-10T07:16:57.425Z"}\n
{"length":34614,"type":"replay_video"}\n
83                      msgpack fixmap(3)
d9 0c "replay_event"    str8 key
c6 00 00 06 a2 {…}      bin32 value: JSON replay_event (1698 bytes)
d9 10 "replay_recording" c6 … {"segment_id":0}\n[…rrweb events…]
d9 0c "replay_video"    c6 … 00 00 00 1c 66 74 79 70 6d 70 34 32 …   (mp4: ftyp mp42)
```

- **Key order:** fixed on Android: `replay_event, replay_recording, replay_video` in all 28 segments. On iOS it varies: all 6 orders were seen across 26 segments (an NSDictionary). Decode it as a map.
- The item header has only `length` and `type` on iOS. Android adds `content_type` to most items, but not to `replay_video`.
- `replay_recording` is `{"segment_id":n}\n` + a JSON array. It is not gzipped inside the msgpack; the whole request is gzipped.

## 8. What this means for the topologies (facts only)

- **Topology (b), a collector in front of Sentry:** every mobile request is a gzip-compressed envelope with header auth and no query auth. The same item types appear on both platforms. The receiver must accept per-platform differences in session `seq`, `sid` format, client-report timestamp type and msgpack key order.
- **Session-based joins:** on Android under React Native, a health session is **not** a user visit. It rotates on every captured JS error, while the replay id stays the same. Grouping by replay id spans several health sessions.
- **Event-to-replay links:** come from `contexts.replay.replay_id` on events and `trace.replay_id` on the DSC. Replay envelopes carry a DSC on Android only.
- **Fatal timing differs:** a crash can arrive in the same second (Android JVM, iOS JS fatal) or at the next launch (iOS native, Android JS fatal). A consumer must accept late events with old timestamps.
