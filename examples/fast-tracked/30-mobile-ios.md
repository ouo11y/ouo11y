# 30. Add ouo RUM and screenshot replay to your React Native (Expo) app, iOS

This guide is for an engineer who has their own Expo app and wants sessions, errors, crashes,
fetch traces and screenshot replay from it in the ouo stack, running on a Mac with the latest
macOS (27.x) and Xcode 27. It assumes the local stack from `00-stack.md` is up: the ouo collector
(`ouo-collector`, the only endpoint the app talks to since ADR-0007) with OTLP/HTTP on
`http://localhost:4318` and its replay receiver on `http://localhost:4319`, and Grafana on
`http://localhost:3000`. rum-api, Loki, Tempo and Mimir are internal.

Everything below was checked against this repository on 2026-10-10 (macOS 27.0.1, Xcode 27.0,
iOS 27.0 simulator runtime, CocoaPods 1.17, Node 24.15, Expo SDK 57, React Native 0.86,
`@ouo/react-native` 0.2.0). Anything that could not be checked in the repo is marked
**not verified in this repo**. The 0.2.0 init shape (`endpoint` = collector, `projectId` +
`projectToken` as HTTP Basic) is verified with unit tests and a local stub; the live run against
the Phase 8a collector is owed to the QA pass (see the note in section 7).

Reference app: `examples/mobile` ("mobile-store"). You copy four files from it as they are
(listed under "Ref files") and write the rest yourself.

---

## 1. What you get

| Signal | Who produces it | Where it lands |
|---|---|---|
| `session.start` / `session.end` events, 30 min inactivity, 4 h max, 30 s background rule | SDK, automatic | Loki (via the collector) |
| `exception` events, fatal JS errors with `ouo.exception.fatal=true`, crash marker on next launch | SDK, automatic | Loki |
| `HTTP <METHOD>` client spans for every `fetch`, `traceparent` + `baggage` to your backend | SDK, automatic | Tempo |
| `http.request.failed` on 5xx / network failure | SDK, automatic | Loki |
| `navigation` events | you call `rum.trackNavigation` or wire `navigationStateListener` | Loki |
| custom events, handled errors, user id | you call `rum.addEvent`, `rum.captureError`, `rum.setUser` | Loki |
| screenshot frames at 1 Hz plus one per touch, redacted on the device, gzip JSON chunks | native `OuoReplay` module, automatic once `replay.enabled: true` | the collector's replay receiver (`:4319/v1/replay/chunks`), then rum-api's replay store |

Every request above carries `Authorization: Basic base64("<project id>:<project token>")`
(ADR-0007). The collector's `basicauth` extension checks the credential, its rate limiter and body
limits apply, a `resource` processor stamps `ouo.project.id` from the authenticated user name, and
the pipelines export to Tempo and Loki; replay chunks take the `ouoreplay` receiver and exporter to
rum-api's internal chunk sink. rum-api folds the Loki events into session records (`healthy` /
`errored` / `crashed`), and the Grafana app plugin (`ouo-rum-app`) lists them and plays the frames.

---

## 2. Mac setup: Xcode 27, simulator, CocoaPods, Node

Do these once.

### 2.1 Xcode 27

Install Xcode 27 from the App Store (App Store > search "Xcode" > Get). It is about 3 GB to
download and 12 GB installed. Then open it once from `/Applications`; the first launch accepts
the licence through the GUI and installs its bundled tools.

Install the iOS 27 platform and simulator runtime: Xcode > Settings > Components > iOS 27
(about 8 GB, separate from the Xcode download). The command line equivalent:

```bash
xcodebuild -downloadPlatform iOS
```

Point the command line tools at the full Xcode. Either the system-wide way:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

or, without `sudo`, per shell (verified in `kb/xcode-setup.md`: `xcodebuild`, `xcrun` and
`swift test` all pick up the full Xcode with this variable):

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

If `xcodebuild` complains that the first launch has not run:

```bash
xcodebuild -runFirstLaunch
```

Check:

```bash
xcodebuild -version
```

```bash
xcrun --sdk iphonesimulator --show-sdk-path
```

Note: Xcode 27 has no `Simulator.app` under `Contents/Developer/Applications`. The simulator
device window is `/Applications/Xcode.app/Contents/Applications/DeviceHub.app`;
`npx expo run:ios` opens it for you. `xcrun simctl` works headless without it.

### 2.2 CocoaPods

```bash
brew install cocoapods
```

CocoaPods refuses to run in a terminal that is not UTF-8. If `pod --version` prints a
"requires your terminal to be using UTF-8 encoding" warning, export this (add it to
`~/.zshrc`):

```bash
export LANG=en_US.UTF-8
```

```bash
pod --version
```

### 2.3 Node 24 and Watchman

The SDK's `package.json` requires Node >= 24 (`engines`). Check:

```bash
node --version
```

Watchman is optional; Metro falls back to its own file watcher. If you want it:

```bash
brew install watchman
```

### 2.4 The ouo stack

From the ouo checkout (full steps in `00-stack.md`):

```bash
docker compose -f deploy/docker/compose.yaml up -d
```

