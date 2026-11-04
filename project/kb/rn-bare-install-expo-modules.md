# Bare React Native 0.82 + install-expo-modules: what it takes for `@ouo11y/react-native`

Question: can a bare (non-Expo) React Native 0.82 app with Firebase pods and static frameworks run the
native side of `@ouo11y/react-native` (an Expo module) through `npx install-expo-modules`, and what
breaks on the way? (JUHI gap B2, 2026-11-04, `examples/ouo-bare-rn`.)

Answer: yes, with Expo SDK 54 and a two-line patch to `expo-modules-core`. The SDK's own Swift and
Kotlin compiled unchanged against `expo-modules-core` 3.0.30 and React Native 0.82.1. Everything
else below is a gap in `install-expo-modules` or the 0.82 / Xcode 27 toolchain.

## Which Expo SDK for React Native 0.82

- `install-expo-modules@0.18.3` maps React Native versions to SDKs with semver ranges (in its bundled
  `build/index.js`): SDK 54 `~0.81.0`, SDK 55 `~0.83.0`, SDK 56 `~0.85.0`, SDK 57 `~0.86.0`. Nothing
  covers 0.82 (nor 0.84), so a plain run fails with "Unable to find compatible Expo SDK version";
  pass `--sdk-version 54.0.0` (the only one that builds on 0.82, below). `--non-interactive` skips
  its prompts.
- **SDK 55 does not build on 0.82**: `EXReactRootViewFactory.h` uses `RCTDevMenuConfiguration`, which
  React Native added in 0.83 ("expected a type", then the Swift module `Expo` fails to precompile).
- **SDK 54 builds on 0.82 with a patch**: `expo-modules-core` 3.0.30 `ios/JSI/EXJSIUtils.h` relied on
  0.81's `ReactCommon/TurboModuleUtils.h` including `CallInvoker.h` and `CallbackWrapper.h`; 0.82
  trimmed those includes ("no member named 'CallInvoker' in namespace 'facebook::react'", then
  "'CallbackWrapper'" in `EXJSIUtils.mm`). Adding `#import <ReactCommon/CallInvoker.h>` and
  `#import <react/bridging/CallbackWrapper.h>` (exactly what SDK 55's header has) fixes it:
  `patches/expo-modules-core+3.0.30.patch` with `patch-package`, `expo` pinned at 54.0.38 and
  `expo-modules-core` at 3.0.30 (exactly what 54.0.38 depends on: with `~54.0.0` a later 54.0.x on
  another core version would nest an unpatched copy under `expo/node_modules`). Android
  needed no patch. Expo canaries of autumn 2025 targeted 0.82 but are not something to ship.

## install-expo-modules gaps (SDK 54 into a 0.82 template)

- `MainApplication.kt`: it rewrites `getDefaultReactHost(...)` to
  `ReactNativeHostWrapper.createReactHost(context = ..., packageList = ...)` without an import, and
  SDK 54 has no such overload (`createReactHost(context, reactNativeHost)` only; the
  `ExpoReactHostFactory.getDefaultReactHost(context, packageList)` it targets arrived in SDK 55):
  "Unresolved reference 'ReactNativeHostWrapper'". Use the SDK 54 template: `reactNativeHost =
  ReactNativeHostWrapper(this, object : DefaultReactNativeHost(this) { ... })` and `reactHost` from
  `ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)`. 0.82 still ships
  `DefaultReactNativeHost` (deprecated); `ReactApplication.reactNativeHost` throws by default, so it
  must be overridden. `ExpoReactHostFactory.createFromReactNativeHost` caches the host.
- `AppDelegate.swift`: no `bindReactNativeFactory(factory)`. The first root view goes through
  `ExpoReactDelegate.createReactRootView` -> `ExpoAppDelegate.recreateRootView`, which hits
  `fatalError("Missing factory in ExpoAppDelegate")` (EXC_BREAKPOINT in the crash report).
- `@expo/cli`: it writes `require.resolve('@expo/cli')` for Gradle's `cliFile` and Xcode's
  `CLI_PATH`. npm nested `@expo/cli` under `node_modules/expo/node_modules` here, so it resolves to
  nothing. Android: `cliFile = new File("")` is `android/app`, and Gradle 9 stops the release build
  with "Task ':app:createBundleReleaseJsAndAssets' uses this output of task
  ':app:generateReactNativeEntryPoint' without declaring an explicit or implicit dependency" (it
  never says the path is empty). iOS: the bundle phase logs "Cannot find module '@expo/cli'" and
  `react-native-xcode.sh` falls back to the React Native CLI, so the build "succeeds". Expo's
  prebuild template resolves it from expo's directory:
  `require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })`.

## React Native 0.82 under Xcode 27 (not Expo's, not ouo's)

- `fmt` 11.0.2 (0.82's third-party pod) fails in `format-inl.h`: "call to consteval function
  'fmt::basic_format_string<...>' is not a constant expression" with Apple clang 21. fmt has no
  override macro (`FMT_USE_CONSTEVAL` is computed), so compile that one pod target as C++17
  (`CLANG_CXX_LANGUAGE_STANDARD`) in `post_install`, where fmt turns consteval off. The `fmt` pod is
  React Native's own (`third-party-podspecs/fmt.podspec`); Expo does not touch it (the plain template
  without Expo was not built to confirm).
