# Android on this Mac: toolchain, emulator, React Native Release builds, replay capture quirks

W9 part 1 (2026-10-31). What it took to build, run and drive the React Native example on an Android
emulator, and what the Android capture code ran into.

## Toolchain

- JDK 17: Temurin in `/Library/Java/JavaVirtualMachines/temurin-17.jdk` (system-wide, so the CI runner
  user `ouo-runner` sees it too). Android SDK: Homebrew `android-commandlinetools` at
  `/opt/homebrew/share/android-commandlinetools`; `export ANDROID_HOME=` that. No Gradle on PATH:
  every project uses its wrapper (`sdk/android/gradlew`, the example's `android/gradlew` from prebuild).
- The SDK came with platform 35, build-tools 35, the emulator and `system-images;android-35;google_apis;arm64-v8a`.
  React Native 0.86 / Expo 57 want compileSdk 36, build-tools 36.0.0, NDK 27.1.12297006 and CMake
  3.22.1: AGP downloads them into `ANDROID_HOME` on the first app build (licenses were already
  accepted), about 15 minutes, which needs the SDK folder writable by the user who builds. They are
  installed now; `sdk/android` itself builds against 35 so CI needs nothing new.
- Versions to match: React Native's `node_modules/react-native/gradle/libs.versions.toml` (AGP 8.12.0,
  Kotlin 2.1.20, minSdk 24). `sdk/android` uses the same, because the Expo module compiles its sources
  inside the app's build with the app's Kotlin.
- `lintVitalAnalyzeRelease` crashes inside third-party modules (react-native-screens,
  expo-modules-core: "Unexpected failure during lint analysis") on this AGP and JDK 17.
  `scripts/build-android.sh` passes `-x lintVitalAnalyzeRelease`.

## Emulator

- `avdmanager create avd -n <name> -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6`
  prints "Could not load devices from .../devices.xml" (cmdline-tools older than the SDK XML v4) and
  still creates the AVD. Set `hw.ramSize=4096`, `hw.gpu.enabled=yes`, `hw.gpu.mode=swiftshader_indirect`
  in `~/.android/avd/<name>.avd/config.ini`.
- Headless: `emulator -avd <name> -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot-save &`,
  keep `$!`; boot about 25 s; serial `emulator-5580`. Stop with `adb -s emulator-5580 emu kill` or
  `kill <pid>`, never by pattern. Another session's AVD (`ouo-pixel`) exists: use your own name and port.
- From the emulator the Mac's `localhost` is `10.0.2.2`; ouo-env publishes OTLP, replay and the backend
  on localhost ports (`ouo-env url <env>`), so `http://10.0.2.2:<port>` reaches them.
  `*.ouo.localhost` names do not resolve inside the emulator.

## React Native Release builds and driving them

- `examples/ouo-mobile/scripts/build-android.sh [--env <name>] [--conformance]`: `expo prebuild
  --platform android` once, then `gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`
  (one ABI: four take 4x the C++ build). The Release APK is signed with the debug key by Expo's
  template. Expo bakes `app.config.ts` `extra` at Gradle time, so the env variables must be set for the
  Gradle run, not only for prebuild.
- Plain http to the local stack is blocked in Release builds since API 28; Expo lifts it only for
  debug. The example adds `android:usesCleartextTraffic="true"` with `plugins/withAndroidCleartext.js`.
- Driving without taps: a Release build is not debuggable, so `run-as` and writing into the app's
  files fail. A deep link (`am start -d`) delivers through `onNewIntent`, which **pauses the activity**,
  and React Native reports every pause as AppState `background`: each command would flush and pause
  replay. A broadcast does not touch the activity: the demo module `modules/ouo-chaos` registers a
  receiver (`RECEIVER_EXPORTED` from API 33) and forwards `--es cmd` as an `onJourneyCommand` event.
  Quote the whole remote command: `adb shell "am broadcast -a ... --es cmd 'action/x?a=1&b=2'"`.
- `console.log` of a Release build still reaches logcat (tag `ReactNativeJS`): the suite's notes travel
  there (`adb logcat -v epoch ReactNativeJS:I '*:S'`).
- React Native sets `testID` as the view's plain tag and as `R.id.react_test_id`, and exposes it as the
  accessibility resource id: `uiautomator dump` shows `resource-id="<testID>"`, so `adb shell input
  tap` finds views by test id, and `view.tag == "ouo-mask"` works for the replay masks.
- `measureInWindow` gives dp in the window, the replay viewport's points (`viewport.width` = window px /
  density).

## Capture (sdk/android)

- `PixelCopy.request(Window, Bitmap, ...)` (API 26) scales the window's surface into a bitmap of any
  size and accepts `Bitmap.Config.RGB_565`: half the memory and half the bytes to hash, and the main
  thread only issues the request. The status bar is not in the window surface (edge-to-edge apps get
  their own background there).
- The copy is queued on the RenderThread behind the frame being drawn, so it shows the layout of the
  last walk unless something drew in between. The recorder walks again when the copy is done and
  drops the frame when a mask moved (the Android form of "masking fails closed").
- Window discovery: `WindowManagerGlobal.mViews` (non-SDK, "unsupported" list, readable on API 35) gives
  every root view; `DecorView.mWindow` gives a dialog's `Window`. A React Native `Modal` is a full-screen
  dialog and is captured; popups are not (no `Window`).
- Per-line text masks: `TextView.getLayout()` lines offset by `totalPaddingLeft` and `totalPaddingTop`
  (which includes the vertical gravity offset `onDraw` applies) minus scroll. React Native 0.86 renders
  text with `ReactTextView` (a `TextView`); `PreparedLayoutTextView` (a `ViewGroup`) only behind the
  `enablePreparedTextLayout` flag, read through `getPreparedLayout().getLayout()` and `getVerticalOffset()`.
  An `EditText` with an empty text shows its hint from another layout: inputs are masked whole anyway.
- `java.util.Base64` needs API 26 and `android.util.Base64` is not on the JVM the core tests run on: the
  core has its own encoder. `org.json` is part of Android: `compileOnly` in `replay-core`, a test
  dependency on the JVM.
- Kotlin interface delegation (`Window.Callback by delegate`) does not forward Java default methods
  (`onProvideKeyboardShortcuts`, `onPointerCaptureChanged`): the touch wrapper overrides them.

## npm in this worktree

The shared checkout's `package.json` had merge-conflict markers on 2026-10-31; npm walks up from a
worktree under `.claude/worktrees/` looking for a workspace root and dies with "Exit prior to config
file resolving / call config.load() before reading values". `npm --prefix <worktree> ...` stops the
walk (see also [diy-browser-rum.md](diy-browser-rum.md)). `ouo-env up` runs npm itself: put a shim
first on `PATH` that adds `--prefix` (nearest folder with a `package.json` inside the git top level).

## After the Mac sleeps

A run interrupted by the Mac sleeping (13 h here) came back with the emulator and the stack up, but
Loki's ring unhealthy ("at least 1 healthy replica required"): rum-api found no session and every
check polled until its timeout. `docker restart ouo-<env>-loki-1` fixed it with no data lost (the
WAL replays); the checks then passed on the same run's notes (`node tests/e2e/mobile-android/check.mjs <out dir>`).
