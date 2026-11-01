# W9 part 1: React Native Android (replay capture, delivery, vitals) and its conformance suite

Date: 2026-10-31. Branch `claude/w9-android`. Roadmap W9 ([roadmap.md](../../../kb/mobile-sdk-research/roadmap.md), lane D), split into PRs that merge on their own; this is the React Native Android one.

## What was done

- **`sdk/android`** (new Gradle project, wrapper, AGP 8.12 and Kotlin 2.1.20 to match React Native 0.86):
  - `replay-core`, plain Kotlin on the JVM: the chunk model and its JSON (schema 2, `platform: android`), `ChunkBuilder`, `TileDiffer` (64 px tiles over RGB_565 bytes), `CapturePacer` (interval, the `OnDrawListener` dirty flag, navigation mode, retries, 100 ms/s time bank), `RedactionPlanner` (Android classes, per-line text masks, `ouo-mask` / `ouo-unmask` tags, Compose masked whole), `ChunkSpool`, `DiskQueue` (no age, stamps kept in put order, ported from the N77 fix that landed on main during this run), `ChunkUploader` (gzip, Basic credential, held sessions). Ports of the Swift design, not of its code.
  - `replay`, the Android capture: `WindowSpy` (RootViewsSpy-style window discovery through `WindowManagerGlobal.mViews`, the topmost full-screen window, so a React Native `Modal` is recorded), `ViewWalker` (bounds through offsets, scroll and transforms; line boxes of `TextView` and `PreparedLayoutTextView`), `ScreenCapturer` (`PixelCopy` straight into an RGB_565 bitmap at the frame size, software draw before Android 8, masks, JPEG 50), `TouchRecorder` (`Window.Callback` wrapper, dp), `ReplayRecorder` (dirty flag, the two-walk fail-closed rule, compose thread, background/foreground), `OuoReplay` facade.
- **`@ouo11y/react-native` Android module** (`dev.ouo.reactnative.OuoReplayModule`, replaces the stub): the iOS module's replay functions over `sdk/android` (vendored into `android/vendor` by `scripts/sync-android.mjs`, run by `npm run build`, shipped through `android/.npmignore`), `postOtlp` (gzip and POST off the JS thread, so C11.2 holds on Android), and `getAppStartInfo` / `getFrameStats` (`Vitals.kt`: process start from `Process.getStartUptimeMillis()`, a `Choreographer` counter paused in the background). Crash and hang functions are not there: the JS checks for each.
- **Example** `examples/ouo-mobile`: `scripts/build-android.sh` (Release APK, `--env`, `--host`, `--conformance`), `plugins/withAndroidCleartext.js`, the Android side of `modules/ouo-chaos` (broadcast command channel, native crash, hang, kill), journey actions `error`, `golden`, `areas`, `crash`, `event`, `OUO_CONFORMANCE=1` mode (default masking, 5 s background timeout, `OUO_NOTE` lines), test ids and an image on Product.
- **Suite** `tests/e2e/mobile-android` (`run.sh`, `check.mjs`, README): the real app on an emulator against an ouo-env, same check ids, pending checks for part 2.
- **CI**: job `android` on the Mac runner (`[self-hosted, macOS]`, like `swift`): `replay-core` tests, the library, its instrumented tests compiled, and the Expo module compiled inside the example's Gradle build (`:ouo11y-react-native:compileReleaseKotlin`, `:ouo-chaos:compileReleaseKotlin`). Path filter `android`.
- **Docs**: `docs/specs/mobile-replay.md` "Capture rules (Android)"; `docs/specs/mobile-sdk.md` matrix (React Native Android column) and section 5; `sdk/android/README.md`; the RN README; the example README; kb [android-setup.md](../../../kb/android-setup.md); checklist N85, N86, N87. ADR-0016 (opentelemetry-android as the Android base) already existed; nothing new to decide in part 1.

## Verified, and how