- Pod deployment targets below 15.0 are errors in Xcode 27: "The iOS Simulator deployment target
  'IPHONEOS_DEPLOYMENT_TARGET' is set to 12.0, but the range of supported deployment target versions
  is 15.0 to 27.0.x" on resource-bundle targets (`GoogleDataTransport`, `GoogleUtilities`, `nanopb`,
  `PromisesObjC`, `PromisesSwift`, `RNCAsyncStorage`). `react_native_post_install` does not raise
  them: set every pod target below `min_ios_version_supported` to it.
- UIScene: an app linked against the iOS 27 SDK traps at launch in
  `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` without a scene manifest. SDK 54
  has no `ExpoAppSceneDelegate` (the golden app's `plugins/withUIScene.js` uses SDK 57's), so the
  example has a small `SceneDelegate` (creates the window, `factory.startReactNative(withModuleName:in:)`)
  and `UIApplicationSceneManifest` naming `$(PRODUCT_MODULE_NAME).SceneDelegate`. Putting the class in
  `AppDelegate.swift` avoids editing the pbxproj.

## Static frameworks and Firebase

- `use_frameworks! :linkage => :static` plus `FirebaseCore`, `FirebaseCrashlytics`, `FirebaseAnalytics`
  12.x (`~> 12.0`, what an app of the 0.82 era carries; 13.x is out since 2026-10) next to
  `use_expo_modules!` needed nothing beyond the deployment-target fix: `ExpoModulesCore`, the ouo
  pods (`OuoReactNative`, `OuoReplay`, `OuoCrash`, `OuoVitals` and their cores) and Firebase all link as
  static frameworks. Firebase is linked, not configured (no `GoogleService-Info.plist`), so Crashlytics'
  handlers next to OuoCrash's are not exercised.

## The example's own wiring (not needed by a client)

- The golden app's screens, journey and `ouo-chaos` module are reused, so the conformance suites
  drive the same UI: `index.js` imports `../ouo-mobile/src/rum` and `../ouo-mobile/App`; Expo
  autolinking takes `"expo": { "autolinking": { "nativeModulesDir": "../ouo-mobile/modules" } }` in
  package.json (works in SDK 54); Metro resolves every package import from those files (and from the
  `file:` linked SDK) as if from the app's `index.js`, since `../ouo-mobile/node_modules` holds Expo 57.
- `expo-constants` works in a bare app: its Gradle task `createExpoConfig` and Xcode phase evaluate
  `app.config.js` in the project root (it receives `app.json` as `config`), and the result lands in
  `assets/app.config` / the bundle, rebuilt on every build (a changed env var is picked up).
- React Native's Gradle plugin sets the `usesCleartextTraffic` placeholder to `false` for release in
  `finalizeDsl`, so a `manifestPlaceholders` override in `buildTypes.release` is lost; the example
  writes `android:usesCleartextTraffic="true"` in the manifest instead.
- `measureInWindow` is not window coordinates on Android before React Native 0.86: Fabric adds a
  viewport offset (`RootViewUtil.getViewportOffset`) = the root's location in the window minus
  `getWindowVisibleDisplayFrame().top`, so the status bar (and cutout) is always subtracted. 0.86
  subtracts the insets only when not edge to edge. The golden journey's `action/areas` notes the
  rectangles C8.2 compares with replay frames (which are the whole window), so on the 0.82 app every
  rectangle was off: 28 pt with `edgeToEdgeEnabled=false` (the template's), 52 pt with `true`, and C8.2
  failed while the frames were fully masked (a frame composited from rum-api's `/replay/frames` and
  looked at: every label, price, input and image black; the two product rectangles passed only because
  they landed on other black boxes). Fix in the journey: measure the app's root view too and note
  rectangles relative to it, which is the window when the app draws edge to edge (both examples do;
  on 0.86 the root measures (0, 0)). Taps carry no coordinates, and masks are drawn natively, so the
  SDK itself is not affected.
- The suite's AVD needs `hw.ramSize=4096` (project/kb/android-setup.md says so; `avdmanager create`
  gives 2 GB): under 3.5 GiB replay's `auto` mode records in `navigation` mode, 4 frames for the
  whole journey instead of one per change.
- React Native's Gradle bundle task (`createBundleReleaseJsAndAssets`) only tracks files under the
  app's root: a change in `../ouo-mobile` (or the `file:` linked SDK's `dist`) left it `UP-TO-DATE` and the
  APK kept the old JavaScript. `scripts/build-android.sh` runs that task with `--rerun`. Xcode's bundle
  phase has no outputs, so it runs on every build.
- Running the iOS and Android builds at the same time races on `npm run -w sdk/react-native build`
  (tsup empties `dist/` first): Metro then fails with "this package itself specifies a `main` module
  field that could not be resolved". Build one at a time, or build the SDK once up front.
- npm in a worktree nested inside a main checkout with conflicted `package.json` files: see
  [diy-browser-rum.md](diy-browser-rum.md) (`--prefix` on the command line skips the walk up).