An empty OTLP logs request with the development credential must answer `200`; the same request
without `-u` answers `401` (that is the collector's `basicauth` extension):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u demo:pt_dev_demo_0000000000000000 -X POST -H 'content-type: application/json' -d '{}' localhost:4318/v1/logs
```

Port and project note. The ports in `deploy/docker/.env.example` are the defaults (`4318` the
collector's OTLP/HTTP, `4319` its replay receiver, both published on all interfaces because they
are the public ingest; `8081` demo backend, `3000` Grafana; rum-api's `8080` is on loopback for
the `curl` checks in section 7.1 and never for apps) and the stack ships a development project:
id `demo`, token `pt_dev_demo_0000000000000000` (a line in the collector's htpasswd).
`examples/mobile/app.config.ts` falls back to the same values, so with a stock stack you do not
need to pass anything. If you moved ports or changed the project in a gitignored
`deploy/docker/.env`, copy `examples/mobile/.env.example` to `examples/mobile/.env` and set
`EXPO_PUBLIC_OTLP_ENDPOINT`, `EXPO_PUBLIC_OUO_PROJECT_ID`, `EXPO_PUBLIC_OUO_PROJECT_TOKEN` and
`BACKEND_URL` there; Expo CLI loads that file into `process.env` before it evaluates
`app.config.ts`. The commands below pass the values explicitly anyway so it is obvious where
they go. For your own deployment, the id and token come from the project's line in the
collector's htpasswd (`deploy/docker/collector/projects.htpasswd` locally, a Secret in
Kubernetes); the token is public by design, so putting it in the app bundle is expected.

---

## 3. Get the SDK into your app

`@ouo/react-native` 0.2.0 is packaged for npm (`npm pack --dry-run -w sdk/react-native` lists
`dist/`, `ios/` with the vendored Swift sources, `android/`, `expo-module.config.json`) but not
published yet. Until it is, you consume it from a local checkout of this repository through an
npm `file:` link, exactly like `examples/mobile` does.

### 3.1 Build the SDK once

In the ouo checkout (npm workspaces live at the repo root):

```bash
npm install
```

```bash
npm run -w sdk/react-native build
```

`build` runs two things (`npm pack` runs it too, through `prepack`): `scripts/sync-ios.mjs` copies the Swift sources of `sdk/ios/Sources`
into `sdk/react-native/ios/OuoReplayCore` and `sdk/react-native/ios/OuoReplay` (gitignored
copies; CocoaPods can only glob files under a podspec's own directory, so the Swift package
outside the npm package cannot be referenced directly), then `tsup` bundles `src/` into
`dist/index.js` (CommonJS, every `@opentelemetry/*` package inlined; `react`, `react-native`
and `@react-native-async-storage/async-storage` stay external). Re-run it after every change to
the SDK; Metro follows the symlink but reads `dist/`.

### 3.2 Install packages in your app

Run these inside your Expo app (Expo SDK 57, React Native 0.86, React 19 is what the reference
app uses).

```bash
npm install ../path/to/ouo/sdk/react-native
```

That writes `"@ouo/react-native": "file:../path/to/ouo/sdk/react-native"` into your
`package.json` and creates the symlink `node_modules/@ouo/react-native`. The SDK: OTel
sessions, errors, fetch tracing, and the Expo native module for replay.

```bash
npx expo install @react-native-async-storage/async-storage
```

Peer dependency of the SDK. It persists the session record, the anonymous user id and the
crash marker under the keys `ouo.session`, `ouo.user`, `ouo.crash`, so the next launch can
end the previous session with the right reason.

```bash
npx expo install expo-constants
```

Reads `Constants.expoConfig.version` (becomes `service.version`, the version dimension of the
health percentages) and `Constants.expoConfig.extra` (collector URL, project id and token,
backend URL) in `src/rum.ts`.

```bash
npx expo install expo-device
```

Optional. Fills `device.model.identifier`, `device.model.name`, `device.manufacturer`,
`os.name`, `os.version` on the resource. Without it the SDK still sets `os.name` / `os.version`
from `Platform`.

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

Optional. Only if you use react-navigation and want the one-line `navigationStateListener`
helper. Any other router works through `rum.trackNavigation(path)`.

`expo-modules-core` (the Expo module API the native bridge is written against) comes with
`expo`; it is an optional peer of the SDK, nothing to install.

### 3.3 Metro config for the `file:` link (ref file)

`examples/mobile` is not an npm workspace: it has its own `package.json` and lockfile, and
Metro has to be told how to serve a package that lives outside the app. Copy
`examples/mobile/metro.config.js` to your app root and change only `sdkRoot` to your relative
path. Full file:

```js
// Metro config for consuming @ouo/react-native through a `file:` link (a symlink into
// ../../sdk/react-native). See kb/otel-react-native.md.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, "../../sdk/react-native");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The SDK's peer dependencies must resolve to THIS app's copies, never to the SDK's own
// devDependencies (sdk/react-native/node_modules holds a second react-native for its tests)
// or to the monorepo root node_modules.
const PEERS = ["react", "react-native", "@react-native-async-storage/async-storage", "promise", "expo-modules-core"];

const config = getDefaultConfig(projectRoot);

// 1. Metro only serves files under its watch folders; the symlink target lives outside the app.
config.watchFolders = [...(config.watchFolders ?? []), sdkRoot];

// 2. Never crawl or bundle the SDK's node_modules.
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  new RegExp(`^${escape(path.join(sdkRoot, "node_modules"))}/.*`),
];

// 3. Redirect the SDK's peer imports to the app's node_modules (hierarchical lookup stays on
//    for everything else, so packages nested by npm, e.g. expo/node_modules/expo-asset, still resolve).
const appIndex = path.join(projectRoot, "index.ts");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromSdk = context.originModulePath.startsWith(sdkRoot + path.sep);
  const isPeer = PEERS.some((p) => moduleName === p || moduleName.startsWith(`${p}/`));
  if (fromSdk && isPeer) {
    return context.resolveRequest({ ...context, originModulePath: appIndex }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
```

The three parts, in words: `watchFolders` (Metro serves only files under its watch folders and
the symlink target is outside the app), `blockList` (never crawl the SDK's own `node_modules`,
which holds a second `react-native` for Vitest), `resolveRequest` (the SDK's imports of
`react`, `react-native`, async-storage, `promise` and `expo-modules-core` are re-resolved from
your app's `index.ts`, otherwise you get two Reacts and hook errors, or "Requiring unknown
module expo-modules-core"). If your entry file is not `index.ts`, change `appIndex`.

Symlink gotcha already handled inside the SDK: with a `file:` link, Metro resolves bare
`require("expo-modules-core")` from the SDK's real path and fails even though the native
module is registered. `sdk/react-native/src/replay.ts` therefore reads
`globalThis.expo.modules.OuoReplay` first and only falls back to `requireNativeModule`.

### 3.4 How the native module gets into your Xcode project

Nothing to do by hand; this is how it works so you can debug it:

- `sdk/react-native/expo-module.config.json` declares the package as an Expo module:
  `apple.modules: ["OuoReplayModule"]`, `apple.swiftModuleName: "OuoReactNative"`, an Android
  class that is a no-op stub.
- Expo autolinking scans `node_modules` for packages with that file (it follows the symlink;
  verified with `npx expo-modules-autolinking resolve -p apple`) and picks up **every**
  `*.podspec` in `sdk/react-native/ios/`: `OuoReplayCore.podspec` (pure Swift core, links
  `z`), `OuoReplay.podspec` (UIKit capture, depends on Core), `OuoReactNative.podspec`
  (`OuoReplayModule.swift`, depends on `ExpoModulesCore` and `OuoReplay`). Three `:path` pods
  land in your Podfile through `use_expo_modules!`.
- The Swift sources those podspecs glob are the copies made by `scripts/sync-ios.mjs` in
  step 3.1, so **build the SDK before `pod install`**, or the pods are empty.

---

## 4. Ref files: copy these as they are

Copy from `examples/mobile/` into the same relative place in your app.

| File | Purpose |
|---|---|
| `examples/mobile/metro.config.js` | Metro config for the `file:` link (inlined above, change `sdkRoot`) |
| `examples/mobile/app.config.ts` | Expo config: bundle id, version from `APP_VERSION`, collector URL and project credential from env, the UIScene plugin |
| `examples/mobile/plugins/withUIScene.js` | Config plugin that makes the app launch on iOS 27 |
| `examples/mobile/src/rum.ts` | SDK initialisation (the one file you edit) |

### 4.1 `examples/mobile/app.config.ts`

Change `name`, `slug` and `ios.bundleIdentifier` to yours. Keep `plugins` and `extra`.

```ts
import type { ExpoConfig } from "expo/config";

/**
 * APP_VERSION switches `service.version` so the health split by version has data:
 *   APP_VERSION=2.4.0 npx expo start --ios
 * EXPO_PUBLIC_OTLP_ENDPOINT is the collector's OTLP/HTTP base URL (ADR-0007: the collector is the
 * only edge; the SDK derives the replay receiver on port 4319 from port 4318), EXPO_PUBLIC_OUO_PROJECT_ID
 * and EXPO_PUBLIC_OUO_PROJECT_TOKEN the project credential (sent as HTTP Basic); all three default to
 * the stock compose stack and its development project. BACKEND_URL is the demo backend.
 * From the iOS Simulator `localhost` reaches the Mac; a physical device needs the Mac's LAN IP.
 */
const config: ExpoConfig = {
  name: "mobile-store",
  slug: "mobile-store",
  version: process.env.APP_VERSION ?? "2.3.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "dev.ouo.mobilestore",
  },
  android: {
    package: "dev.ouo.mobilestore",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  web: { favicon: "./assets/favicon.png" },
  // iOS 27 requires the UIScene life cycle; Expo 57's template does not add it yet.
  plugins: ["./plugins/withUIScene.js"],
  extra: {
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:8081",
    otlpEndpoint: process.env.EXPO_PUBLIC_OTLP_ENDPOINT ?? "http://localhost:4318",
    projectId: process.env.EXPO_PUBLIC_OUO_PROJECT_ID ?? "demo",
    projectToken: process.env.EXPO_PUBLIC_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    environment: process.env.OUO_ENV ?? "local",
  },
};

export default config;
```

The env variables are read when Expo evaluates the config, so set them on the `npx expo
run:ios` / `npx expo start` / `npx expo prebuild` command line. `Constants.expoConfig.extra`
then carries them into the JS bundle. The defaults are the stock ports and the stock
development project; put your own values in `examples/mobile/.env` (gitignored, template in
`.env.example`) if you do not want to pass them every time. (`EXPO_PUBLIC_*` variables are also
inlined by Metro wherever `process.env.EXPO_PUBLIC_OTLP_ENDPOINT` appears in app code; the
reference app reads them through `extra` so there is one path for all settings.)

### 4.2 `examples/mobile/plugins/withUIScene.js`

Why it exists: iOS 27 traps at launch inside
`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` when an app has no scene
manifest and scene delegate; a second launch of the same build shows a black window. Expo SDK
57 ships `ExpoAppSceneDelegate` but its prebuild template does not wire it up yet. This config
plugin adds the `UIApplicationSceneManifest` to `Info.plist`, writes `SceneDelegate.swift`,
registers it in the Xcode project, and makes the generated `AppDelegate` conform to
`ExpoReactNativeFactoryProvider` instead of creating the window itself. It runs on every
`npx expo prebuild`. Remove it when the Expo template adopts scenes.

```js
// Expo config plugin: adopt the UIScene life cycle on iOS.
//
// iOS 27 traps at launch unless the app has a scene manifest and a scene delegate
// (crash in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Expo SDK 57 ships
// `ExpoAppSceneDelegate` but its prebuild template does not wire it up yet, so this plugin:
//   1. adds UIApplicationSceneManifest to Info.plist,
//   2. writes SceneDelegate.swift (subclass of ExpoAppSceneDelegate) and adds it to the target,
//   3. makes AppDelegate conform to ExpoReactNativeFactoryProvider and stops it from creating the
//      window itself (the scene delegate does that and starts React Native into it).
// Remove this plugin once the Expo template adopts scenes. See kb/xcode-setup.md.
const { withInfoPlist, withAppDelegate, withXcodeProject, withDangerousMod, IOSConfig } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SCENE_DELEGATE = `internal import Expo
import UIKit

/// Scene delegate required by iOS 27. All work happens in the Expo base class.
class SceneDelegate: ExpoAppSceneDelegate {}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return c;
  });
}

function withSceneDelegateFile(config) {
  config = withDangerousMod(config, [
    "ios",
    async (c) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(c.modRequest.projectRoot);
      const file = path.join(c.modRequest.platformProjectRoot, projectName, "SceneDelegate.swift");
      fs.writeFileSync(file, SCENE_DELEGATE);
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(c.modRequest.projectRoot);
    const relPath = `${projectName}/SceneDelegate.swift`;
    if (!c.modResults.hasFile(relPath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relPath,
        groupName: projectName,
        project: c.modResults,
      });
    }
    return c;
  });
}

function withSceneAwareAppDelegate(config) {
  return withAppDelegate(config, (c) => {
    let src = c.modResults.contents;
    if (!src.includes("ExpoReactNativeFactoryProvider")) {
      src = src.replace(
        "class AppDelegate: ExpoAppDelegate {",
        'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {\n  // UIScene life cycle (plugins/withUIScene.js): the scene delegate creates the window.\n  var reactNativeFactoryModuleName: String { "main" }'
      );
    }
    const windowBlock = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
    if (windowBlock.test(src)) {
      src = src.replace(windowBlock, "    // Window creation and startReactNative moved to SceneDelegate (UIScene life cycle).\n");
    }
    c.modResults.contents = src;
    return c;
  });
}

module.exports = function withUIScene(config) {
  return withSceneAwareAppDelegate(withSceneDelegateFile(withSceneManifest(config)));
};
```

### 4.3 `examples/mobile/src/rum.ts`

This is the file you edit. Full reference version:

```ts
import { initRUM, type RUM } from "@ouo/react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

interface Extra {
  backendUrl: string;
  /** Collector OTLP/HTTP base URL (ADR-0007); replay chunks go to the same host on port 4319. */
  otlpEndpoint: string;
  /** Project credential (HTTP Basic: id is the user name, token the password). Public by nature; the stock compose stack ships this development project. */
  projectId: string;
  projectToken: string;
  environment: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const config: Extra = {
  backendUrl: extra.backendUrl ?? "http://localhost:8081",
  otlpEndpoint: extra.otlpEndpoint ?? "http://localhost:4318",
  projectId: extra.projectId ?? "demo",
  projectToken: extra.projectToken ?? "pt_dev_demo_0000000000000000",
  environment: extra.environment ?? "local",
};

/** `service.version` is the app version from app.config.ts (APP_VERSION env). */
export const appVersion = Constants.expoConfig?.version ?? "0.0.0";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const rum: RUM = initRUM({
  endpoint: config.otlpEndpoint,
  // replayEndpoint is derived: http://localhost:4318 -> http://localhost:4319 (ADR-0007 section 6).
  projectId: config.projectId,
  projectToken: config.projectToken,
  service: { name: "mobile-store", version: appVersion, environment: config.environment },
  tracing: { propagateTo: [new RegExp(`^${escapeRegExp(config.backendUrl)}`)] },
  device: {
    ...(Device.modelId ? { modelIdentifier: String(Device.modelId) } : {}),
    ...(Device.modelName ? { modelName: Device.modelName } : {}),
    ...(Device.manufacturer ? { manufacturer: Device.manufacturer } : {}),
    ...(Device.osName ? { osName: Device.osName } : {}),
    ...(Device.osVersion ? { osVersion: Device.osVersion } : {}),
  },
  // Native session replay (ADR-0006): needs the development build (npx expo run:ios); a no-op
  // in Expo Go and on web. Chunks go to `${replayEndpoint}/v1/replay/chunks` with the Basic credential.
  // The demo opts out of label masking (maskText: false) so replays are readable; text inputs
  // stay masked (maskInputs defaults to true), as do images and web views. The promo field is
  // additionally marked testID="ouo-mask" and the product title testID="ouo-unmask".
  replay: { enabled: true, maskText: false },
  debug: __DEV__,
});

export const shortId = (id: string): string => id.slice(0, 8);
```

---

## 5. Instrument your app

> **Important: we do this ourselves.** The SDK does not patch your entry file or your
> component tree. You import `src/rum.ts` first thing in the entry file, you wrap the root in
> `RUMProvider`, you forward navigation changes, and you decide what replay masks. Everything
> else (sessions, errors, crashes, fetch spans, frames) is automatic after `initRUM`.

### 5.1 Call `initRUM` before the first render

The global error handler and the `fetch` wrapper must exist before anything in your app runs.
`examples/mobile/index.ts`:

```ts
// The SDK must initialise before the first render so the global error handler and the
// fetch wrapper are in place for everything the app does.
import "./src/rum";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
```

`initRUM` returns the same instance on repeated calls (hot reload resumes the session);
`getRUM()` returns it from anywhere. It throws a `TypeError` naming the option when `endpoint`,
`projectId` or `projectToken` is missing or empty, so a misconfigured build fails at startup
instead of getting `401` on every export.

### 5.2 Every `initRUM` option (verified in `sdk/react-native/src/types.ts`)

| Option | What it does | Default |
|---|---|---|
| `endpoint` | Collector OTLP/HTTP base URL (ADR-0007). The SDK posts to `${endpoint}/v1/traces` and `${endpoint}/v1/logs`. Requests to the ingest URLs are never traced. | required |
| `replayEndpoint` | Base URL of the collector's replay receiver; chunks go to `${replayEndpoint}/v1/replay/chunks`. | `endpoint` with port 4318 replaced by 4319, else `endpoint` itself |
| `projectId` | User name of the HTTP Basic credential (`Authorization: Basic base64("<projectId>:<projectToken>")`) sent on every OTLP export and replay upload. `initRUM` throws without it. | required |
| `projectToken` | Password of the Basic credential. Public by nature; `initRUM` throws without it. | required |
| `service.name` | `service.name` resource attribute, the service filter in rum-api and Grafana. | required |
| `service.version` | `service.version`: the app version; the version dimension of the health percentages. Pass `Constants.expoConfig.version`. | required |
| `service.environment` | `deployment.environment.name`. | required |
| `tracing.propagateTo` | URL prefixes (RegExp or exact string) that receive `traceparent` and `baggage` (`session.id`, `user.id`, `ouo.platform=mobile`). Other hosts still get a client span, no headers. | `[]` |
| `tracing.ignoreUrls` | URLs never traced (the derived ingest URLs are always ignored). | `[]` |
| `session.inactivityTimeoutMs` | No activity for this long ends the session (`inactivity`). | 30 min |
| `session.maxDurationMs` | Hard cap (`max_duration`). | 4 h |
| `session.backgroundTimeoutMs` | Background longer than this ends the session on foreground (`background`) and a new one starts. | 30 s |
| `user.id` | Initial user id; otherwise an anonymous persisted id. `rum.setUser` changes it later. | anonymous |
| `device.*` | `modelIdentifier`, `modelName`, `manufacturer`, `osName`, `osVersion` (from `expo-device`). | from `Platform` |
| `errors.consoleErrors` | Report `console.error` calls as handled, non-fatal exceptions. | `true` |
| `errors.fatalFlushTimeoutMs` | How long a fatal error waits for the crash marker and the flush before the previous handler (red box / native crash) runs. | 2000 |
| `storage` | AsyncStorage-compatible object. | `@react-native-async-storage/async-storage` |
| `debug` | Log SDK decisions with the `[ouo]` prefix (`console.log` / `console.warn`, never `console.error`). | `false` |
| `replay` | See below. | off |

`replay` options (`ReplayOptions`, forwarded one to one to the native `start` as
`NativeStartOptions`, together with `sessionId`, `projectId` and `projectToken`):

| Option | What it does | Default |
|---|---|---|
| `enabled` | Starts the native recorder. Silently off in Expo Go, on web and in tests (a debug warning explains why). | `false` |
| `frameInterval` | Seconds between timer frames. | `1` |
| `maskText` | Black out labels and React Native `<Text>` (`UILabel`, `RCTTextView`, `RCTParagraphComponentView`, `RCTParagraphTextView`, the iOS 26+ bar item wrapper). Does **not** govern inputs. | `true` |
| `maskInputs` | Black out text inputs (`UITextField`, `UITextView`, `RCTUITextField`, `RCTUITextView`, `RCTTextInputComponentView`). | `true` |
| `maskImages` | Black out image views that hold an image (`UIImageView`, `RCTImageView`, `RCTImageComponentView`). Empty image views (bar backgrounds) are not masked. | `true` |
| `maskWebViews` | Black out `WKWebView`. | `true` |

Not exposed through JS (Swift `OuoReplayConfig` only, for native apps): `flushInterval` 5 s,
`maxFramesPerChunk` 10, `jpegQuality` 0.5, `maxLongestSide` 1000 px,
`maxTouchCapturesPerSecond` 4, `maskClasses`.

The default is privacy first: everything that can carry user content is black until you opt in.
The reference app sets `maskText: false` so replays are readable and keeps inputs, images and
web views masked.

### 5.3 Per-view opt-in and opt-out of redaction

Set `testID` (React Native's `accessibilityIdentifier`) on any view:

- `testID="ouo-mask"`: the view is redacted whatever its class; one rectangle covers its
  subtree. `examples/mobile/src/screens/CheckoutScreen.tsx` puts it on the promo `TextInput`.
- `testID="ouo-unmask"`: the view and its whole subtree stay visible whatever the options say.
  `examples/mobile/src/screens/ProductScreen.tsx` puts it on the product title.

Both work with any combination of the `mask*` options. Subclasses match through their
superclass chain; hidden views, alpha <= 0.01 and views outside the window are skipped;
rectangles are clipped to the window and merged when they overlap.

### 5.4 Wrap the root and forward navigation

`examples/mobile/App.tsx`, trimmed to the SDK-related lines:

```tsx
import { RUMProvider, navigationStateListener } from "@ouo/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { LogBox } from "react-native";
import { rum } from "./src/rum";

// LogBox's own renderer throws in the iOS 27 dev client and its toast covers the bottom buttons.
// Set EXPO_PUBLIC_QUIET_LOGBOX=1 when starting Metro to silence it (dev builds only).
if (__DEV__ && process.env.EXPO_PUBLIC_QUIET_LOGBOX === "1") {
  LogBox.ignoreAllLogs(true);
}

const onStateChange = navigationStateListener(rum);

export default function App() {
  return (
    <RUMProvider rum={rum}>
      <NavigationContainer onReady={() => rum.trackNavigation("/Products")} onStateChange={onStateChange}>
        {/* your navigator */}
      </NavigationContainer>
    </RUMProvider>
  );
}
```

- `RUMProvider` is a plain `flex: 1` `View` with `onTouchStart` calling `rum.recordActivity()`;
  touches bubble through it. Without it only navigation, fetch and foreground count as activity.
- `navigationStateListener(rum)` turns react-navigation state into `navigation` events with
  `url.path` like `/Products/Product` and `ouo.navigation.from`; no event when the path did not
  change. With another router call `rum.trackNavigation("/Screen")` yourself.

### 5.5 The runtime API you call

```ts
rum.setUser({ id: "user-1" });                  // user.id on every later signal; can arrive late
rum.captureError(err, { screen: "Cart" });      // exception, fatal=false, handled=true
rum.addEvent("cart.added", { "product.id": "p-1" }); // custom event, ouo.event.custom=true
rum.trackNavigation("/Cart");                   // navigation event + activity
rum.recordActivity();                           // what RUMProvider does on touch
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
rum.session.id(); rum.session.userId(); rum.session.previousId();
await rum.ready;                                // persisted state read, session.start emitted
await rum.flush();                              // spans, log records and replay chunks
```

### 5.6 What is automatic

- **Sessions** (`src/session/manager.ts`): a cold start creates a new session synchronously
  and emits `session.start` once the previous run's record was read; that record gets a
  `session.end` with reason `crash` (crash marker present), `inactivity`, `max_duration`,
  `background` (killed while backgrounded past 30 s) or `terminated`. `AppState` `background`
  stamps the time; `active` after more than `backgroundTimeoutMs` ends the session and the next
  activity starts a new one, which the native recorder is told about (`sessionDidRotate`, chunk
  `seq` restarts at 0). Every span and log record carries `session.id`, `user.id`,
  `ouo.user.anonymous`, `ouo.platform=mobile`, `service.version`, `session.previous_id`.
- **Errors** (`src/errors/install.ts`): `ErrorUtils.setGlobalHandler` reports `exception` with
  `ouo.exception.fatal = isFatal`, `ouo.exception.handled = false`; a fatal one writes the crash
  marker, flushes within `fatalFlushTimeoutMs`, then lets the previous handler run (red box in
  dev, native crash in release). Unhandled promise rejections (Hermes tracker) and
  `console.error` are non-fatal.
- **Network** (`src/network.ts`): `globalThis.fetch` is wrapped; one `CLIENT` span
  `HTTP <METHOD>` per request with `http.request.method`, `url.full`, `server.address`,
  `http.response.status_code`; `http.request.failed` event on 5xx or a network failure (not on
  4xx, not on abort). The exporter uses the unwrapped `fetch.__original`.
- **Replay** (`src/replay.ts` + native): once `replay.enabled` is true and the native module is
  present, frames at `frameInterval` plus one per touch `began` / `ended` (at most 4 per
  second) are captured from the key window with `drawHierarchy`, redaction rectangles are
  painted black on the device, unchanged frames are dropped (16x16 grayscale hash), and chunks
  go out every 5 s or 10 frames or on pause / background / rotation / flush as gzip JSON to the
  collector's replay receiver with headers `Authorization: Basic …`, `x-ouo-session-id` and
  `x-ouo-seq`. Background stops the timer and flushes; foreground sends a `resume` frame.

---

## 6. Build and run on the simulator

Replay is native code, so Expo Go cannot run it: you need a development build.

### 6.1 Generate the native project

From your app folder:

```bash
npx expo prebuild --platform ios
```

This (re)generates `ios/` (gitignored in the reference app: `/ios` in
`examples/mobile/.gitignore`), applies `withUIScene.js`, and runs `pod install` at the end.
Warning: prebuild rewrites `ios/`; even without `--clean` it deletes `ios/Pods` and the
`.xcworkspace`, so if you passed `--no-install` or `pod install` failed, run it yourself:

```bash
cd ios && LANG=en_US.UTF-8 pod install && cd ..
```

`pod install` must list `OuoReplayCore`, `OuoReplay` and `OuoReactNative`. If they are empty
or missing, you forgot `npm run -w sdk/react-native build` (step 3.1). Re-run prebuild after
changing `app.config.ts` or the SDK's Swift sources (`--clean` to start over).

### 6.2 Pick and boot a simulator

```bash
xcrun simctl list devices available
```

```bash
xcrun simctl boot "iPhone 18 Pro"
```

Opening the device window by hand (Xcode 27 ships it as DeviceHub; `npx expo run:ios` opens
it for you, so this is optional):

```bash
open /Applications/Xcode.app/Contents/Applications/DeviceHub.app
```

### 6.3 Build, install and start Metro

One command does all three (build with xcodebuild, boot the simulator if needed, install the
app, start Metro):

```bash
EXPO_PUBLIC_OTLP_ENDPOINT=http://localhost:4318 EXPO_PUBLIC_OUO_PROJECT_ID=demo EXPO_PUBLIC_OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000 BACKEND_URL=http://localhost:8081 npx expo run:ios --device "iPhone 18 Pro"
```

`--device` takes a simulator name or UDID (`npx expo run:ios --help`). Without it Expo picks a
booted or default simulator. The first build takes several minutes.

Port collision to expect: Metro listens on `8081` by default, and so does the demo backend
in the stock compose stack. Expo CLI notices the port is busy and offers the next one; say yes,
or pass `--port 8082` yourself. The app's `BACKEND_URL` stays `http://localhost:8081` (that is
the Go backend); only Metro moves.

Later runs, when the native project has not changed, only need Metro and the already installed
dev client:

```bash
EXPO_PUBLIC_OTLP_ENDPOINT=http://localhost:4318 EXPO_PUBLIC_OUO_PROJECT_ID=demo EXPO_PUBLIC_OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000 BACKEND_URL=http://localhost:8081 EXPO_PUBLIC_QUIET_LOGBOX=1 npx expo start
```

Then open the app on the simulator. `EXPO_PUBLIC_QUIET_LOGBOX=1` silences LogBox, whose own
renderer throws in the Expo 57 dev client on iOS 27 (the SDK reports that throw as a non-fatal
exception, so a quiet LogBox also keeps your sessions `healthy`).

Second app version for the health split by version:

```bash
APP_VERSION=2.4.0 EXPO_PUBLIC_OTLP_ENDPOINT=http://localhost:4318 EXPO_PUBLIC_OUO_PROJECT_ID=demo EXPO_PUBLIC_OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000 BACKEND_URL=http://localhost:8081 npx expo run:ios
```

The simulator shares the Mac's network namespace, so `localhost` inside the app is the Mac.

### 6.4 Read the logs

JS side (`debug: __DEV__`): Metro's terminal prints `[ouo] ...` lines:
`[ouo] shims {...}`, `[ouo] @ouo/react-native@0.2.0 initialised {endpoint, traces, logs,
replayChunks, replayEndpointDerived, projectId, projectToken: "pt_dev_d…", ...}`, `[ouo] session
ready <id>`, `[ouo] replay: started {endpoint, ...}`, `[ouo] event navigation {...}`. A `401`
from the collector shows up as `[ouo:otel] export response failure (status: 401)`: wrong project
id or token. If replay is off you get one
`[ouo] replay: native module OuoReplay unavailable (...)` with the underlying error and the
list of registered native modules.

Native side: the Swift logger (`sdk/ios/Sources/OuoReplayCore/Clock.swift`, `ReplayLogger`)
uses `NSLog` with the prefix `[ouo replay]`, enabled when `debug` is true. Swift `print` does
not reach the unified log, `NSLog` does. Verified in `kb/ios-replay.md`:

```bash
xcrun simctl spawn booted log show --last 2m --predicate 'process == "mobilestore"' | grep "ouo replay"
```

Live stream of the same (same predicate, `log stream` instead of `log show`; expected to work,
not verified in this repo):

```bash
xcrun simctl spawn booted log stream --predicate 'process == "mobilestore" AND eventMessage CONTAINS "[ouo replay]"'
```

Replace `mobilestore` with your target name (the `name` in `app.config.ts` without the dash;
the Xcode scheme and workspace in `ios/` carry it). Lines to expect: `frame timer ... redacted
rects`, `queued session=... seq=0`, `uploaded seq=0`, and the diagnostic
`redaction: unmatched content-like classes [...]` when a view class draws text that no rule
covers.

---

## 7. How telemetry reaches the collector

Since ADR-0007 the collector (`ouo-collector`, a custom OpenTelemetry Collector distribution) is
the only public ingest. Its `basicauth` extension checks the project credential on every request,
`ouoratelimit` and the body limits apply, a `resource` processor stamps `ouo.project.id` from the
authenticated user name, and the standard pipelines export to Tempo, Loki and Mimir. Replay
chunks enter through the `ouoreplay` receiver on its own port (4319) and leave through the
`ouoreplay` exporter to rum-api's internal chunk sink. rum-api, Loki, Tempo and Mimir are never
published for apps; Grafana is the only other public service.

```
 iOS Simulator (same network namespace as the Mac)              Docker (deploy/docker/compose.yaml)
 +-----------------------------------------------+     +------------------------------------------------------+
 |  your app                                     |     |  ouo-collector (public ingest, ADR-0007)             |
 |  @ouo/react-native (JS, Hermes)               |     |   :4318 otlp receiver (basicauth, body limit, CORS)  |
 |    POST {endpoint}/v1/traces ---------------------->|     ouoratelimit -> resource: ouo.project.id=<user>  |
 |    POST {endpoint}/v1/logs   ---------------------->|       -> tempo :4317 (spans)                         |
 |    Authorization: Basic b64(projectId:token)  |     |       -> loki  :3100 (events)                        |
 |    endpoint = http://localhost:4318           |     |       -> mimir :9009 (metrics, not from RN)          |
 |                                               |     |   :4319 ouoreplay receiver (same auth, 8 MiB limit)  |
 |  OuoReplay (Swift, Expo module)               |     |     -> ouoreplay exporter -> rum-api (internal)      |
 |    POST {replayEndpoint}/v1/replay/chunks --------->|          POST /v1/replay/chunks + X-Ouo-Project-Id   |
 |    Authorization: Basic b64(projectId:token)  |     |          replays/<session_id>/<seq>.json.gz          |
 |    replayEndpoint = http://localhost:4319     |     |                                                      |
 |                                               |     |  rum-api :8080 (loopback only on the host)           |
 |  fetch("http://localhost:8081/api/...") ----------->|  demo backend :8081 (traceparent, baggage)           |
 +-----------------------------------------------+     |  grafana :3000  ouo-rum-app --> rum-api (read token) |
                                                       +------------------------------------------------------+
```

Where the values come from, in the reference app:

| Value | Set by | Reaches the SDK as |
|---|---|---|
| `EXPO_PUBLIC_OTLP_ENDPOINT` (env, default `http://localhost:4318`) | `app.config.ts` -> `extra.otlpEndpoint` | `initRUM({ endpoint })`; `/v1/traces`, `/v1/logs` and the replay endpoint (port 4318 -> 4319) are derived from it (`resolveEndpoints`) |
| `EXPO_PUBLIC_OUO_PROJECT_ID` (env, default `demo`) | `app.config.ts` -> `extra.projectId` | `initRUM({ projectId })`, user name of the Basic credential |
| `EXPO_PUBLIC_OUO_PROJECT_TOKEN` (env, default `pt_dev_demo_0000000000000000`) | `app.config.ts` -> `extra.projectToken` | `initRUM({ projectToken })`, password of the Basic credential; `Authorization: Basic …` on OTLP exports and replay uploads |
| `BACKEND_URL` (env, default `http://localhost:8081`) | `app.config.ts` -> `extra.backendUrl` | `tracing.propagateTo` prefix |
| `OUO_ENV` (env, default `local`) | `app.config.ts` -> `extra.environment` | `service.environment` |
| `APP_VERSION` (env, default `2.3.0`) | `app.config.ts` -> `version` | `service.version` via `Constants.expoConfig.version` |
| `EXPO_PUBLIC_QUIET_LOGBOX` (env) | read directly in `App.tsx` | not an SDK setting |

The collector's CORS allow-list only matters for browsers; a native app sends no `Origin`
header, so the Basic credential is the whole check. A missing or unknown credential is a `401` on
every export (visible as `[ouo:otel] export response failure (status: 401)` in Metro with `debug`
on); a wrong collector URL is a `404` or a network error. Behind a proxy that serves both receivers
from one host (`https://otel.example.com`, the VM install), set `EXPO_PUBLIC_OTLP_ENDPOINT` to that
host: with no port 4318 in it the SDK sends replay chunks to the same host.

Verified how: the 0.2.0 SDK was driven in Vitest against a Node stub of the collector with
`basicauth` (`sdk/react-native/test/ingest-stub.test.ts`, port 18082): `POST /v1/traces` and
`POST /v1/logs` arrive with `authorization=Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw`
(`demo:pt_dev_demo_0000000000000000`) and are accepted, a wrong token is rejected with `401`. The
Swift uploader test asserts the same header value on every chunk request including retries. The
live run against the Phase 8a collector on the simulator is the QA pass
(`agents/sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md`).

### 7.1 Verify from the terminal

rum-api is internal; the local stack publishes its `8080` on loopback so these checks work from
the Mac. When rum-api runs with `OUO_READ_TOKEN` set (the compose stack does, see
`deploy/docker/.env`), every `GET /v1/*` below needs `-H "Authorization: Bearer $OUO_READ_TOKEN"`;
add it to the `curl` commands. The app never uses these routes: its uploads go to the collector
with the project credential.

Session records (platform is `mobile`; `ouo.platform=mobile` is what the RN SDK sets):

```bash
curl -s 'localhost:8080/v1/sessions?from=now-1h&platform=mobile' | jq '.sessions[] | {session_id, service_version, status, end_reason, has_replay, replay_kind, replay_frame_count}'
```

Health split by version:

```bash
curl -s 'localhost:8080/v1/stats/health?from=now-1h&platform=mobile' | jq .buckets
```

One session with its timeline and traces (the id is in the reference app's header badge):

```bash
curl -s 'localhost:8080/v1/sessions/<session id>' | jq '.timeline[] | {ts, type, name}'
```

Replay meta (`kind: "frames"`, a growing `chunk_count`):

```bash
curl -s 'localhost:8080/v1/sessions/<session id>/replay' | jq
```

Raw events in Loki (stream labels are `service_name`, `event_name`, `ouo_platform`,
`deployment_environment_name`; `session_id` is structured metadata):

```bash
curl -s -G 'localhost:3100/loki/api/v1/query_range' --data-urlencode 'query={ouo_platform="mobile", event_name=~".+"}' --data-urlencode 'since=1h' --data-urlencode 'limit=50' | jq '.data.result[] | {stream: .stream.event_name, n: (.values | length)}'
```

Traces in Tempo for a session:

```bash
curl -s -G 'localhost:3200/api/search' --data-urlencode 'q={ span.session.id = "<session id>" }' | jq '.traces[] | {traceID, rootServiceName, rootTraceName}'
```

rum-api caches Tempo results per session for 60 s, so `trace_count` can read 0 for a minute
after the first spans arrive. Wait, then re-query.

### 7.2 Verify in Grafana

Open `http://localhost:3000/a/ouo-rum-app/sessions` (admin / admin), filter platform
`mobile`, open your session: the timeline shows `session.start`, `navigation`, `exception`,
`http.request.failed` and custom events, the traces panel links into Tempo, and the replay panel
mounts the frame player (`replay_kind: "frames"`) with play / pause, a scrubber and touch
markers that fade over 500 ms. Masked views are solid black.

---

## 8. Quick walk through the code

Read in this order.

**The app**

1. `examples/mobile/index.ts`: imports `./src/rum` before `registerRootComponent`, nothing else.
2. `examples/mobile/src/rum.ts`: the one `initRUM` call; collector URL, project id and token
   from `expo-constants`, device attributes from `expo-device`, `replay: { enabled: true, maskText: false }`.
3. `examples/mobile/App.tsx`: `RUMProvider`, `navigationStateListener`, the LogBox switch, a
   header badge that polls `rum.session.id()` every second so you can see rotations.
4. `examples/mobile/src/api.ts`: plain `fetch` to the backend; the SDK adds `traceparent` and
   `baggage`, the app only adds `x-user-id`.
5. `examples/mobile/src/screens/CheckoutScreen.tsx` (promo input, `ouo-mask`),
   `ProductScreen.tsx` (title, `ouo-unmask`), `ChaosScreen.tsx` (one button per
   classification row: slow request, 500, handled error, unhandled rejection, fatal error from
   a `setTimeout` so it reaches `ErrorUtils` with `isFatal = true`, `console.error`, custom
   event, set user, flush, replay pause/resume).

**The React Native SDK (`sdk/react-native/src`)**

6. `index.ts`: `initRUM` wires everything: configuration checks (`endpoint`, `projectId`,
   `projectToken`), shims, session manager, OTLP log and trace exporters with the Basic
   `Authorization` header and batch processors, the session span/log processors, the propagator,
   fetch instrumentation, error capture, AppState listener, navigation tracker, the replay
   controller. `endpoints.ts`: `resolveEndpoints` derives `/v1/traces`, `/v1/logs` and the replay
   endpoint (4318 -> 4319) from `endpoint` / `replayEndpoint`; `basicAuthorization` builds the
   header with the SDK's own base64 encoder (no `btoa` on every RN runtime).
7. `shims.ts`: installs `performance.timeOrigin` and a UTF-8 `TextEncoder` only when missing
   (without `timeOrigin` every OTel timestamp is `NaN`).
8. `session/manager.ts`: the session rules (cold start, previous run, background, timers,
   persistence under `ouo.session` / `ouo.user` / `ouo.crash`); `onRotate` feeds replay.
9. `errors/install.ts` and `errors/classify.ts`: `ErrorUtils`, Hermes rejection tracker,
   `console.error`; `exception.*` and `ouo.exception.fatal|handled|kind` attributes.
10. `network.ts`: the `fetch` wrapper, client spans, header injection for `propagateTo`,
    `http.request.failed`.
11. `navigation.ts`, `appstate.ts`, `provider.tsx`: route path from react-navigation state,
    background/foreground bridge, the touch-counting root view.
12. `telemetry/resource.ts`, `telemetry/correlation.ts`, `telemetry/events.ts`,
    `telemetry/propagator.ts`: resource attributes (`ouo.platform=mobile`, `os.*`,
    `device.*`), the per-signal session attributes, events as OTel log records with
    `event.name`, `traceparent` + `baggage` injection.
13. `replay.ts`: loads the native module from `globalThis.expo.modules.OuoReplay`, passes the
    replay endpoint, the project id and the token to native `start`, and exposes a controller
    that is a no-op when replay is off or the module is absent.

**The Expo module bridge (`sdk/react-native`)**

14. `expo-module.config.json`, `ios/OuoReactNative.podspec`, `ios/OuoReplay.podspec`,
    `ios/OuoReplayCore.podspec`, `scripts/sync-ios.mjs`: how autolinking finds three pods and
    where their Swift files come from.
15. `ios/OuoReplayModule.swift`: the `Module` named `OuoReplay`; `start(endpoint, options)`
    builds an `OuoReplayConfig` (rejects an empty `projectId` or `projectToken` with
    `ERR_OUO_REPLAY_CREDENTIAL`), the other functions forward to the Swift package. The session id
    lives in a lock-protected box because the JS side pushes rotations down.

**The Swift package (`sdk/ios/Sources`)**

16. `OuoReplay/OuoReplay.swift`: public entry point (`start`, `pause`, `resume`, `isRecording`,
    `flush`, `sessionDidRotate`, `stop`), everything hops to the main thread.
17. `OuoReplay/OuoReplayConfig.swift`: every knob (`projectId` and `projectToken` first among
    them, `authorization` computed from both), including the ones JS does not expose.
18. `OuoReplay/ReplayRecorder.swift`: the 1 Hz timer in `.common` run-loop mode, touch-triggered
    captures, background/foreground, the chunk builder and uploader.
19. `OuoReplay/ScreenCapturer.swift`: `drawHierarchy` at a render scale that caps the longest side
    at 1000 px, black fills from the planner, JPEG 0.5, the 16x16 thumbnail for dedupe.
20. `OuoReplay/ViewTreeBuilder.swift`: walks `UIView.subviews` into a platform-neutral `ViewNode`
    tree (class, superclass chain, frame, alpha, hidden, accessibility identifier).
21. `OuoReplay/TouchObserver.swift`: an observing `UIGestureRecognizer` that never interferes.
22. `OuoReplayCore/RedactionPlanner.swift`: the four class groups, `ouo-mask` / `ouo-unmask`,
    clipping and merging. Pure Swift, fully unit tested on macOS.
23. `OuoReplayCore/ChunkBuilder.swift`, `SeqStore.swift`, `FrameDeduper.swift`, `Gzip.swift`,
    `ChunkUploader.swift`, `Models.swift`, `Clock.swift`: chunk open/flush rules, `seq`
    persistence in `UserDefaults`, FNV-1a dedupe, RFC 1952 gzip through zlib, in-order upload
    with the Basic `Authorization` header (`ChunkUploader.basicAuthorization`), 3 attempts and a
    2 MB queue, the spec's JSON keys, the `[ouo replay]` logger.

---

## Appendix A. Run on your own iPhone

Your Mac and your iPhone signed in with the same Apple ID is enough: Xcode signs development
builds with a free "Personal Team" (apps expire after 7 days and are limited to a few per
device, which is fine for development).

### A.1 Prepare the phone and Xcode

1. Connect the phone with a cable. For Wi-Fi debugging later: Xcode > Window > Devices and
   Simulators > select the phone > tick "Connect via network".
2. On the phone enable Developer Mode: Settings > Privacy & Security > Developer Mode > on,
   then restart when asked.
3. In Xcode > Settings > Accounts, add your Apple ID if it is not there.
4. Open the generated workspace:

```bash
open ios/*.xcworkspace
```

5. Select the app target > Signing & Capabilities > tick "Automatically manage signing" and
   pick your Personal Team. Change the bundle identifier: `dev.ouo.mobilestore` is the reference
   app's id and a bundle id must be unique per team, so set your own (for example
   `dev.<you>.<app>`) in `app.config.ts` `ios.bundleIdentifier` too, otherwise the next
   prebuild puts the old one back. To keep the team across prebuilds, Expo's config has
   `ios.appleTeamId` (present in `@expo/config-types` `ExpoConfig`; its effect on the generated
   project is **not verified in this repo**).

### A.2 Build to the device

```bash
EXPO_PUBLIC_OTLP_ENDPOINT=http://<mac-lan-ip>:4318 BACKEND_URL=http://<mac-lan-ip>:8081 npx expo run:ios --device
```

`--device` without a value lists connected devices and simulators and lets you pick the phone;
pass its name to skip the prompt. The first launch on the phone fails with "Untrusted
Developer": Settings > General > VPN & Device Management > your Apple ID > Trust, then open the
app again.

### A.3 Can the app still reach the collector on the Mac?

Yes, as long as the phone and the Mac are on the same Wi-Fi / LAN and the app uses the Mac's
LAN address instead of `localhost`. On the phone `localhost` is the phone itself; in the
simulator it was the Mac. Nothing else in the pipeline changes: the SDK posts OTLP to
`{endpoint}/v1/...` on port 4318 and replay chunks to the same host on port 4319 (derived; one
variable covers both), and compose publishes exactly those two collector ports on all
interfaces. rum-api stays on loopback and never needs to be reachable from the phone.

Get the Mac's LAN IP (`en0` is Wi-Fi on most Macs; use `en1` or the interface shown in System
Settings > Network if empty):

