# Source maps: readable stacks from minified web and React Native apps

A production bundle turns `RenderBomb` in `src/components/ChaosPanel.tsx:18` into `at o (https://shop.example/assets/index-B3x9.js:40:1234)`. With source maps uploaded to ouo, the session page and rum-api's API show the original file, line, column and function, and the source line that threw. The raw stack stays available behind a toggle. The design is [ADR-0011](adr/0011-source-maps-and-symbolication.md).

## How it works

1. Your build emits source maps.
2. `ouo-sourcemaps inject` gives every bundle a **debug id** (`//# debugId=<uuid>`) and a one-line snippet that tells `@ouo11y/browser` the id at runtime. The same id goes into the map.
3. `ouo-sourcemaps upload` sends the maps to rum-api with the project's **upload token**. Then you deploy the bundles, without the maps.
4. When an error happens, the SDK adds `ouo.exception.debug_ids` (script URL to debug id) to the exception record. The raw stack goes to Loki unchanged.
5. When the session is read, rum-api finds each frame's map by its debug id, or by `service.version` + the script's URL path when there is none, and returns a `symbolicated` stack next to the raw one.

Maps uploaded after an error still apply: symbolication happens on read.

## Setup

### 1. Give the project an upload token (operator)

The upload token is a **secret**, like a deploy key, kept in your CI. It is not the public `projectToken` that ships in the bundle. Configure one per project in rum-api:

```bash
# environment
OUO_UPLOAD_TOKENS=web-store:ut_9f3c...,shop:ut_71aa...
```

```yaml
# or config.yaml
projects:
  web-store:
    upload_token: "${OUO_UPLOAD_TOKEN_WEB_STORE}"
```

The local stack (`deploy/compose`, `ouo-env`) ships `demo:ut_dev_demo_0000000000000000`.

