# Changelog: OuoReplay (Swift package `ouo11y-ios`)

Published to the read-only mirror `github.com/ouo11y/ouo11y-ios` with the plain tag `<version>`
when `ios-v<version>` is pushed here. `version.txt` holds the version (SwiftPM has none); the
release workflow refuses a tag that differs. Policy: [`docs/releasing.md`](../../docs/releasing.md).
New entries are written by release-please from conventional commits (`feat(ios): ...`).

## Unreleased

### Added

- `OuoVitals` and `OuoVitalsCore`: app start (process start from `sysctl`, image load time for
  prewarmed launches, cold or warm per runtime) and `CADisplayLink` frame counters (total, slow,
  frozen, delay) for the mobile vitals spec (checklist G2).

## 0.2.0 (not yet tagged)

First mirrored release. Products `OuoReplay` (UIKit capture) and `OuoReplayCore` (models,
chunking, upload), iOS 15+.

### Compatibility

- Frames replay chunks, `schema_version` 1, `POST /v1/replay/chunks` on the collector's replay
  receiver with HTTP Basic project credentials (ADR-0007). Needs collector >= 0.2.0 and
  rum-api >= 0.2.0; see [`docs/compatibility.md`](../../docs/compatibility.md).