- `cd sdk/android && ./gradlew :replay-core:test`: 17 JVM tests pass (base64 against the JDK, the spec's JSON keys, chunk cuts, spool recovery after a torn line, seq store, tile diff and merge, padding, per-line and override masks, Compose, upload headers and gzip body, retry and rejection, held sessions, the queue bound with the clock moved back and forward, pacer rules).
- `./gradlew :replay:connectedAndroidTest` on the emulator `ouo-w9` (API 35, arm64): the pixel test (`MaskPixelTest`) walks, plans, copies with `PixelCopy` into RGB_565, encodes, decodes the JPEG and measures: both lines of a label black where their text is, white beside the short second line (per-line masks), an `EditText` and an `ImageView` black, an `ouo-unmask` label readable. Passes, with the settled-tree test added in review (2 instrumented tests).
- `tests/e2e/mobile-android/run.sh w9-android emulator-5580` against my own env (released images, `ouo-env up w9-android --images`), Release APK, four full runs (the last after the review fixes): C1.1, C2.1, C4.1, C4.2, C5.1, C6.1, C7.1, C8.1, C8.2 (pixels of the product image, the price text, the cart total and the feedback input all black: mean brightness 0 to 0.0012), C8.3, C9.1, C10.1, C11.1, C11.2 pass; C2.2 runs and fails as expected (pending, W9 part 2), C2.3, C3.1, C3.2 pending and not run. Row: C1 L2, C2 L1, C3 L0, C4 L2, C5–C11 L2.
- Frames looked at by eye (decoded from rum-api): per-line black boxes on the product list, the `ouo-unmask` title readable, the product image masked, viewport 411 x 914 dp at scale 1.09 (450 x 1000 px frames), full frames on navigation, a static screen sends nothing.
- `npm run -w sdk/react-native typecheck` and `test` (192 tests) pass; `examples/ouo-mobile` `tsc --noEmit` passes; `lychee --offline` clean.

## Review (PR #141) and what changed

The reviewer session asked for changes; all eleven findings were taken:

1. Masks could lag the screen: the walk reads the views now, `PixelCopy` the last frame drawn. When a layout or an invalidation waits for a draw (`root.isLayoutRequested || root.isDirty`), the walk now runs in the next draw's `OnDrawListener` and the copy is requested at the front of the queue right after it (so a spinner does not stop capture); a second instrumented test checks the settled rule after a `setText`.
2. The foreground count started at 1 whenever Expo had an activity; it now asks `ActivityManager.getMyMemoryState` (a start from a background task does not capture).
3. Frame duration follows refresh-rate changes through a `DisplayListener` (not observable on the emulator's fixed 60 Hz).
4. Rebased on main (#140); checklist ids renumbered N85–N87.
5. The `android` path filter covers the sync script, the package manifests, the example's config and plugins, and the root lockfile.
6. `TextureView` and `SurfaceView` are masked with images.
7. Transparent React Native modals (only their own window is recorded) documented in N86 and the README.
8. Rotation no longer resets the seq store on Android (a chunk opened after the host switched ids kept 0 and got 0 again); the iOS twin is N87.
9. The example's journey receiver only listens in conformance and debug builds.
10. Part 2 notes below (cold start after a receiver-started process, vsync cost of the `Choreographer` counter).
11. `distributionSha256Sum` pinned in the wrapper properties (checked against services.gradle.org).

## Left, and what the next session must know

- **W9 part 2** (next PR), also from the review: a cold start must not be measured from a process the system started earlier for a receiver or service (use `ApplicationStartInfo` on API 35 or the first activity's creation); the `Choreographer` counter keeps vsync on every frame, `FrameMetrics` per window would not.
- **W9 part 2** (next PR): opentelemetry-android base per ADR-0016 for the React Native module and the native package: sessions provider following session-lifecycle.md, crash (C2.2, C2.3), ANR as `hang` (C3.1), `ApplicationExitInfo` terminations (C3.2), jank onto the same `app.jank` counters, disk buffering; remove `pending` from those checks in `tests/e2e/mobile-android/check.mjs`.
- **Later parts**: Jetpack Compose modifiers and a semantics walk (today Compose content is masked whole), R8 / ProGuard mapping symbolication (W7 extension: `ouo-sourcemaps` upload, rum-api symbolication), the native Android package (Kotlin API, Java smoke target, Maven Central), B3 Android cells, the suite in CI (N85), the replay gaps in N86 (popups, transparent modals).
- Driving the app: broadcasts, not deep links (a deep link pauses the activity and React Native reports a background). Release builds log `console.log` to logcat; the suite reads notes there.
- npm in this worktree needs `--prefix` (the shared checkout's `package.json` is conflicted); `ouo-env up` needs a PATH shim for it (kb android-setup.md).
- The first app build downloads platform 36, build-tools 36, NDK 27.1 and CMake into the Homebrew SDK (done now, about 15 min).
- Dependencies added: none at runtime (org.json and `java.net` are the platform's). Build-time: AGP 8.12.0 and Kotlin 2.1.20 plugins (what React Native 0.86 uses); test-only: JUnit 4.13.2, org.json 20250517 for the JVM tests, androidx.test core/runner/ext-junit for the pixel test.
- Env `w9-android` and the emulator `ouo-w9` (port 5580) are torn down at the end of this run.