**Network:** uploads go to rum-api, which is never public (ADR-0007). CI reaches it over your private network: a self-hosted runner, a VPN, or `kubectl port-forward svc/ouo-rum-api 8080` with the Helm chart (its README, "Source maps and dSYMs: upload tokens", shows the tokens and the port-forward). If your CI runs on hosted runners and cannot reach rum-api, see [Limits](#limits).

### 2. Install the CLI and the SDK

```bash
npm install @ouo11y/browser
npm install --save-dev @ouo11y/sourcemaps
```

Pass the same version to the SDK (`service.version`) and to `--release`. The release index then serves bundles that have no debug id.

### 3. Build with maps, inject, upload, delete

Add the step after your build and before your deploy:

```bash
npx ouo-sourcemaps inject dist
npx ouo-sourcemaps upload dist \
  --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" \
  --project web-store --release "$APP_VERSION" --delete-after
```

`--delete-after` removes the `.map` files once every upload succeeded, so you never serve your sources. Use `--url-prefix /static/` when the output directory is served under a path, so that `dist/js/a.js` is `/static/js/a.js` in the browser.

## Bundlers

### Vite

```ts
// vite.config.ts
export default defineConfig({
  build: { sourcemap: "hidden" }, // maps on disk, no sourceMappingURL in the bundle
});
```

```json
// package.json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "ouo-sourcemaps inject dist && ouo-sourcemaps upload dist --release $npm_package_version --delete-after"
  }
}
```

`OUO_SOURCEMAPS_URL` and `OUO_UPLOAD_TOKEN` come from the CI environment. `examples/ouo-web` does this in `scripts/run.sh`.

### webpack

```js
// webpack.config.js
module.exports = {
  mode: "production",
  devtool: "hidden-source-map",
  output: { publicPath: "/assets/" },
};
```

```bash
webpack && ouo-sourcemaps inject dist && \
  ouo-sourcemaps upload dist --url-prefix /assets/ --release "$APP_VERSION" --delete-after
```

### Next.js

```js
// next.config.js
module.exports = { productionBrowserSourceMaps: true };
```

The browser bundles are under `.next/static`, served at `/_next/static`:

```bash
next build && ouo-sourcemaps inject .next/static && \
  ouo-sourcemaps upload .next/static --url-prefix /_next/static/ --release "$APP_VERSION" --delete-after
```

Run `inject` before `next start` or before you copy `.next` into your image. The server bundles (`.next/server`) are not browser code and need no upload.

### Rollup / Vite with native debug ids

Rollup's `output.sourcemapDebugIds: true` already writes `//# debugId=`. `ouo-sourcemaps inject` keeps that id and adds only the runtime snippet, so run it anyway.

## React Native (Hermes)

A Hermes release build prints `at chargeCard (address at index.android.bundle:1:11313)`: the column is a bytecode offset, and the file is the same name for the store build and for every over-the-air (OTA) bundle of that version. So React Native needs the debug id even more than the web: it is the only thing that tells two OTA bundles of `1.4.0` apart.

How the pieces fit:

1. **Metro adds the debug id** while it writes the bundle (`@ouo11y/sourcemaps/metro`). Hermes compiles the bundle to bytecode right after Metro, so nothing can be appended later. The snippet holds the id as one string literal, which survives `hermesc`, and registers it at runtime in `globalThis.__ouoDebugIds`.
2. **The build composes the maps.** Metro's map (bundle to sources) and hermesc's map (bytecode to bundle) become the map of the bytecode. The Gradle plugin, `react-native-xcode.sh` and hot-updater do this themselves; `ouo-sourcemaps compose` does it for a hand-written pipeline.
3. **`ouo-sourcemaps upload`** reads the id from the map, or from the bundle itself (text or bytecode), and uploads the map under it.
4. **`@ouo11y/react-native`** adds `ouo.exception.debug_ids` (`{"app:///index.android.bundle": "<id>"}`) to every JavaScript exception: uncaught and fatal, unhandled rejections, `console.error`, `captureException`, and errors forwarded from Sentry. It reads the id when the error is captured.
5. **rum-api** looks the map up by that id first, then by `service.version` + bundle name, and reads a Hermes column as the bytecode offset it is.

Native crashes (signals, NSException, Java) have no JavaScript frames; they use dSYMs ([symbolication.md](symbolication.md)).

### 1. Add the debug id in Metro

Install the CLI in the app: `npm install --save-dev @ouo11y/sourcemaps`.

Bare React Native (`react-native bundle`, the Gradle plugin, Xcode, hot-updater's `bare` plugin all read `metro.config.js`):

```js
// metro.config.js
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const { withOuoDebugIds } = require("@ouo11y/sourcemaps/metro");

module.exports = withOuoDebugIds(mergeConfig(getDefaultConfig(__dirname), {}));
```

Expo (SDK 50 or later; `expo export`, `expo export:embed`, EAS Build and EAS Update use Expo's own serializer, which already computes a debug id per bundle):

```js
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const { ouoExpoDebugIdPlugin } = require("@ouo11y/sourcemaps/metro");

module.exports = getDefaultConfig(__dirname, {
  unstable_beforeAssetSerializationPlugins: [ouoExpoDebugIdPlugin],
});
```

`examples/ouo-mobile/metro.config.js` does this. The snippet goes on the line of Metro's prelude (bare) or right after it (Expo), runs before any module, and adds about 200 bytes of bytecode. Development bundles get no id.

An app that already uses Sentry's Metro plugin (`withSentryConfig`, `getSentryExpoConfig`) can keep it: the SDK reads Sentry's registry when no ouo id is registered, and the CLI finds Sentry's id in the bytecode. Use one of the two, not both.

### 2. Upload after a release build

Pass the app's version (the SDK's `service.version`) as `--release`. With debug ids it only labels the upload.

Android (Gradle plugin, `./gradlew assembleRelease` or `bundleRelease`). The bundle is bytecode, its composed map is in another folder:

```bash
npx ouo-sourcemaps upload \
  --bundle android/app/build/generated/assets/react/release/index.android.bundle \
  --sourcemap android/app/build/generated/sourcemaps/react/release/index.android.bundle.map \
  --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" --release "$APP_VERSION"
```

iOS (Xcode, `react-native-xcode.sh`). Xcode writes a map only when `SOURCEMAP_FILE` is set; add it to `ios/.xcode.env` (the "Bundle React Native code and images" phase reads it):

```bash
# ios/.xcode.env
export SOURCEMAP_FILE="$DERIVED_FILE_DIR/main.jsbundle.map"
```

Then, in a Run Script phase after that one, or from CI with the paths of the build:

```bash
npx ouo-sourcemaps upload \
  --bundle "$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle" \
  --sourcemap "$DERIVED_FILE_DIR/main.jsbundle.map" \
  --url "$OUO_SOURCEMAPS_URL" --token "$OUO_UPLOAD_TOKEN" --release "$APP_VERSION"
```

Expo prebuild projects run the same Gradle plugin and Xcode script, so the same two commands apply. The maps never ship in the app: they are build outputs, not bundled assets.

### Without the Metro plugin: bundle, inject, compile, compose

A pipeline that runs the steps itself can inject between Metro and hermesc instead:

```bash
npx react-native bundle --platform android --dev false --entry-file index.js \
  --bundle-output out/index.android.bundle --sourcemap-output out/index.android.bundle.map
npx ouo-sourcemaps inject out                         # snippet + id into the JavaScript and its map
node_modules/hermes-compiler/hermesc/osx-bin/hermesc -O -emit-binary -output-source-map \
  -out out/index.android.bundle.hbc out/index.android.bundle   # linux64-bin on Linux
npx ouo-sourcemaps compose out/index.android.bundle.map out/index.android.bundle.hbc.map \
  -o out/index.android.bundle.hbc.map
npx ouo-sourcemaps upload out --release "$APP_VERSION"  # uploads the .hbc and its composed map
```

`hermesc` is `node_modules/hermes-compiler/hermesc/<os>-bin/hermesc` from React Native 0.83 on, `node_modules/react-native/sdks/hermesc/<os>-bin/hermesc` before. When a folder holds both `index.android.bundle` and `index.android.bundle.hbc` with their maps, `upload` sends only the bytecode's map, under the name `index.android.bundle`. `inject` refuses a bundle that is already bytecode without an id: inject before hermesc.

### OTA updates

Every OTA bundle has its own debug id, so its own map, even though all of them are `index.android.bundle` of the same store version. Upload each bundle's map when you publish it; rum-api keeps every one, and an error from a device that still runs an older OTA bundle resolves against that bundle's map.

**hot-updater.** Wrap the build plugin, like hot-updater's own Sentry plugin does. The upload runs after each platform's build, before the bundle is deployed; a failed upload stops the deploy (`failOnError: false` only warns):

```ts
// hot-updater.config.ts
import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";
import { withOuoSourcemaps } from "@ouo11y/sourcemaps/hot-updater";

export default defineConfig({
  build: withOuoSourcemaps(bare({ enableHermes: true, sourcemap: true }), {
    release: process.env.APP_VERSION, // the store version the update targets
    deleteAfter: true, // keep the maps out of the OTA bundle
  }),
  // storage, database, ...
});
```

`url`, `token` and `project` default to `OUO_SOURCEMAPS_URL`, `OUO_UPLOAD_TOKEN` and `OUO_PROJECT_ID`. `metro.config.js` needs `withOuoDebugIds` (step 1): hot-updater runs `react-native bundle`, which reads it.

**expo-updates (EAS Update).** With `ouoExpoDebugIdPlugin` in `metro.config.js`, export with maps, upload, then publish the same export:

```bash
npx expo export --platform all --source-maps --output-dir dist
npx ouo-sourcemaps upload dist/_expo/static/js --release "$APP_VERSION" --delete-after
npx eas-cli update --skip-bundler --input-dir dist --branch production --message "$MESSAGE"
```

**CodePush-style tools** (`react-native bundle` + Hermes into a folder that is then released): run the pipeline above, upload the folder, then release it.

## What you see

- **Session page** (plugin): an exception with mapped frames shows a `source mapped` badge. Its stack opens on the original frames and source lines, and an **Original / Raw** toggle switches to the stack as recorded. Frames without a map are greyed and keep their minified position.
- **rum-api**: exceptions in `GET /v1/sessions/{id}` and `/logs` carry `symbolicated` (`status` `ok` / `partial` / `no_maps`, frames with `generated` and `original` positions, source context). `POST /v1/symbolicate` maps any stack (see `services/rum-api/README.md`, section Source maps).
- **Loki** keeps `exception.stacktrace` as the browser sent it, plus `ouo.exception.debug_ids`.

## Checking an upload

```bash
curl -s -H "Authorization: Bearer $OUO_READ_TOKEN" "$RUM_API/v1/sourcemaps?project=web-store" | jq '.sourcemaps[0]'
```

If a stack still shows minified frames:

- **No `ouo_exception_debug_ids` on the record.** The deployed bundle was not injected (inject runs after every build), or the error came from a script you did not upload, such as a third-party CDN script.
- **`no_map` with a debug id.** Nothing was uploaded under that id for this project. Check the token's project and the upload output.
- **`no_map` without a debug id.** The release fallback needs the same `--release` as the SDK's `service.version`, and the same URL path (check `--url-prefix`).
- **Function names.** The function name comes from the original source around the line when the map embeds `sourcesContent`, which is the default in Vite, webpack and esbuild. Otherwise it comes from the caller's call site. That second method is a heuristic and can name a wrapper.

## Retention and deletion

Maps are kept `retention.sourcemaps` (default 90 days) from their upload, per project overridable. A re-upload restarts the clock. Keep it at least your log retention, or older errors lose their maps. rum-api warns at start-up when it is shorter. `DELETE /v1/admin/projects/{project}` deletes the project's maps with its data ([data lifecycle](operations/data-lifecycle.md)).

## Limits

- Uploads go to rum-api directly. A public upload path through `ouo-collector`, for CI on hosted runners, is planned (checklist N41).
- React Native without a debug id (no Metro plugin, no `inject`) falls back to release + bundle name, which holds one map: the last OTA bundle uploaded for a store version replaces the one before, and errors from devices on an older OTA bundle map to the wrong lines.
- Expo's `expo export` for web and server bundles, and the JSON-list output of its static export, are not React Native bundles: the web ones take the [web setup](#3-build-with-maps-inject-upload-delete).
- RAM bundles (`x_facebook_offsets`) and Hermes bytecode bundles split into segments are not supported; React Native has not built them by default for years.
- One map is limited to 64 MiB decompressed (`MAX_SOURCEMAP_BYTES`).
