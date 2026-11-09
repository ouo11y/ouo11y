# ouo-bare-rn: `@ouo11y/react-native` in a bare React Native 0.82 app

A bare React Native app (the `@react-native-community/cli` template, not Expo's), with Expo modules
added by `npx install-expo-modules` and the native code of `@ouo11y/react-native` (replay, native
crashes, hangs, terminations, vitals, gzip OTLP) linked through them. It is the setup of a client
app on React Native 0.82 with Firebase pods: every pod is a static framework
(`use_frameworks! :linkage => :static`) and `FirebaseCore`, `FirebaseCrashlytics` and
`FirebaseAnalytics` are linked next to `ExpoModulesCore` and the ouo pods.

The client steps are in [sdk/react-native/README.md](../../sdk/react-native/README.md#bare-react-native)
("Bare React Native"); the versions in [docs/compatibility.md](../../docs/compatibility.md#react-native-hosts);
the problems met on the way in [project/kb/rn-bare-install-expo-modules.md](../../project/kb/rn-bare-install-expo-modules.md).

## How it was made

```bash
npx @react-native-community/cli@20.0.2 init OuoBare --version 0.82.1 --package-name dev.ouo.bare --skip-git-init
cd OuoBare
npx install-expo-modules@0.18.3 --sdk-version 54.0.0 --non-interactive   # no Expo SDK maps to 0.82: pick 54
npm install @ouo11y/react-native @react-native-async-storage/async-storage
```

then the changes below, each commented where it is made:

| Where | Change | Why |
|---|---|---|
| `patches/expo-modules-core+3.0.30.patch` (`patch-package`) | two `#import`s in `EXJSIUtils.h` | React Native 0.82's `TurboModuleUtils.h` no longer includes `CallInvoker.h` and `CallbackWrapper.h`; Expo SDK 54 was built against 0.81 and does not compile without them (SDK 55 has the same two lines) |
| `ios/Podfile` | `use_frameworks! :linkage => :static`, the Firebase pods | the client's setup |
| `ios/Podfile` `post_install` | the `fmt` pod as C++17 | React Native 0.82's `fmt` 11.0.2 does not compile with Xcode 27 (plain React Native problem) |
| `ios/Podfile` `post_install` | pod deployment targets raised to 15.1 | Xcode 27 refuses targets below 15.0 (Firebase's dependencies, AsyncStorage) |
| `android/app/src/main/java/dev/ouo/bare/MainApplication.kt` | the Expo SDK 54 template's `ReactNativeHostWrapper` around a `DefaultReactNativeHost` | `install-expo-modules` writes a `ReactNativeHostWrapper.createReactHost(context, packageList)` call SDK 54 does not have |
| `ios/OuoBare/AppDelegate.swift` | `bindReactNativeFactory(factory)` | SDK 54's template has it, `install-expo-modules` does not add it: the first root view traps in `ExpoAppDelegate.recreateRootView` |
| `ios/OuoBare/AppDelegate.swift`, `Info.plist` | a scene delegate (UIScene life cycle) | an app built with the iOS 27 SDK traps at launch without one |
| `ios/OuoBare.xcodeproj` bundle phase, `android/app/build.gradle` | `@expo/cli` resolved from `expo`'s directory | `install-expo-modules` writes `require.resolve('@expo/cli')`, which fails when npm nests `@expo/cli` under `expo/node_modules` |
| `android/app/src/main/AndroidManifest.xml` | `usesCleartextTraffic="true"` | the Release build talks plain http to the local stack |

The app's JavaScript is the golden app's: `index.js` imports `../ouo-mobile/src/rum` (`initRUM`) and
`../ouo-mobile/App`, and `package.json` points Expo autolinking at `../ouo-mobile/modules` for the demo
module `ouo-chaos` (hangs, out-of-memory kills, the journey's broadcast receiver). So the conformance
suites drive the same screens here as on Expo 57. `metro.config.js` makes those files and the
`file:` linked SDK resolve their imports from this app, and `app.config.js` gives `expo-constants`
the same `extra` settings as `../ouo-mobile/app.config.ts`. A client app needs none of these three.

## Build and run

Needs Node 24, Xcode 27 with CocoaPods, JDK 17 and the Android SDK (project/kb/xcode-setup.md,
project/kb/android-setup.md), Docker for the stack.

```bash
OUO_SESSION=<you> deploy/envs/ouo-env up <env>
npm ci && npm run -w sdk/react-native build
(cd examples/ouo-bare-rn && npm ci)
```

iOS Simulator: the native capabilities against the stack (journey, replay, native crash, hang,
memory kill, gzip), about 4 minutes plus the build:

```bash
examples/ouo-bare-rn/scripts/verify-ios.sh --env <env> --device <simulator udid> --build
```

Android emulator (API 35): the React Native Android conformance suite, unchanged, on this app:

```bash
OUO_ANDROID_APP=ouo-bare-rn tests/e2e/mobile-android/run.sh <env> <adb serial>
```

Build only (CI, job `bare-rn` in `.github/workflows/ci.yml`):

```bash
examples/ouo-bare-rn/scripts/build-ios.sh --no-install
examples/ouo-bare-rn/scripts/build-android.sh --no-install
```

`--no-firebase` on `build-ios.sh` leaves the Firebase pods out. They are linked, not configured:
the example has no `GoogleService-Info.plist`, so Crashlytics installs no handlers at runtime and
its coexistence with ouo's crash handlers is not exercised here (ouo's signal and exception
handlers chain to the ones installed before them: `project/kb/ios-native-crashes.md`,
`sdk/react-native/README.md` "Errors and crashes").
