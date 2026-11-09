# Sentry bridge parity fixes: what the payloads really look like (2026-10-23)

Question: what had to be true of real `@sentry/react-native` 8.30 / sentry-cocoa 9.30.1 payloads to close the bridge gaps A1 to A11, C5 and the N2 findings (`project/tracker/checklist.md` section 2), and what is easy to get wrong when changing the `ouosentry` receiver again?

Source: the four golden captures in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/` plus `selfhosted` (the N2 run against self-hosted Sentry 26.10, added in this change). Spec: `docs/specs/sentry-bridge.md` sections 5 to 9b.

## Payload facts

- **captureMessage is an exception with `synthetic: true`.** RN attaches a stack trace to messages, so the event has `level: info` and one `exception.values[0]` with no `type`, the message as `value` and `mechanism.synthetic: true`. Sentry's session `errors` does not count it. The native crash (`EXC_BAD_ACCESS`) is synthetic too but `level: fatal`, so the level decides first.
- **Error-event breadcrumbs are a plain array** (not `{values: [...]}`) on both the JS and the native event. JS timestamps are float seconds; sentry-cocoa's crash report repeats the JS breadcrumbs with ISO timestamps **up to about 60 ms later** and `origin: react-native`. Every later error repeats the whole list (last 100), and the list reaches back across a background rotation into the previous session.
- **Replay recordings rarely carry React Navigation breadcrumbs.** Across all captures: 1 of about 8 navigations was in a recording; every error event had all of them. The one `navigation` breadcrumb sentry-cocoa itself puts into a recording reads `{to: "RNSScreen"}` with message `RNSScreen` (a UIKit view controller of react-native-screens), not a screen of the app.
- **The back navigation Cart → Home has no transaction** (RN drops a navigation transaction without spans) but has its breadcrumb `{from: Cart, to: Home}`. A React Navigation transaction starts 10 to 20 ms before its breadcrumb; the app-start `ui.load` transaction starts 1.5 to 3 s before the first `{to: Home}` breadcrumb.
- **Fetch breadcrumbs carry `data.__span`**, the id of their `http.client` span, on events and in recordings. That is the exact key to keep a request once when both sources are used.
- **Startup console lines have nothing to resolve them by.** `[sentry-demo] rum mode ...`, `Running "main"` and the ouo SDK's own `[ouo] ...` lines come in a log item with no `sentry.replay_id`, no `user.id`, no `device.*` / `os.*`, and a `trace_id` no transaction or error ever uses. They are timed from 60 ms before to 0.7 s after the session's `started`. Only the client's network origin and the time link them to the session.
- **Log entries carry release and device context as attributes**: `sentry.release`, `sentry.environment`, `sentry.sdk.name`, `sentry.sdk.version`, `os.name`, `os.version`, `device.model`, `device.family` (not on the startup entries). A log item never travels with an event, so these are the only source for its resource.
- **Session-only and replay envelopes have no OS or device context at all.** The device context has to come from the session's (or the device's earlier sessions') events.
- **sentry-cocoa crash reports have no `connection_type`** in `contexts.device`; the JS events do (`wifi`). `contexts.app.view_names` is `["Home"]`: the current screen.
- **Native frames**: `package` (full image path), `instruction_addr`, `image_addr`, `in_app`. One frame per crash has `image_addr` `0x0000000000000000` (unknown image). `debug_meta.images` lists 15 to 16 macho images with `debug_id` (the UUID dSYMs are found by) and `image_addr`; JS events list one `sourcemap` image whose `code_file` is `app:///main.jsbundle`.

## Things easy to get wrong

- **Do not de-duplicate breadcrumbs within one event.** Two identical taps on one button within a second are two taps. Copies are only those from another event (or the native copy) within 1 s.
- **Pair navigations 1:1 and remember the paired breadcrumb.** The first version marked the transaction as paired but did not record the breadcrumb, so the copy on the next error emitted the navigation again.
- **Skip `navigation.dispatch`, `ui.lifecycle` and `started` from event breadcrumbs**: the first duplicates `navigation`, the second is native view controller noise (RNSScreen, RNSNavigationController), the third is the SDK's start note. Recordings do not carry them, so sessions with and without a replay look the same.
- **Do not attach a startup log by time alone.** At scale many devices start sessions every second; the rule needs the same origin and refuses when two sessions of one origin qualify.
- **The trace header's replay id can be stale** (another session's, after a background rotation). "Has a replay" for a transaction is: the session has a replay id, or the header's replay id is unknown or this session's.
- **`verify-bridge.py` still counts every event with `exception.values` as an error**, so after A1 it expects one exception record more than the bridge emits (and more than Sentry counts) per `captureMessage`.

## Verification

- Unit tests per item in `parity_test.go`; golden tests `TestGoldenSelfHosted` (N2 capture) and `TestGoldenJourneyWithoutReplay` (journey capture with every replay item and replay id removed).
- Live run against self-hosted Sentry 26.10 (2026-10-23): 83/83 envelopes byte-identical; errors 3 + 1 info message, sessions 4 (abnormal, errored, crashed, healthy) and logs 23 + 23 console equal to Sentry's own counts; 47/47 log and console records with a session. Details: `project/agents/collector/summaries/2026-10-23-bridge-parity.md`.
