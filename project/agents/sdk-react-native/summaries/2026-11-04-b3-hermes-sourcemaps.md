# 2026-11-04 B3: Hermes debug ids and OTA-safe source maps

Branch `claude/b3-hermes-sourcemaps`, for JUHI (bare React Native 0.82, Hermes, `hot-updater` OTA bundles). Design: ADR-0011 section 6 (revised). Docs: `docs/sourcemaps.md` "React Native (Hermes)". Knowledge: `project/kb/hermes-sourcemaps.md`.

## What was wrong

- The RN SDK sent no `ouo.exception.debug_ids`; the release index keyed every OTA bundle of one store version under `app:///index.android.bundle`, so a later upload replaced an earlier one.
- `findArtifacts` only took `*.js|mjs|cjs`; no Hermes map composition; ADR-0011 named a `--file` flag that never existed.
- Found on the way: rum-api's frame parser rejected the RN SDK's ` [in app]` suffix, so **no RN frame was ever symbolicated**; and rum-api read every column as 1-based (`column - 1`), which for a Hermes bytecode offset is the previous instruction, often another line.

## What was done

- `@ouo11y/sourcemaps/metro` (new entry, CJS + ESM): `withOuoDebugIds(config)` wraps `serializer.customSerializer` (Metro's own from `metro/private`, or an existing one) and puts the React Native snippet at the end of Metro's prelude line (no mapping moves, runs first); `ouoExpoDebugIdPlugin` for Expo's `unstable_beforeAssetSerializationPlugins`, reusing Expo's own id. The snippet holds `"ouo-debug-id:<uuid>"` as a literal, which survives `hermesc`.
- CLI: `.bundle` / `.jsbundle` / `.hbc` artifacts (the `.hbc` wins over its JS twin, `.hbc` dropped from the uploaded name), React Native snippet in `inject` (`--react-native` for other names; bytecode without an id is refused), debug id read from the map, `//# debugId=`, or the bundle bytes (Sentry's `sentry-dbid-` too), `--bundle` / `--sourcemap` pairs, `compose` (app's `metro-source-map`, keeps the id).
- `@ouo11y/sourcemaps/hot-updater`: `withOuoSourcemaps(bare({...}), opts)` uploads each OTA bundle's composed map after the build, fails the deploy on an upload error by default, `deleteAfter` keeps maps out of the OTA zip.
- RN SDK: `src/errors/debugids.ts`, `ouo.exception.debug_ids` on every JS exception (all kinds, Sentry-forwarded too), read at capture, keys normalised like the stack; falls back to Sentry's `_sentryDebugIds`.
- rum-api: ` [in app]` accepted and kept in the rewritten stack; Hermes columns used as is for `address at` frames and for maps with `x_hermes_function_offsets`.
- `examples/ouo-mobile/metro.config.js` loads `ouoExpoDebugIdPlugin` (optional, warns when sdk/sourcemaps is not built).
- Docs: `docs/sourcemaps.md` (bare + Expo setup, Android and iOS release uploads with real paths, hand-written pipeline, hot-updater, EAS Update, CodePush, limits), ADR-0011 section 6 rewritten + consequences, `docs/specs/mobile-sdk.md` C2 debug ids, `sdk/sourcemaps/README.md`.

No new dependency: Metro internals and `metro-source-map` are resolved from the app at build time.

## Verified, and how

- Real fixture: `services/rum-api/internal/sourcemap/testdata/hermes/generate.mjs` builds two OTA bundles with `expo export:embed` (the example's config, Expo serializer + `ouoExpoDebugIdPlugin`), `hermesc -O -emit-binary -output-source-map` (hermes-compiler of RN 0.86) and `ouo-sourcemaps compose`. Deterministic (same ids on regeneration), 428 KB, no local paths.
- `go test ./...` and `go vet ./...` in services/rum-api: `TestHermesOTABundles` (two bundles on one release and one file name resolve independently by debug id, function names and source context; without ids the release fallback serves the last upload) and `TestHermesColumnIsBytecodeOffset` (offset-1 lands elsewhere for both frames, so the test would catch a regression).
- sdk/sourcemaps: 28 vitest tests (13 old, 15 new: artifacts, marker read from the fixture bytecode, inject, snippet under Hermes/JSC/V8 stack forms in `vm`, upload of bytecode, Metro wrapper, Expo plugin, compose with the real `metro-source-map`, hot-updater wrapper), `tsc --noEmit`, `tsup` build.
- sdk/react-native: 202 vitest tests (5 new in `test/debugids.test.ts`), `tsc --noEmit`.
- Bare path in a real Metro 0.84 (`metro-config` defaults, `Metro.runBuild`, no Expo): snippet at the end of the prelude line, `//# debugId=` before Metro's `sourceMappingURL`.
- Real `expo export --platform android --source-maps` of examples/ouo-mobile: `index-<hash>.hbc` + `.hbc.map`, the marker in the bytecode equals the map's `debugId`, the map is the composed Hermes map; `ouo-sourcemaps upload --dry-run` pairs them.
- Hermes column semantics from Hermes' source (`lib/VM/JSError.cpp`, `appendBytecodeFrame`), not from a running VM: there is no Hermes VM binary on this Mac.

## Not done / next agent

- See the PR for whether the simulator end-to-end run (release build of examples/ouo-mobile, thrown JS error symbolicated by rum-api) was done.
- hot-updater was not run (not installed anywhere here); `withOuoSourcemaps` follows the shape of hot-updater's own Sentry plugin (read from its source) and is tested with a stand-in build plugin.
- EAS Update `eas-cli update --skip-bundler --input-dir` was not run (needs an Expo account).
- The bare `withOuoDebugIds` depends on `metro/private/DeltaBundler/Serializers/baseJSBundle` and `metro/private/lib/bundleToString`; a Metro release that moves them fails the bundle step.
