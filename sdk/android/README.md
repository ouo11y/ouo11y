# ouo11y Android (sdk/android)

The Android half of the ouo mobile SDK: session replay and the native signals (crashes, hangs,
foreground terminations, frames, app start; [ADR-0017](../../docs/adr-archive/0017-android-signals-and-opentelemetry-android.md)).

Replay is the Android half of ouo mobile replay (roadmap W9, [ADR-0006](../../docs/adr-archive/0006-mobile-replay-native-screenshots.md),
[ADR-0014](../../docs/adr-archive/0014-replay-tiles-in-frames.md)), the Kotlin twin of the Swift `OuoReplay`
in [sdk/ios](../ios/README.md). It sends the same `frames` chunks (schema 2, [mobile-replay.md](../../docs/specs/mobile-replay.md))
to the collector's replay receiver, so rum-api and the Grafana player do not care which platform
recorded them.

Today it is consumed by the React Native SDK: `@ouo11y/react-native` compiles these sources inside
the app's Gradle build (`sdk/react-native/scripts/sync-android.mjs` vendors them, as `sync-ios.mjs`
does for Swift). A native Android package on opentelemetry-android ([ADR-0016](../../docs/adr-archive/0016-opentelemetry-in-process.md))
is W9 part 2.

| Module | What it holds | Tests |
|---|---|---|
| `replay-core` | Plain Kotlin on the JVM: chunk model and JSON, `ChunkBuilder` (5 s / 1 MiB cuts, first frame full), `TileDiffer` (64 px tile hashes, patches, half-area rule), `CapturePacer` (interval, dirty flag, navigation mode, retries, 100 ms/s time bank), `RedactionPlanner` (Android view classes, per-line text masks, `ouo-mask` / `ouo-unmask` tags), `ChunkSpool`, `DiskQueue`, `ChunkUploader` | JUnit on the JVM, no Android |
| `signals-core` | Plain Kotlin on the JVM: the native report (`jvm`, `hang`, `termination`, JVM frames, the format the React Native SDK reads), `RunState`, the foreground-termination decision from `ApplicationExitInfo` facts, the hang rules (`HangDetector`), slow and frozen frame counting, the app start rule | JUnit on the JVM |
| `signals` | `Signals`: the uncaught exception handler (chained, writes `crash.json` at crash time), the main-thread watchdog (200 ms ping, 2 s), memory warnings, `ApplicationExitInfo` at the next launch, `FrameMetrics` per activity window, `ApplicationStartInfo` (Android 15) for the cold start | through the React Native suite on an emulator |
| `replay` | The Android capture: `WindowSpy` (root views from `WindowManagerGlobal`, the full-screen window on top), `ViewWalker` (bounds through offsets, scroll and transforms; line boxes of `TextView` and React Native's `PreparedLayoutTextView`), `ScreenCapturer` (`PixelCopy` into RGB_565, masks, JPEG), `TouchRecorder` (`Window.Callback` wrapper), `ReplayRecorder`, the `OuoReplay` facade | instrumented pixel test on an emulator |

## How a frame is taken

1. The capture target's `OnDrawListener` sets a dirty flag. In `session` mode a frame is due at most
   once per `frameInterval` (1 s) and only when the window drew since the last frame: a static
   screen costs no copy, no hash and no bytes. `navigation` mode takes one frame per screen
   (`screenDidChange()`), and `auto` picks it on devices with less than 3.5 GiB of RAM.
2. On the main thread: walk the view tree into window-pixel boxes and plan the masks, then ask
   `PixelCopy` (Android 8+) to copy the window's surface into an RGB_565 bitmap at the frame size
   (longest side 1000 px). The GPU scales; the main thread only issues the request. Before Android 8,
   or for a root without a `Window`, the tree is drawn in software into the same bitmap.
3. When the copy is done, walk again. **Masking fails closed**: if any mask moved between the two
   walks (a scroll, an animated transform), the frame is dropped and asked for again after the
   settle time.
4. On the compose thread: paint the masks black, hash the 64 px tiles against the last frame sent,
   then send nothing (unchanged), a full JPEG (first frame of a chunk, a new screen, more than half
   changed) or the changed rectangles as patches (quality 50).
5. Chunks are cut every 5 s, at 1 MiB, on pause, background and rotation; the open chunk is spooled
   to `noBackupFilesDir/ouo/replay/open-chunk.jsonl` and recovered by the next launch after a crash;
   cut chunks wait in `outbox/` (gzip, named after their headers) until the receiver answers 2xx or
   rejects them, with the backoff of the iOS uploader.

Masked by default: text (`TextView`, React Native text; one box per laid-out line, so the space
next to a short line stays visible), inputs (`EditText`, whole view, `maskInputs` independent of
`maskText`), images (`ImageView`, React Native images) and web views (`WebView`). A view whose tag
is `"ouo-mask"` (React Native `testID="ouo-mask"`) is masked whole; `"ouo-unmask"` leaves its subtree
alone. Hidden and transparent views are skipped; a subtree deeper than 64 levels is masked whole.

`TextureView` and `SurfaceView` (video, maps, camera previews) are masked whole with the images.

Not recorded yet: popups, toasts and dialogs that do not cover the activity (only the topmost
full-screen window is captured; a React Native `<Modal transparent>` records only its own window,
so the screen behind it is black in the replay). Jetpack Compose content is masked whole while `maskText`
is on: Compose draws in one `AndroidComposeView` the view walk cannot see into, so it fails closed
until the semantics walk of the Compose modifiers work package.

## Signals

- **Crash** (C2): an uncaught exception on any thread is written to `noBackupFilesDir/ouo/signals/crash.json`
  before the previous handler runs (React Native's, the system's, another SDK's), with the session
  and its start; the next launch hands it to the host. A React Native JS fatal arrives here as
  `com.facebook.react.common.JavascriptException`; the JavaScript already reported it with its JS
  stack and uses only the time.
- **Hang** (C3.1): a watchdog thread posts to the main looper every 200 ms. A post that waits 2 s
  starts a hang (from the main thread's last answer; the main thread's stack is read then); the hang
  is over when the post runs. One report per hang, none for 2 s after one, none under a debugger. In
  the background the watchdog is parked (no wake-ups) until an activity starts; a hang in progress
  when the app leaves the foreground ends then and is reported. Android draws no frames on an idle
  screen, so the iOS frame-delay rules do not apply.
- **Termination** (C3.2): `run.json` holds this run's pid, session, last memory warning and hang in
  progress. The next launch asks `ApplicationExitInfo` (Android 11+) how that pid died; a death at
  foreground or visible importance (not a foreground service, 125) by the low-memory killer, an ANR,
  excessive resource use, a native crash or a `SIGKILL` is a termination (cause `memory`,
  `watchdog`, `cpu` or `unknown`). Force stops, `exit()`, updates and background deaths are not.
- **Not captured: NDK (C/C++) crashes.** There is no native signal handler, so a crash in native
  code writes no `crash.json`; on Android 11+ it shows up only as a termination with cause `unknown`
  (`REASON_CRASH_NATIVE`). Next: read its tombstone from `ApplicationExitInfo.getTraceInputStream()`
  (Android 12+) at the next launch and report it as a crash with native frames.
- **Frames and app start** (C4): `FrameMetrics` of every resumed activity window counts rendered
  frames, slow (past the frame's deadline) and frozen (700 ms or more). The app start is cold from
  the process start only when the process was started to show the app (`ApplicationStartInfo` on
  Android 15, else a process at most 10 s older than the JS runtime); a process started earlier for
  a receiver or a service makes the launch warm.

## Replay over OTLP (`pixel/frames`)

With `OuoReplayConfig.otlp` (a `ReplayOTLPOptions`; from React Native, `start(endpoint, { otlp: { logsUrl, ... } })`)
the same capture loop sends the replay as OTLP log records instead of `/v1/replay/chunks`
(ADR-0021 decision 5, client SDK spec 11). Without it nothing changes. The Kotlin twins of the Swift
files in `sdk/ios/Sources/OuoReplayCore/OTLP`, with the same names, rules and bytes:

| Where | What |
|---|---|
| `ReplayFormatAdapter`, `PixelFrames` (core), `PixelFormatAdapter` (Android) | The seam between "when to look" and "what is recorded". One format: `ouo-frames/3`, newline-delimited JSON events `frame` (keyframe), `patch`, `touch` |
| `ReplayStream` | Replay id, stream id, segment index, sequence; chunks closed at 256 KiB compressed, 5 s, stream end or background; a body over 1 MiB is split, never truncated; the buffer ring (`buffer: { seconds }`) and `capture(trigger)`; `ouo.replay.ended`, also for a stream a kill left open (`open-stream.json`) |
| `ReplayEnvelope`, `ProtoWriter` | One `ExportLogsServiceRequest` per chunk, written by hand (scope `ouo.replay`, event `ouo.replay.chunk`, bytes body, the attributes of spec 11.3). `ReplayEnvelopeTest` asserts the request equals the iOS bytes |
| `ReplayDelivery` | Its own `DiskQueue` folder (`outbox-otlp`): persisted before the first send, the same bytes on a retry, `partial_success` read, `Retry-After` capped at 300 s, backoff with full jitter, the oldest chunks evicted first and their stream marked partial |
| `ReplayMaskRegistry` | `mask(reactTag)` / `unmask(reactTag)` for every recorder. On the OTLP path masking is strict: a secure input (password types, password transformation, password, card and one-time-code autofill hints) is always masked and a mask inside an unmasked subtree wins |
| `ReplayOTLPOptions` | The options as JavaScript passes them, read without ever throwing |

Every entry point catches what it throws (ERR-1): `ReplayFaultTest` injects an adapter that throws
or returns garbage, a disk and a collector that fail, and malformed options.

- **R8 mapping id** ([ADR-0027](../../docs/adr/0027-r8-mappings-and-retrace.md)): `gradle/ouo-mapping.gradle`, applied by
  the app, writes a fresh UUID per minified build into the APK (`ouo-debug-meta.properties`) and
  into `build/outputs/ouo/<variant>/mapping-id.txt`; `Signals` reads it at `init` and puts it in
  every report (`mapping_id`), which the React Native SDK sends as `ouo.exception.mapping_id`. CI
  uploads `mapping.txt` under it with `ouo-sourcemaps upload-proguard` ([docs/symbolication.md](../../docs/symbolication.md#android-r8--proguard)).
  `sample/` is a minified app that applies it and crashes through inlined code (`--ez crash true`),
  to verify it on an emulator.

## Use (React Native)

Nothing to do: `initRUM({ replay: { enabled: true } })` starts it through the Expo module on both
platforms (see `sdk/react-native/README.md`). The Release build of a React Native app needs no
permission; replay reads only the app's own windows.

## Build and test

Needs JDK 17 and the Android SDK (`ANDROID_HOME`, platform 35, build-tools 35); see
[project/kb-archive/android-setup.md](../../project/kb-archive/android-setup.md).

```bash
cd sdk/android
./gradlew :replay-core:test :signals-core:test  # JVM unit tests, seconds
./gradlew :replay:assembleRelease              # the Android library
./gradlew :replay:connectedAndroidTest         # pixel test on a running emulator (ANDROID_SERIAL)
./gradlew :sample:assembleRelease              # the R8 sample, with its mapping and mapping id
```

CI (`ci.yml`, job `android`, on the Mac runner) runs the unit tests, builds the library and its
instrumented tests, and compiles the Expo module inside `examples/ouo-mobile`. The emulator runs, the
pixel test and the conformance suite ([tests/e2e/mobile-android](../../tests/e2e/mobile-android/README.md)),
are run by hand.
