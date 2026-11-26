# Changelog: rum-api

`ghcr.io/ouo11y/rum-api` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/rum-api`), tag `rum-api-v<version>`.
Policy: `docs/releasing.md`. Earlier history: the rum-api agent summaries under `project/agents/rum-api/`.

## Unreleased

## [0.7.0](https://github.com/ouo11y/ouo11y/compare/rum-api-v0.6.0...rum-api-v0.7.0) (2026-11-26)


### Added

* **deploy:** run ouo on an existing Loki/Tempo/Mimir, rum-api tenant header ([a623f8d](https://github.com/ouo11y/ouo11y/commit/a623f8d5e2b86c58d42fbec9388c128693d350ab))
* **react-native:** Hermes debug ids and OTA-safe source maps ([a30fc0c](https://github.com/ouo11y/ouo11y/commit/a30fc0cc324efd24b07bbb952738eb727b2be429))

## [0.6.0](https://github.com/ouo11y/ouo11y/compare/rum-api-v0.5.0...rum-api-v0.6.0) (2026-10-31)

### Breaking

- **Replay chunk `schema_version` 2** (ADR-0014): rum-api 0.6 reads schema 1 and 2 and, at its first
  start, writes `max_schema_version: 2` into the store's `replays/schema.json`. From then on
  rum-api 0.4 and 0.5 refuse to start on that store (exit 1, the guard of
  `docs/operations/upgrade.md` section 4); 0.3.0 and older have no guard and must never run on it.
  Do not roll back across this release. Stored chunks are not rewritten and every older replay
  still plays.

### Added

- **Frames schema 2** (mobile SDK roadmap W3, `docs/specs/mobile-replay.md`): a frame is a full
  JPEG (`jpeg`) or a list of `patches` drawn over the latest full image. Every frame is checked on
  upload: exactly one of `jpeg` and `patches`, a full image first, base64 JPEG only, patches with
  integer coordinates and a positive size inside the latest full image; anything else is a `400`,
  as are `patches` under schema 1. Video chunks stay at schema 1. Frames are stored and served as
  uploaded ([3e6afc9](https://github.com/ouo11y/ouo11y/commit/3e6afc944d019a8ba3688fa6a3e92b1d7b8168bb)).
- **Native crash symbolication from dSYM** (W7, ADR-0011 section 7, `docs/symbolication.md`):
  `PUT /v1/dsyms` with the project upload token (gzip, at most `limits.max_dsym_bytes` /
  `MAX_DSYM_BYTES`, default 512 MiB) splits a universal file into slices keyed by build UUID,
  stored next to the source maps (`sourcemaps/<project>/dsym/`, so retention, sweep and delete by
  project apply). On read, an `exception` with native frames and images gets a `symbolicated`
  stack (`function (file:line)`, inlined frames as `atos -i` prints them, a symbol-table fallback
  without DWARF); `POST /v1/symbolicate` takes the same frames and images. Upload with
  `ouo-sourcemaps upload-dsym <path>...`. New `sourcemaps.cache_bytes` / `SOURCEMAP_CACHE_BYTES`
  (default 512 MiB): the byte budget of the shared source map and dSYM cache
  ([4a3393a](https://github.com/ouo11y/ouo11y/commit/4a3393a31ecdab5aa9aaf0b77ce18406fa8389ad)).
- A mobile session whose `session.start` never arrived (a native crash in its first second) starts
  at the `ouo.session.started_at` its `session.end` carries (N52,
  [986c37a](https://github.com/ouo11y/ouo11y/commit/986c37a2c175f85c922fdc383758d0066b84b012)).

### Compatibility

- Upgrade order for schema 2: rum-api 0.6 and plugin 0.10 (most deployments: the grafana image that
  ships it) first, then collector 0.5, then the SDKs that send schema 2 (iOS 0.3, React Native 0.3).
  A plugin older than 0.10 shows patch frames as broken images.
- Storage otherwise compatible with 0.5: dSYMs are stored next to the source maps.

## [0.5.0](https://github.com/ouo11y/ouo11y/compare/rum-api-v0.4.0...rum-api-v0.5.0) (2026-10-25)


### Added

- Source maps and symbolication (ADR-0011, `docs/sourcemaps.md`): `PUT /v1/sourcemaps` with a
  per-project upload token (`projects.<id>.upload_token`, `OUO_UPLOAD_TOKENS`), maps stored per
  project next to the replays (debug-id and release + URL indexes), `GET /v1/sourcemaps`,
  `POST /v1/symbolicate`, and a `symbolicated` object on every exception of the session timeline
  and session logs (raw stack untouched). Parsed-map LRU cache, `retention.sourcemaps` swept with
  the replays, delete-by-project removes the maps. New dependency `github.com/go-sourcemap/sourcemap`.
- Funnel reports (ADR-0012, `docs/specs/funnels.md`): `POST /v1/funnels/query` counts the sessions
  that reach each step (page paths or events, in order) over a range of at most 31 days,
  `GET /v1/funnels/dropped` lists the sessions that left at a step and `GET /v1/funnels/steps`
  suggests step values, all behind the read token; results are cached per definition and range for `loki.funnel_cache_ttl`
  (`LOKI_FUNNEL_CACHE_TTL`, default `60s`, `0` disables).
- Sessions carry `device_id`, the SDK's `device.id` (the same for every session of one browser or
  install), omitted when the SDK sends none.

## 0.4.0 (2026-10-24)

### Added

- Data lifecycle (roadmap 8b, `docs/operations/data-lifecycle.md`):
  - replay retention (`retention.replays`, per project `projects.<id>.retention.replays`) enforced
    by a sweeper on both backends (expired sessions and orphan folders, idempotent, metrics
    `ouo.retention.*`), plus `ouo-retention` object tags and optional bucket lifecycle rules on S3
    (`storage.s3.lifecycle_rules`);
  - operator API behind `auth.admin_token` (`OUO_ADMIN_TOKEN`): `DELETE /v1/admin/users/{user}`,
    `DELETE /v1/admin/projects/{project}` (replays, Loki delete request, Tempo trace ids),
    `GET /v1/admin/audit`, `POST /v1/admin/retention/sweep`;
  - append-only deletion audit log (`<data dir>/audit/deletions.jsonl` with a SHA-256 chain, or
    create-only objects under `[<prefix>/]audit/` on S3); a deletion whose first entry cannot be
    written does not run;
  - server-side per-project replay sampling cap (`projects.<id>.sampling`: `session_rate`,
    `replay_rate`, `replay_on_error_rate`), the SDKs' deterministic rule (`internal/sampling`);
    a session passing either replay decision keeps its replay, so error-triggered replays survive.

- Replay chunks keep their optional `masked` flag (frames and video); `GET /v1/sessions/{id}/replay`
  serves it per chunk and as the replay's `masked` (`false` as soon as one chunk is unmasked). Chunks
  stored before this version have none. A `masked` that is not a boolean is a 400.
- `GET /v1/sessions/{id}` has `context`: the session's device, OS, app build and deployment
  environment (latest value of each over its records), for the Grafana plugin's header.
- Traces whose root span is a generic `HTTP GET` get `root_url_path` (the root's `url.path`) from a
  second, best-effort Tempo search, so the plugin can name them `GET /path`.
- Start-up schema-version guard (`docs/operations/upgrade.md` section 4): rum-api records the
  highest replay `schema_version` it reads in `replays/schema.json` (filesystem: `DATA_DIR/replays/`,
  S3: `[<prefix>/]replays/`) and exits 1 with a message naming both versions when the store was
  last opened by a rum-api that reads a newer schema. A store without the marker (0.3.0 and older)
  is adopted; nothing else is rewritten.

## 0.3.0 (2026-10-18)

First release under `ghcr.io/ouo11y/rum-api` (ADR-0009).

### Changed

- Go module path `github.com/ouo11y/ouo11y/services/rum-api`; image `ghcr.io/ouo11y/rum-api`.
- Session links point at the Grafana plugin's new ID (`/a/ouo11y-rum-app/...`).

No API, storage or configuration change: a 0.2.0 data directory, bucket and config file work
unchanged. The minor bump keeps the three images (rum-api, collector, grafana) on one version for
the first `ouo11y` release.

## 0.2.0 (2026-10-17)

First tagged image: YAML config file (`-config.file`, `-config.expand-env`) and S3 / MinIO replay
storage next to the local disk; the collector is the edge (ADR-0007), rum-api is internal.