```bash
ipconfig getifaddr en0
```

Or use the Bonjour name instead of the IP (`<hostname>.local`, resolved by mDNS on the same
network):

```bash
scutil --get LocalHostName
```

Pass it to the app. The variables are the ones `app.config.ts` reads:

```bash
EXPO_PUBLIC_OTLP_ENDPOINT=http://192.168.1.23:4318 BACKEND_URL=http://192.168.1.23:8081 npx expo start
```

OTLP (`:4318/v1/traces`, `:4318/v1/logs`) and replay chunks (`:4319/v1/replay/chunks`) both go
to that address; the project id and token stay the same.

Things that can block it, and what to do:

- **Metro must also be on the LAN.** `npx expo start` defaults to `--host lan`, so the dev
  client on the phone loads the bundle from `http://<mac-lan-ip>:<metro-port>`; keep that
  (Metro moves off `8081` when the demo backend holds it, see section 6.3). If your
  Wi-Fi isolates clients from each other, `npx expo start --tunnel` gets Metro through ngrok,
  but that does nothing for OTLP and replay: those still need a direct route to the Mac.
- **macOS firewall.** System Settings > Network > Firewall: if it is on, allow incoming
  connections for Docker (the app that owns the published ports 4318, 4319 and 8081) or turn
  "Block all incoming connections" off. Not verified in this repo.
