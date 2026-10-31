# Mobile SDK specification: twelve capabilities, conformance checks, maturity

Status: normative from 2026-10-29 ([ADR-0015](../adr/0015-mobile-sdk-spec-and-conformance.md)). It applies to every ouo mobile SDK: `@ouo11y/react-native` today, the native iOS (Swift, Objective-C) and Android (Kotlin, Java) packages and Flutter later. Records marked *draft* were fixed by the work package that landed them, in the same PR as the code (the last, C3, with W4 on 2026-10-30); everything changes only with an ADR now.

This spec is the index. Where a record already has a spec, it is linked, not repeated:

| Topic | Spec |
|---|---|
| sessions, identifiers, end reasons, `exception`, `navigation`, `http.request.failed` | [session-lifecycle.md](session-lifecycle.md) |
| app start, TTID, TTFD, frames, stalls | [mobile-vitals.md](mobile-vitals.md) |
| replay chunks, capture and masking rules | [mobile-replay.md](mobile-replay.md) |
| funnels over screens and events | [funnels.md](funnels.md) |
| what the Sentry bridge produces for the same capabilities | [sentry-bridge.md](sentry-bridge.md) |

## 1. Rules for every record

1. Telemetry is OpenTelemetry over OTLP/HTTP: spans on the traces signal, everything else as log records with `event.name` (an *event*). No other format. Names follow the OTel semantic conventions where one exists, otherwise they start with `ouo.`.
2. Every span and event carries the session identifiers of [session-lifecycle.md](session-lifecycle.md) (`session.id`, `user.id`, and `session.previous_id` where session-lifecycle.md sets it) as attributes, and `ouo.platform = mobile`.
3. Resource attributes, set once per process: `service.name`, `service.version`, `deployment.environment.name`, `os.name`, `os.version`, `device.model.identifier`, `device.manufacturer`, `ouo.sdk.name`, `ouo.sdk.version`; `device.model.name`, `device.id` and `ouo.device.simulator` when known. The collector stamps `ouo.project.id` (ADR-0007).
4. Severity: `INFO` (9) unless the record's spec says otherwise (`exception` and `http.request.failed` are `ERROR`, `log` takes the level the app passed).
5. A record is emitted only for what was observed or measured: no zeros for unknown values ([mobile-vitals.md](mobile-vitals.md) section 3 for the vitals).
6. The SDK never reads text a user typed or sees: labels come from accessibility labels, test ids and component names, never from text content (C6, C8).

## 2. Capabilities

### C1 Sessions and lifecycle

- **Records**: `session.start`, `session.end` ([session-lifecycle.md](session-lifecycle.md), mobile start rules and end reasons); `app.lifecycle` with `ouo.app.state` = `foreground`, `inactive`, `background` on every change (the values the bridge maps from sentry-cocoa).
- **Thresholds**: `BACKGROUND_TIMEOUT` 30 s, `INACTIVITY_TIMEOUT` 30 min, `MAX_DURATION` 4 h (configurable).
- **Sampling**: decided once per session from `session.id`; an unsampled session emits nothing, a sampled one everything its options enable.
- **Check**: C1.1.

### C2 Errors and crashes

- **Records**: `exception` ([session-lifecycle.md](session-lifecycle.md)) with `ouo.exception.kind`: `uncaught`, `unhandledrejection`, `captured`, `console`, `sentry` (JS), `native` (a signal or an uncaught NSException / Java exception), plus `hang` and `termination` (C3).
- **JS stacks** are normalised to `app:///<bundle>:<line>:<column>` frames, one per line, as the bridge writes them, so symbolication ([ADR-0011](../adr/0011-source-maps-and-symbolication.md)) reads both paths.
- **Native crashes** are written to disk at crash time (iOS report format: [ios-native-crashes.md](../../project/kb/ios-native-crashes.md)) and sent by the next launch: a fatal `exception` stamped at the crash time with `ouo.crash.mechanism`, `ouo.crash.timestamp`, `ouo.crash.frames`, `ouo.crash.images` (what symbolication needs), `ouo.crash.signal`, `ouo.crash.mach_exception`, `ouo.crash.address`, `ouo.crash.arch`, `ouo.crash.thread_main` when known; then `session.end` with reason `crash` at the same time. The session is `crashed` (ADR-0004).
- **A crash in the first second** must not lose the session: the start of the crashed session reaches rum-api even when nothing was exported before the crash (checklist N52).
- **Error context**: every `exception` (C2 and C3) carries, besides its stack, what a developer reads it with: `ouo.last_events` (the session's last 20 timeline records before it, oldest first, as a JSON array of `{ts, name, body}`: the buffer of C10), `app.screen.name` (the screen it happened on), `ouo.device.locale` (BCP 47), and when the platform measures them at the time of the error, `ouo.memory.app_bytes` (the app's physical footprint), `ouo.memory.available_bytes` (what it can still allocate before the OS terminates it) and `network.connection.type` (`wifi`, `cell`, `wired`, `unavailable`, `unknown`). A report sent by the next launch (a native crash, a termination) carries the screen and last events the crashed run persisted (at once after each tap, navigation and exception, else at most 5 s old) and no memory or network values: they were not measured at the crash (rule 5).
- **Checks**: C2.1, C2.2, C2.3.

