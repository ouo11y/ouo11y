# Changelog: kit

npm `@ouo11y/kit`, tag `kit-v<version>`. Policy: `docs/releasing.md`. Design: `docs/adr/0025-generic-libs-clients-own-plugin-and-access.md`.

## Unreleased

## [0.2.0](https://github.com/ouo11y/ouo11y/compare/kit-v0.1.0...kit-v0.2.0) (2026-11-25)


### Added

* **kit:** play ouo-video/1 replays ([#222](https://github.com/ouo11y/ouo11y/issues/222)) ([01baec3](https://github.com/ouo11y/ouo11y/commit/01baec37594a04247fc07c3dba035af7bb8618af))

## 0.1.0 (2026-11-14)

### Added

- First release of `@ouo11y/kit`: `ReplayPlayer` (plays a Muninn manifest with chunks from a fetcher the caller supplies; stream picker, playable runs from a keyframe to a gap, NDJSON joined across chunks), `RrwebPlayer` (React wrapper over `rrweb-player`), the format seam (`formatInfo`: `rrweb/2` plays, pixel and wireframe formats are named, unknown formats are stored, not playable) and the Muninn manifest types.