- **App Transport Security (ATS).** The generated `examples/mobile/ios/mobilestore/Info.plist`
  (verified) has `NSAppTransportSecurity` with `NSAllowsArbitraryLoads: false` and
  `NSAllowsLocalNetworking: true`. Apple documents `NSAllowsLocalNetworking` as the exception
  for local-network resources, and Expo relies on it to load the JS bundle from Metro at the
  Mac's LAN IP over plain HTTP, so plain-HTTP ingest to the same address is expected to work.
  Whether it covers every private IP range is **not verified in this repo**. If the device log
  shows "App Transport Security has blocked a cleartext HTTP" for the collector, add this to
  `app.config.ts` for development builds and prebuild again:

  ```ts
  ios: {
    bundleIdentifier: "dev.<you>.<app>",
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
  ```

  Do not ship `NSAllowsArbitraryLoads` in a release build; put the collector behind HTTPS
  instead (the VM and Kubernetes installs do: `otel.<domain>` routes `/v1/replay/*` to 4319 and
  everything else to 4318, so one `EXPO_PUBLIC_OTLP_ENDPOINT=https://otel.<domain>` covers both).
- **Local Network privacy prompt.** iOS asks once whether the app may "find and connect to
  devices on your local network" the first time it talks to a LAN address; if the user taps
  "Don't Allow", nothing reaches the Mac (Settings > Privacy & Security > Local Network to fix).
  The generated plist in this repo has no `NSLocalNetworkUsageDescription` (verified absent);
  add `ios.infoPlist.NSLocalNetworkUsageDescription: "Sends diagnostics to the development
  server"` so the prompt explains itself. Behaviour of the prompt itself is **not verified in
  this repo**.