### C3 Hangs and terminations

- **Hang**: the main thread could not draw for at least **2 s** (Sentry's default `appHangTimeoutInterval`), measured from the display's frames with sentry-cocoa's rules (SentryANRTrackerV2): a watchdog thread looks every 400 ms at the frame delay of the last 2 s (the time frames ran over the slow-frame threshold, plus the frame still awaited). **Fully blocking**: that delay is at least 2 s and no frame was drawn in it. **Not fully blocking**: frames were drawn, but more than 99 % of the 2 s was frame delay (blocks of a second or more with a frame between). The hang is over when the last 800 ms had less than 160 ms of delay. Then one `exception`, not fatal and not handled, with `ouo.exception.kind = hang`, `exception.type = AppHang`, `exception.message = App hanging for <s> s`, stamped at the hang's start, with `ouo.hang.duration_ms` (the whole blocked time: from the last frame on time to the end of the last late frame), `ouo.hang.fully_blocking` (bool: true when the main thread drew no frame for 2 s or more within the hang, even if jank led into it; false when it kept drawing, every frame late), and the main thread's stack read at detection in `exception.stacktrace`, `ouo.crash.frames` and `ouo.crash.images` (symbolicated like a crash, [ADR-0011](../adr/0011-source-maps-and-symbolication.md)). One record per hang, however long, and none for 2 s after one ended; every detected hang is reported (a gap in which the watchdog did not run ends it at the last tick that saw it). Measuring restarts when the app becomes active, so a block before the first frame counts. No hang is measured while the app is not active (the watchdog waits without waking), while a debugger is attached, or across such a gap. The session is `errored`. JS event-loop stalls stay `ouo.stall` ([mobile-vitals.md](mobile-vitals.md) 2.4).
- **Termination**: the previous run ended while the app was active, without a crash report (Sentry's watchdog-termination heuristic). The run keeps a small state file current (active or not, its session, a heartbeat every 5 s while active, a memory warning, a hang in progress); the next launch compares it with its own. It is **not** a termination when that run was not active (background, inactive: a user swipe or a kill there), received `willTerminate` or called `exit()` (an `atexit` handler), ran under a debugger, or when the app version and build (with the executable's build UUID, so a development reinstall counts), the OS version and build or the boot time changed since (an update, an OS update, a reboot), or when a crash report exists (the crash wins). Otherwise the next launch sends a fatal `exception` with `ouo.exception.kind = termination`, `exception.type = WatchdogTermination`, `ouo.termination.cause`, stamped at the last time the run was known alive, then `session.end` with reason `crash` at that time; the session is `crashed`. `ouo.termination.cause`: on iOS `memory` when the run had a memory warning in its last 60 s (jetsam follows warnings), `watchdog` when an app hang was in progress (the main thread was blocked when it died; the record then carries that hang's stack, read at its detection, in `exception.stacktrace`, `ouo.crash.frames` and `ouo.crash.images`), else `unknown`; on Android `ApplicationExitInfo` gives `memory`, `cpu`, `launch_timeout` or `watchdog`. MetricKit is not a source: its exit counts are daily aggregates and its diagnostics arrive on a later launch without naming the run ([ios-hangs-terminations.md](../../project/kb/ios-hangs-terminations.md)). The runs the heuristic excludes end with `session.end` reason `terminated`, as before.
- **Checks**: C3.1, C3.2.

### C4 Vitals

- **Records**: `ouo.app.start`, `ouo.screen.display` (TTID, and TTFD when the app reports full display), `app.jank`, `ouo.stall`, with the attributes, rules and rating thresholds of [mobile-vitals.md](mobile-vitals.md).
- **TTFD API**: `rum.reportFullyDisplayed()` (Sentry's name): the current screen's content is on screen. `ouo.screen.ttfd_ms` is measured from the screen's TTID start to the next frame drawn after the call, and never below TTID. The screen's one `ouo.screen.display` waits for it until the screen is left, the app goes to the background or 30 s passed (Sentry's TTFD deadline); without a call it carries TTID only.
- **Checks**: C4.1, C4.2. The thresholds rate a real app on a device; the conformance checks only require the records and plausible values.

### C5 Network

- **Spans**: one CLIENT span per request (`fetch`, `XMLHttpRequest`, `URLSession`, OkHttp), named `HTTP <method>`, with `http.request.method`, `url.full`, `server.address`, `server.port`, `url.scheme`, `http.response.status_code` and the session identifiers. Status error for 5xx and network failures.
- **Propagation**: W3C `traceparent` and `baggage` carrying `session.id`, only to origins the app lists (`tracing.propagateTo`), so a backend span joins the trace and can carry the session.
- **Events**: `http.request.failed` for 5xx and network errors ([session-lifecycle.md](session-lifecycle.md)); `http.request` for answered requests below 500 when timeline requests are on, with the span's trace and span id.
- **Check**: C5.1.

### C6 Interactions

- **Record**: `ui.tap`, one per touch, stamped at the touch start and emitted when the finger lifts (the name the bridge already produces from Sentry's `ui.tap`, `ui.click` and `touch` breadcrumbs, which carry the target only):
  - `ouo.ui.target`: the first label up the view tree (`ouo-label`, `accessibilityLabel`, test id), else the component or view class name;
  - `ouo.ui.path`: the labelled or named ancestors, innermost first, joined by ` > `;
  - `ouo.ui.view_type`: what was touched, never its label: the control's accessibility role (`button`, `link`), else the component that carries the label (`Pressable`, `UIButton`), else the innermost component or view class;
  - `ouo.ui.gesture`: `swipe` when the touch moved 10 points or more, else `long_press` when it was held 500 ms or more, else `tap`;
  - `app.screen.name`: the screen the touch started on (the last segment of the current C7 `url.path`), absent before the first screen.
- **Native iOS** (W8): `ouo.ui.target` is the test id (`accessibilityIdentifier`) up the view tree, else the name the app passes to `trackTap`, else the view type; `ouo.ui.view_type` is the class of the view with the id, else of the touched control, else of the touched view (`UIButton`, `UIScrollView`). Accessibility labels and traits are not read: with an assistive technology on (VoiceOver, Voice Control) UIKit fills a button's label with its visible title, and the trait appears only then, so a step would differ by user (rule 6).
- **Body**: the user step as a person reads it: `Tap add-to-cart (button) on Products`, `Swipe cart-items (FlatList) on Cart`.
- **Kill switches**: `timeline.taps: false` stops the records. `timeline.tapLabels: false` keeps the taps `RUMProvider` records without any label: `ouo.ui.target` is the view type and there is no `ouo.ui.path`; gesture, view type and screen stay. Targets the app passes to `trackTap` are its own and are kept. Text content is never read (rule 6).
- **Check**: C6.1.

### C7 Screens and navigation

- **Record**: `navigation` with `url.path` = `/` + the active screen names joined by `/` (React Navigation route names, view controller or activity names), `ouo.navigation.from`, and `ouo.navigation.kind = screen`, as the bridge sends it. A screen change emits one record; the same screen again emits none.
- Funnels count screens as page steps on `url.path` ([funnels.md](funnels.md)); custom events (`rum.addEvent`, `ouo.event.custom = true`) are event steps.
- **Check**: C7.1.

### C8 Replay

- **Chunks**: `kind: "frames"` keyed by `session.id`, posted to the collector's replay receiver ([mobile-replay.md](mobile-replay.md)); the `seq` of a session starts at 0 and the native side starts a new sequence on every rotation.
- **Masking defaults**: text, inputs, images and web views are masked unless the app turns one off; masking fails closed (a frame whose masks cannot be computed is dropped, W1).
- **Modes and chunk schema 2**: [ADR-0014](../adr/0014-replay-tiles-in-frames.md). `session` is what ships today; `buffer` and `navigation` come with W1 and W3.
- **Crash**: the chunk being recorded when the app crashes is finished by the next launch, with `ended_at` at the crash time (W1).
- **Checks**: C8.1, C8.2, C8.3. That no masked text is readable in a frame is a pixel test of the capture package (`sdk/ios` tests), not an e2e check.

### C9 Span and log API

- `startSpan(name, options)` (attributes, kind, start time, parent), `withSpan(name, fn)` (the span is active while `fn` runs; requests, logs and errors there join its trace), `log(level, message, attributes)` and `log.trace` … `log.fatal`: a log record named `log` with the severity, the message as body and `message`, the session identifiers and the active span's trace id. Spans and logs get the session identifiers like every other record.
- **Check**: C9.1.

### C10 Feedback

- **Record**: `feedback` event, severity `INFO`:
  - body and `ouo.feedback.message`: the user's text as the app passes it, trimmed; longer than 4096 bytes of UTF-8, it keeps the longest prefix of whole characters that fits, followed by `…` (the bridge cuts the same way); an empty message sends nothing;
  - `ouo.feedback.contact`: how to reach the user (an email, a name) as the user typed it, when not empty, same cut;
  - `ouo.feedback.id`: a UUID, also what the API returns;
  - `ouo.feedback.screenshot = true` when the app asked for a screenshot and replay was recording: the recorder was asked for a frame of the current screen, masked like every frame (C8). `navigation` mode takes it once the screen settled (the request a new screen makes); in `session` mode the interval frames already show the screen. No separate image is sent: the session's replay at the record's time shows the screen;
  - `ouo.last_events`: JSON array, sorted by `ts` oldest first (vitals are stamped earlier than they are emitted), of the session's last 20 records before it (events and log lines), each `{"ts": <epoch ms>, "name": <event.name, "log" for a log line>, "body": <the step>}`. The step is the path of a `navigation`, `exception.type: exception.message` of an `exception`, `METHOD url.full status` of a request, else the record's body when it is more than its name (the readable `ui.tap` step, a log line), else empty; cut at 200 bytes the same way. The SDK keeps them as records are emitted (the `RecentEvents` log processor of `@ouo11y/react-native`); W4 adds the same attribute to `exception` from the same buffer.
- With `replay.keepAtNextLaunch`, the held session's summary counts its feedback (`feedback`), so an app can keep the replays users reported on (`s.crashed || s.errors > 0 || s.feedback > 0`).
- The record follows session sampling like every other (C1). Its text is what the app hands over; rule 6 is about what the SDK reads on its own.
- **API**: `rum.feedback({ message, contact?, screenshot? })` returns the id, or nothing for an empty message. The form is the app's; a widget is later work.
- **Bridge**: Sentry's `feedback` and `user_report` items become the same record ([sentry-bridge.md](sentry-bridge.md) section 9c), without `ouo.last_events` (the feedback's breadcrumbs are on the session's timeline) and without `ouo.feedback.screenshot`.
- **Plugin**: the session page lists the feedback beside the replay: message, contact, the steps before it (`ouo.last_events`, else the last 20 timeline events up to it), a marker on the replay bar and a seek to the replay at that time, which shows the frame on screen then.
- **Check**: C10.1.

### C11 Delivery

- OTLP/HTTP JSON with `content-encoding: gzip` for logs and traces; replay chunks are gzip already.
- Retry with backoff on network errors, 408, 429 and 5xx, honouring `Retry-After`; no retry on other 4xx.
- **Offline store**: every OTLP batch and replay chunk is on disk before it is sent and removed when the collector answers 2xx or another 4xx, so an outage, a crash or a kill mid-request loses nothing; what is left is sent oldest first on the next launch, on foreground, on `flush()` and after a backoff. Bounds, oldest dropped first: OTLP 5 MB (uncompressed JSON), 500 requests, 24 h; replay chunks 10 MB (gzip) per folder (queued, held), 24 h ([mobile-replay.md](mobile-replay.md)). Delivery is at least once. (Sentry keeps 30 envelopes.)
- Flush on background (and on `flush()`).
- **Checks**: C11.1, C11.2.

### C12 Cost

- The B3 benchmark ([benchmarks.md](../benchmarks.md)): per tier, the paired median delta against `none` on the same journey and machine, with the release gate of section 5 there. Not an e2e check; it decides L3 (section 4).

## 3. Conformance checks

Each check runs on the golden app of the platform's suite (section 5) and asserts rum-api, except C8.2 and C11.2, which read the requests and native calls the suite observed.

| Check | The golden app does | Passes when |
|---|---|---|
| C1.1 | goes to the background for longer than the timeout and comes back | the first session ends with `background`, the second's `session.start` has `session.previous_id` = the first |
| C2.1 | reports a handled error on Cart | an `exception` with `ouo.exception.handled = true`, `ouo.exception.fatal = false`, a stack, `app.screen.name = Cart` and `ouo.last_events` (1 to 20); session `errored` |
| C2.2 | crashes natively 3 s after launch on Home; launches again | the crashed session is `crashed`, ends with `crash` within 1 s of the crash time, has its `session.start` and a fatal `native` exception with `app.screen.name = Home` and `ouo.last_events` |
| C2.3 | crashes natively 200 ms after launch; launches again | the crashed session starts when it started (not at the crash), is `crashed` and ends at the crash with reason `crash` |
| C3.1 | blocks the main thread for 3 s on Cart | exactly one `hang` exception with `ouo.hang.duration_ms` >= 2000, not fatal, with its error context (screen Cart) |
| C3.2 | gets a memory warning and is killed in the foreground without a crash report; launches again | a fatal `termination` exception with `ouo.termination.cause`; session `crashed`, ended with `crash` |
| C4.1 | cold start, then three screens | `ouo.app.start` `cold` with a duration, one `ouo.screen.display` with TTID per screen in order, frame counts |
| C4.2 | reports the first screen fully displayed | its `ouo.screen.display` has `ouo.screen.ttfd_ms` |
| C5.1 | calls the demo backend | one trace holds the app's client span and a backend span carrying the app's `session.id` |
| C6.1 | taps, long-presses and swipes labelled controls on three screens | three `ui.tap` in order with `ouo.ui.target`, `ouo.ui.view_type`, `ouo.ui.gesture` (`tap`, `long_press`, `swipe`) and `app.screen.name` |
| C7.1 | visits Home, Products, Cart | one `navigation` per screen with `ouo.navigation.kind = screen`; a funnel `page:/Home`, `page:/Products`, `page:/Cart` counts the session at step 3 |
| C8.1 | records replay across a background rotation | both sessions have a `frames` replay |
| C8.2 | starts replay with default options | text, inputs, images and web views masked |
| C8.3 | crashes while recording; launches again | the crashed session's replay ends within 1.5 s of the crash |
| C9.1 | calls the backend inside `withSpan`, writes a log line | a trace rooted at the custom span with the request under it; the line in the session's logs |
| C10.1 | taps on Cart, then sends feedback with a message, a contact and a screenshot while replay records | a `feedback` event on the session with the message, the contact, an id, `ouo.feedback.screenshot = true` and `ouo.last_events` ending with the journey's last steps; the replay covers its time (a frame at or before it and one after) |
| C11.1 | runs with the collector refused; launches again online | the offline run's events are in rum-api |
| C11.2 | sends OTLP | every OTLP request has `content-encoding: gzip` |

## 4. Maturity

| Level | Meaning |
|---|---|
| L0 | not available: no record of the capability |
| L1 | basic: records in this spec's names, but a check fails or has no harness on the platform yet (gaps listed) |
| L2 | conformant: every check of the capability passes in CI on the platform's golden app |
| L3 | benchmarked: L2, and a B3 cell for the platform with the release gate applied |

The suite prints the levels it measures (L0 to L2); L3 is L2 plus the B3 gate, which is proposed and not yet applied ([benchmarks.md](../benchmarks.md) section 5), so no cell is L3 today. Target: React Native iOS at L3 on C1–C9, C11, C12 and L2 on C10 (roadmap milestone M3); the targets for the other platforms are in [roadmap §5](../../project/kb/mobile-sdk-research/roadmap.md#5-spec-first-with-maturity-per-platform).

### Matrix on 2026-10-30

React Native iOS is measured by the suite (CI, job `examples`). The other columns have no suite yet; their cells are what the code does, by reading it (native iOS: its suite, `tests/e2e/mobile-native`, passes every check on a simulator but runs by hand, not in CI yet (checklist N78): "L2 (native suite)" means that).

| Capability | React Native iOS | Native iOS (Swift) | React Native Android | Native Android | Flutter |
|---|---|---|---|---|---|
| C1 Sessions and lifecycle | L2 | L2 (native suite) | L1 (JS) | L0 | L0 |
| C2 Errors and crashes | L2 | L2 (native suite) | L1 (JS errors only) | L0 | L0 |
| C3 Hangs and terminations | L2 | L2 (native suite) | L0 | L0 | L0 |
| C4 Vitals | L2 | L2 (native suite) | L1 (stalls, TTID, TTFD; no native app start or frames) | L0 | L0 |
| C5 Network | L2 | L2 (native suite) | L1 (JS) | L0 | L0 |
| C6 Interactions | L2 | L2 (native suite; test ids only, SwiftUI controls by `trackTap`) | L1 (JS) | L0 | L0 |
| C7 Screens and navigation | L2 | L2 (native suite) | L1 (JS) | L0 | L0 |
| C8 Replay | L2 | L2 (native suite) | L0 | L0 | L0 |
| C9 Span and log API | L2 | L2 (native suite) | L1 (JS) | L0 | L0 |
| C10 Feedback | L2 | L2 (native suite) | L1 (JS; no screenshot without the native module) | L0 | L0 |
| C11 Delivery | L2 | L2 (native suite) | L1 (JS outbox, uncompressed: the native module is a stub) | L0 | L0 |
| C12 Cost | L1 (B3 simulator cells, gate proposed) | L1 (B3 simulator cells, gate not applied) | L0 | L0 | L0 |

React Native Android's L1 cells are the JavaScript half, which is the same code as on iOS; it has never run on an Android device or emulator (the Android native module is a stub). The package that changes a cell updates this table in the same PR.

## 5. The conformance suite

- **One suite per package**: `@ouo11y/react-native` (iOS, then Android), the native iOS package and the native Android package each get one suite with the same check ids. Objective-C and Java are API surfaces of the native packages, not separate implementations: each native package adds a smoke target in that language that compiles against its public API, and the suite runs once.
- **React Native iOS** (`tests/e2e/mobile/`, [ADR-0015](../adr/0015-mobile-sdk-spec-and-conformance.md)): `conformance.mjs` runs the golden app, launches of the built `@ouo11y/react-native` bundle in Node (`launch.cjs`) with the React Native stand-ins of `sdk/react-native/playground` and `standin.cjs`, a model of the `OuoReplay` Expo module at the boundary the JavaScript calls (replay start, rotation, chunks cut like the Swift `ChunkBuilder` and uploaded, the crash report file, app start info, frame counters) and of the OS (crash, foreground kill, main-thread block, network down). It then asserts the checks of section 3 against an env's rum-api and prints the checks and the maturity row. CI runs it in the `examples` job on every change to `sdk/react-native`, `tests/e2e/mobile`, `services/rum-api`, `collector` or the shared stack (the `ex-ouo-mobile` path filter in `ci.yml`).
- **Native iOS** (`tests/e2e/mobile-native/`, W8): `run.sh` runs the example app `examples/ouo-ios` (UIKit with a SwiftUI screen) on an iOS simulator against an env: the real Swift code, every launch the checks need, C6.1's taps from an XCUITest runner, OTLP through a recording proxy for C11.2; `check.mjs` asserts the same checks against rum-api and prints the row. It runs by hand until CI has a job with a simulator and a stack (checklist N78).
- **What it proves**: the JavaScript SDK, the native module's contract and the backend together, on every PR, without a simulator. What it cannot prove is native behaviour itself (capture, masking pixels, hang detection): the model follows the Swift code, a package that changes the native module changes `standin.cjs` in the same PR, and the native code keeps its own tests plus the simulator run of `examples/ouo-mobile` (`scripts/run.sh`).
- **Pending checks**: a check whose package has not landed carries `pending: "<package>"`. It runs and is reported, and does not fail the run. When it passes, the run fails until the package deletes `pending`, so a capability cannot reach L2 without its check becoming required.
- **Running it**: `npm run -w sdk/react-native build`, then with an env's variables (`eval "$(deploy/envs/ouo-env env <env>)"`) and `OUO_BACKEND_URL` set to the env's backend: `node tests/e2e/mobile/conformance.mjs [--out result.json]`.

## 6. Changing this spec

A new capability, a renamed record or attribute, or a changed threshold needs an ADR and a matching change of the checks. A work package that lands a capability fills in its *draft* parts here, removes `pending` from its checks and updates the matrix in the same PR (roadmap §10).
