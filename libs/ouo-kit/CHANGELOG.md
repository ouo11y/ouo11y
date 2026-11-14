# Changelog: kit

npm `@ouo11y/kit`, tag `kit-v<version>`. Policy: `docs/releasing.md`. Design: `docs/adr/0025-generic-libs-clients-own-plugin-and-access.md`.

## Unreleased

## 0.1.0 - unreleased

### Added

- First release of `@ouo11y/kit`: `ReplayPlayer` (plays a Muninn manifest with chunks from a fetcher the caller supplies; stream picker, playable runs from a keyframe to a gap, NDJSON joined across chunks), `RrwebPlayer` (React wrapper over `rrweb-player`), the format seam (`formatInfo`: `rrweb/2` plays, pixel and wireframe formats are named, unknown formats are stored, not playable) and the Muninn manifest types.