- **CORS is irrelevant.** The collector's origin allow-list is for browsers; the native app
  sends no `Origin`, the Basic credential is the whole check.
- **USB instead of Wi-Fi** (brief, optional, **not verified in this repo**): `iproxy` from
  `libimobiledevice` (`brew install libimobiledevice`) forwards a Mac port to a port on the
  phone over usbmuxd, which is the wrong direction for an app that must reach the Mac. The
  practical USB route is the phone's Personal Hotspot over USB: the Mac joins the phone's
  network and gets an address (typically `172.20.10.x`) that the app can use in
  `EXPO_PUBLIC_OTLP_ENDPOINT` / `BACKEND_URL`.

Verify from the Mac exactly as in section 7.1; the session record will show `os.name iOS`,
the real `device.model.identifier` (for example `iPhone17,1`) and `replay_kind: "frames"`.

---

## Appendix B. Gotchas collected while verifying this repo

- `expo prebuild` deletes `ios/Pods` and the `.xcworkspace` even without `--clean`; run
  `pod install` again if prebuild did not.
- Build the SDK (`npm run -w sdk/react-native build`) before `pod install`; the pods glob
  vendored copies of `sdk/ios/Sources` that only the build writes. Edit `sdk/ios`, never the
  copies.
- A second `react-native` under `sdk/react-native/node_modules` (for Vitest) must never be
  bundled; the Metro `blockList` and the peer redirect handle it.
