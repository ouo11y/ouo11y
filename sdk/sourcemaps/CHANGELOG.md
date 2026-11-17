# Changelog: sourcemaps

npm `@ouo11y/sourcemaps` (CLI `ouo-sourcemaps`), tag `sourcemaps-v<version>`. Policy: `docs/releasing.md`. Design: `docs/adr/0026-debug-files-and-erasure-without-rum-api.md`.

## Unreleased

## 0.1.0 (date set by the release PR)

### Added

- First release of `@ouo11y/sourcemaps`: the `ouo-sourcemaps` CLI injects debug ids into built JavaScript and React Native (Hermes) bundles and uploads source maps and dSYMs straight to Muninn's debug-file route (ADR-0026); Metro and hot-updater helpers.
