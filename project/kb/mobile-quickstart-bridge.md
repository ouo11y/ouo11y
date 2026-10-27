# Mobile quickstart on the Sentry bridge: what a reader's Expo app needs (M1, 2026-10-28)

Question: what is the smallest `@sentry/react-native` setup that gives a reader healthy / errored /
crashed sessions, one trace from a tap to an OpenTelemetry API, errors with stacks and readable
logs through the ouo bridge, on Expo 57 and the iOS 27 simulator? Answered while building
`examples/quickstarts-mobile/tiny-shop-mobile` (N58). Background: `sentry-react-native-demo.md`,
`sentry-bridge-examples.md`.

## Setup that works

- Collector 0.4.0 (`ghcr.io/ouo11y/collector:latest` on 2026-10-28) has `ouosentry` and the
  `routing` connector. A trimmed config is enough: `ouosentry` into `traces`, a `logs/sentry`
  pipeline with no processors into `routing/sentry` (no `batch` before `resource/project`: the
  project is in the client context), `logs` with `resource/project` + `transform/events`.
  `memory_limiter` and rate limits are not needed for a local stack.
- `Sentry.init`: `dsn` with the bridge host, `tracesSampleRate: 1`, `tracePropagationTargets:
  [API_URL]`, `propagateTraceparent: true`, `enableLogs: true`, `reactNavigationIntegration()`
  registered in `NavigationContainer.onReady`. No `autoInitializeNativeSdk` needed in a Debug build
  without `SENTRY_ENVIRONMENT` at prebuild (no `sentry.options.json`).
- Expo plugin `["@sentry/react-native", { "disableAutoUpload": true }]` writes
  `export SENTRY_DISABLE_AUTO_UPLOAD=true` into the build phases. Prebuild warns
  `Missing config for organization, project`: harmless with uploads off.
- `EXPO_PUBLIC_*` variables (inlined by Metro, read from `app/.env`) replace `expo-constants`
  `extra` for the DSN and API URL: one dependency less, but Metro must restart to pick a change.
- `startNewTrace` is not re-exported by `@sentry/react-native` 8.32.0: add `@sentry/core` at the
  same version (10.76.2) and wrap each API tap in
  `startNewTrace(() => Sentry.startSpan({ op: "ui.action", forceTransaction: true }, fn))`.

## Versions

- `create-expo-app@latest` (2026-10-28) scaffolds **Expo SDK 58** (React Native 0.88). Pin with
  `--template blank-typescript@sdk-57` for Expo 57.0.31 / React Native 0.86.3. The template also
  writes `AGENTS.md`, `LICENSE` and `.claude/settings.json`.
- `@sentry/react-native` 8.32.0 is `latest`; it bundles sentry-cocoa 9.31.0.

## What the reader sees (Debug build, Metro)

- Sentry ends a session after 30 s in the background and sends the end when the app returns. A
  JS fatal in a Debug build ends the session `crashed` (end reason `crash`), shows the red LogBox
  screen, and the app keeps running in a new session.
- Error stacks resolve to source files and lines in Debug (`ProductsScreen.tsx:48:19 [in app]`)
  without uploading source maps: Metro serves them.
- The bridge's app start for a Debug cold launch is about 25 s (the bundle download from Metro).
- rum-api counts the fatal as a crash, not an error: `errors 1 · crashes 1` for one handled error
  plus one fatal.

## Driving the simulator with real taps

The Claude Code iOS simulator tool (`tap`, `button HOME`, `screenshot`) works headless on your own
simulator. Points are 402 x 874 on an iPhone 18 Pro. Leave about 2 s between taps: a tap during a
stack transition lands on the screen underneath (one run added an item twice and opened Cart on
top of Product). `xcrun simctl launch <udid> <bundle>` brings the app back to the foreground.
