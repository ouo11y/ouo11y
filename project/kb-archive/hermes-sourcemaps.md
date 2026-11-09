# Hermes source maps and debug ids (B3, 2026-11-04)

What it takes to symbolicate React Native release stacks (Hermes bytecode, OTA bundles) in ouo. Design: [ADR-0011 section 6](../../docs/adr-archive/0011-source-maps-and-symbolication.md). User docs: [docs/sourcemaps.md, React Native](../../docs/sourcemaps.md#react-native-hermes). Web basics: [sourcemaps-symbolication.md](sourcemaps-symbolication.md).

## Hermes stack columns are bytecode offsets, 0-based

`lib/VM/JSError.cpp`, `appendBytecodeFrame`: a frame without debug info (every release build) prints `address at <sourceURL>:<segmentID + 1>:<bytecodeOffset + virtualOffset>`. Line 1 is the bytecode segment; the column is the instruction's virtual offset, the exact generated column of hermesc's `-output-source-map` (source-map columns are 0-based). Browsers print 1-based columns, so rum-api looked up `column - 1`, which for Hermes is the previous instruction: in the fixture that lands on another line or function for both frames (`TestHermesColumnIsBytecodeOffset`). A frame *with* debug info prints the JS line:column instead, without `address at`.

The React Native SDK drops `address at` when it normalises (`app:///index.android.bundle:1:11313`), so rum-api also recognises a Hermes map: `x_hermes_function_offsets`, which hermesc writes and `composeSourceMaps` keeps.

## A string literal survives hermesc, a comment does not

`//# debugId=` is gone after `hermesc -O`. A string literal is stored byte for byte in the bytecode's string table (ASCII), so the snippet writes the id as `"ouo-debug-id:<uuid>".slice(13)`; `markedDebugId` reads it back from the `.hbc` (`latin1` decode + regex). Sentry's snippet has `sentry-dbid-<uuid>` the same way. Hermes bytecode starts with `c6 1f bc 03 c1 03 19 1f`.

## The composed map loses debugId

`metro-source-map` `composeSourceMaps` builds a new map with `sources`, `sourcesContent`, `names`, `mappings`, `x_facebook_sources`, `x_hermes_function_offsets`, `x_google_ignoreList`: no `debugId`. The Gradle plugin (`BundleHermesCTask`), `react-native-xcode.sh` and hot-updater's `bare` plugin all compose with it. So the upload must read the id from the shipped bundle. hot-updater's own Sentry plugin copies `debugId` from the packager map into the `.hbc.map` for the same reason.

## Where a hook is possible

- `react-native bundle` / Gradle / Xcode / hot-updater all read `metro.config.js`. Metro's `Server` uses `serializer.customSerializer`'s map if it returns `{code, map}`, otherwise it builds the map itself from the original `prepend` modules; so a wrapper that only appends code must not shift lines. Line 1 is Metro's prelude (`var __BUNDLE_START_TIME__=...`, a `js/script/virtual` module with no mappings): code added at its end moves nothing and runs first.
- Metro 0.84 exports its internals only as `metro/private/*` (`metro/src/*` is `ERR_PACKAGE_PATH_NOT_EXPORTED`); older Metro had `metro/src`. The wrapper tries both.
- **Expo never calls a custom serializer on export.** `expo export:embed` (what Expo's Gradle and Xcode builds run) and `expo export` go through `graphToSerialAssetsAsync` (`outputMode: "static"`); the config's custom serializer only runs for dev-server requests. The hook is `getDefaultConfig(root, { unstable_beforeAssetSerializationPlugins: [plugin] })`: each plugin gets `{ graph, premodules, debugId }` and returns premodules, and Expo builds the map from that list. Expo's `debugId` is a UUID of the output file's hash; Expo writes it as `//# debugId=` and into the map itself (SDK 50+).
- `expo export:embed --config <file>` is ignored: it starts its own dev server on the project's `metro.config.js`.
- hot-updater's `bare` plugin resolves hermesc itself (`hermes-compiler` package, else `react-native/sdks/hermesc`) with no override, so a hermesc wrapper (`HERMES_CLI_PATH`, Gradle `hermesCommand`) cannot cover it. Its output folder holds `index.<platform>.bundle` (JS) + `.map` (packager) and `index.<platform>.bundle.hbc` + `.hbc.map` (composed).
- `expo export --source-maps` (EAS Update) writes `_expo/static/js/<platform>/index-<hash>.hbc` + `.hbc.map`, already composed, `debugId` set. Checked on examples/ouo-mobile (1.8 MB hbc, 4.9 MB map): the marker in the bytecode equals the map's `debugId`.

## Build output paths (React Native 0.86)

- Android, `react { }` defaults (`hermesFlags = ["-O", "-output-source-map"]`): bundle (bytecode, moved over the JS) `android/app/build/generated/assets/react/<variant>/index.android.bundle`, composed map `android/app/build/generated/sourcemaps/react/<variant>/index.android.bundle.map`, packager and compiler maps in `build/intermediates/sourcemaps/react/<variant>/`.
- iOS: no map unless `SOURCEMAP_FILE` is set (`.xcode.env` works, the phase sources it). Bundle `$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle`.
- hermesc: `node_modules/hermes-compiler/hermesc/{osx-bin,linux64-bin,win64-bin}/hermesc` from React Native 0.83, `react-native/sdks/hermesc/...` before. Bytecode version 98 for 0.86. There is no Hermes VM binary in the npm packages or the pods (`hermes-engine/destroot/bin` has `hermesc` and `hermes-lit` only), so bytecode cannot be run on the Mac without a device or simulator.

## Tooling quirks on this Mac

- `npx expo ...` from a session shell failed with npm's own `Exit prior to config file resolving / call config.load() before reading values`; `node_modules/.bin/expo` works.
- `examples/ouo-mobile` needs `sdk/react-native` built (`npm run build -w @ouo11y/react-native`) before `expo export`, or Metro cannot resolve `@ouo11y/react-native`'s `dist/index.js`.