- `CI=1` makes Expo/Metro disable file watching; restart `expo start` after rebuilding the SDK.
- Inside CocoaPods the Swift module and the enum share the name `OuoReplay`; the bridge calls
  `OuoReplay.start(...)` unqualified on purpose.
- The back chevron in the navigation bar is a `UIImageView`, so it stays black with
  `maskImages: true` even when `maskText: false`. Not a bug.
- After tapping, wait about 7 s (5 s chunk flush plus upload) before expecting the frame in
  rum-api.
- `401` on every export: `EXPO_PUBLIC_OUO_PROJECT_ID` / `EXPO_PUBLIC_OUO_PROJECT_TOKEN` do not
  match a line in the collector's htpasswd (`deploy/docker/collector/projects.htpasswd`; the
  user name is the project id). The SDK never retries a `401`; fix the values and restart Metro
  (they are baked into `extra` when the config is evaluated). Check the pair from the Mac with
  the `curl -u` line in section 2.4.
- Replay chunks fail with a connection error while OTLP works: the replay receiver is a second
  port. With `EXPO_PUBLIC_OTLP_ENDPOINT=http://<host>:4318` the SDK derives `http://<host>:4319`;
  make sure 4319 is published (compose does) or pass `replayEndpoint` in `src/rum.ts`.
- Scrolling must stay smooth while recording (10 to 30 ms per frame on a simulator); if it
  stutters, raise `frameInterval`.
