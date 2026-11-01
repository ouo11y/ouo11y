# ouo11y Android (sdk/android)

The Android half of ouo mobile replay (roadmap W9, [ADR-0006](../../docs/adr/0006-mobile-replay-native-screenshots.md),
[ADR-0014](../../docs/adr/0014-replay-tiles-in-frames.md)), the Kotlin twin of the Swift `OuoReplay`
in [sdk/ios](../ios/README.md). It sends the same `frames` chunks (schema 2, [mobile-replay.md](../../docs/specs/mobile-replay.md))
to the collector's replay receiver, so rum-api and the Grafana player do not care which platform
recorded them.

Today it is consumed by the React Native SDK: `@ouo11y/react-native` compiles these sources inside
the app's Gradle build (`sdk/react-native/scripts/sync-android.mjs` vendors them, as `sync-ios.mjs`
does for Swift). A native Android package on opentelemetry-android ([ADR-0016](../../docs/adr/0016-opentelemetry-in-process.md))
is W9 part 2.

| Module | What it holds | Tests |
|---|---|---|
| `replay-core` | Plain Kotlin on the JVM: chunk model and JSON, `ChunkBuilder` (5 s / 1 MiB cuts, first frame full), `TileDiffer` (64 px tile hashes, patches, half-area rule), `CapturePacer` (interval, dirty flag, navigation mode, retries, 100 ms/s time bank), `RedactionPlanner` (Android view classes, per-line text masks, `ouo-mask` / `ouo-unmask` tags), `ChunkSpool`, `DiskQueue`, `ChunkUploader` | JUnit on the JVM, no Android |
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

## Use (React Native)

Nothing to do: `initRUM({ replay: { enabled: true } })` starts it through the Expo module on both
platforms (see `sdk/react-native/README.md`). The Release build of a React Native app needs no
permission; replay reads only the app's own windows.

## Build and test

Needs JDK 17 and the Android SDK (`ANDROID_HOME`, platform 35, build-tools 35); see
[project/kb/android-setup.md](../../project/kb/android-setup.md).

```bash
cd sdk/android
./gradlew :replay-core:test                    # JVM unit tests, seconds
./gradlew :replay:assembleRelease              # the Android library
./gradlew :replay:connectedAndroidTest         # pixel test on a running emulator (ANDROID_SERIAL)
```

CI (`ci.yml`, job `android`, on the Mac runner) runs the unit tests, builds the library and its
instrumented tests, and compiles the Expo module inside `examples/ouo-mobile`. The emulator runs, the
pixel test and the conformance suite ([tests/e2e/mobile-android](../../tests/e2e/mobile-android/README.md)),
are run by hand.
