# How vendors key, upload and resolve debug files

Checked on 2026-11-13 against vendor documentation and public source by a research pass for ADR-0022. Each line says what was verified; "not verified" means no primary source was found, not that it is false.

## Sentry

- **Key.** `sentry-cli sourcemaps inject` adds `//# debugId=` and a runtime snippet (`_sentryDebugIds`). Symbolicator looks up by debug id first, then by candidate URLs (release and dist + URL is the documented legacy method). Verified: [inject.rs](https://raw.githubusercontent.com/getsentry/sentry-cli/master/src/utils/sourcemaps/inject.rs), [lookup.rs](https://raw.githubusercontent.com/getsentry/symbolicator/master/crates/symbolicator-js/src/lookup.rs), [legacy uploading methods](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/legacy-uploading-methods/).
- **Upload.** Artifact bundles through a chunk upload and an assemble call. Verified: [upload.rs](https://raw.githubusercontent.com/getsentry/sentry-cli/master/src/utils/chunks/upload.rs).
- **When.** At processing time; the resolved frames are written into the event. The documentation says Sentry does not go back and apply source maps to earlier events. Verified: [troubleshooting](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/), [processing.py](https://raw.githubusercontent.com/getsentry/sentry/master/src/sentry/lang/javascript/processing.py).
- **Native.** ProGuard mappings are matched by a UUID the Gradle plugin generates and writes into the manifest (`io.sentry.proguard-uuid`): verified, [ProGuard](https://docs.sentry.io/platforms/android/enhance-errors/proguard/). dSYMs are matched by "debug identifiers" (UUIDs): verified, [debug information files](https://docs.sentry.io/cli/dif/); the wording `LC_UUID` is not on the page.
- **React Native.** `withSentryConfig` in `metro.config.js`; the packager map is composed with the Hermes map, the debug id copied, then uploaded. Verified: [Hermes](https://docs.sentry.io/platforms/react-native/sourcemaps/uploading/hermes/).

## Datadog

- **Key.** Debug ids are now supported and recommended (`datadog-ci sourcemaps inject`, `upload --debug-id`, datadog-ci 5.24.0 and later, browser SDK 7.6.0 and later). Service + version + minified path prefix is the alternative, and the two cannot be combined. Verified: [upload JavaScript source maps](https://docs.datadoghq.com/real_user_monitoring/guide/upload-javascript-source-maps/), [datadog-ci README](https://raw.githubusercontent.com/DataDog/datadog-ci/master/packages/base/src/commands/sourcemaps/README.md).
- **Limits.** 500 MB for a source map with its minified file, 2 GB for a dSYM (matched by UUID). Verified: the same page and [iOS error tracking](https://docs.datadoghq.com/real_user_monitoring/error_tracking/mobile/ios/).
- **When.** Not verified for JavaScript: no page read says whether errors received before the upload are unminified. For Android the documentation says traces are deobfuscated regardless of when the mapping was uploaded.
- **Android.** The Gradle plugin uploads the mapping; matched by `build_id` from plugin 1.13.0 and Android SDK 2.8.0, by service, version and variant before. Verified: [Android error tracking](https://docs.datadoghq.com/error_tracking/frontend/mobile/android/).

## PostHog

- **Key.** Its CLI injects a chunk id (`_posthogChunkIds`, `//# chunkId=`) and uploads "symbol sets". Verified: [constant.rs](https://raw.githubusercontent.com/PostHog/posthog/master/cli/src/sourcemaps/constant.rs), [upload with the CLI](https://posthog.com/docs/error-tracking/upload-source-maps/cli).
- **When and where.** The Rust service cymbal resolves frames; a map must be uploaded or publicly reachable, and cymbal fetches it in the second case. A resolved frame record is reused by later events. Verified: [cymbal README](https://raw.githubusercontent.com/PostHog/posthog/master/rust/cymbal/README.md), [stack traces](https://posthog.com/docs/error-tracking/stack-traces).
- **Not verified:** the storage tables, and whether a late upload re-resolves earlier frames. The troubleshooting page says to upload before deploying.

## Grafana Alloy `faro.receiver`

Resolves inside the collector at ingest: maps from disk by path templates with the release, then remote locations, then a download of the script's `sourceMappingURL`. It uses `github.com/go-sourcemap/sourcemap`, the parser ouo uses. Verified: [faro.receiver](https://grafana.com/docs/alloy/latest/reference/components/faro/faro.receiver/), [sourcemaps.go](https://github.com/grafana/alloy/blob/main/internal/component/faro/receiver/sourcemaps.go).

## Two facts the design leans on

- **OTel Collector HTTP servers cap a request body at 20 MiB by default** (`max_request_body_size` in `confighttp`, used by the OTLP receiver). Verified: [server.go](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/main/config/confighttp/server.go).
- **`debugId` is not in the source map specification yet.** The debug id proposal is at Stage 2 of ECMA-426. Rollup and Rolldown (`output.sourcemapDebugIds`), webpack and Rspack (`devtool` with `-debugids`) and Expo write debug ids themselves; esbuild and Metro do not. Verified: [proposal](https://raw.githubusercontent.com/tc39/ecma426/main/proposals/debug-id.md), [Rollup options](https://rollupjs.org/configuration-options/), [webpack devtool](https://webpack.js.org/configuration/devtool/). So the inject step stays.

## What ouo takes from this

All three vendors key by an id bound to the build and keep release + path as a fallback or an older method: the same as ADR-0022. All three resolve after ingest and store the result, because they group errors into issues there. ouo resolves on read, so a late upload applies, and can add ingest-time attributes later with the same library.
