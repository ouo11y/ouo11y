# ADR-0011 Source maps: debug ids, maps in the rum-api bucket, symbolication on read

Status: proposed (2026-10-24). Implemented and verified on `ouo-env web-sourcemaps-fa863c` the same day. Implements A10 (web part) and part C of N36 in `project/tracker/checklist.md`.

## Context

Production web apps ship minified bundles. An exception from one reaches Loki as an OTel log record whose `exception.stacktrace` reads `at o (https://shop.example.com/assets/index-B3x9.js:1:18734)`. Nobody can act on that. The engineer needs the original file, line, column and function: `at RenderBomb (src/components/ChaosPanel.tsx:18:22)`.

Three questions decide the design: how a stack frame finds the right map, where maps live and who may write them, and when the translation runs.

Constraints already in place:

- Exceptions are OTel log records with `exception.*` attributes (semantic conventions). The record in Loki is the system of record and must stay as the SDK sent it: Loki has no update, and a raw stack is what a user can paste into another tool.
- rum-api already owns an object store (filesystem or S3 / MinIO, ADR-0003, Phase 8b) with per-project retention and delete-by-project (`docs/operations/data-lifecycle.md`).
- ADR-0007: the public project token ships in every bundle and authenticates nothing secret. It cannot authorise writes of anything that changes what other users see.
- ADR-0007 also keeps rum-api internal: the collector is the only public ingress.
- React Native (Hermes) produces source maps too, and the Sentry bridge keeps native frame addresses and `debug_meta` images (A7) for a later native symbolicator. The design must not be web-only.

## Decision

### 1. A frame finds its map by debug id, with release + URL as the fallback

**Debug id first.** The upload tool (section 3) post-processes the build output, as `sentry-cli sourcemaps inject` does:

- each `.js` / `.mjs` / `.cjs` file with a map gets a debug id, a UUID derived from the SHA-256 of the map (stable across rebuilds of the same output);
- the bundle ends with `//# debugId=<uuid>`, following the TC39 source-map debug-id proposal, and the map gets `"debugId": "<uuid>"`;
- the bundle also ends with a one-line registration snippet: `globalThis.__ouoDebugIds[new Error().stack] = "<uuid>"`. It is appended after the last line of code, so no existing mapping moves. A browser has no API that reads a script's `//# debugId` comment, so this is how the SDK learns it at runtime. Sentry uses the same mechanism (`_sentryDebugIds`).

The SDK (`exceptionAttributes` in `sdk/browser/src/errors/classify.ts`) reads `__ouoDebugIds`, takes each key's first frame URL, and adds `ouo.exception.debug_ids` to the exception record. The value is a JSON object `{ "<script url>": "<debug id>" }`, limited to the scripts the stack actually names. Bundles without the snippet send nothing extra.

Why debug ids: a release is a human label that CI often gets wrong, and the same `index-B3x9.js` path can exist in two deploys. A debug id is bound to the exact bytes. It also needs no release on the SDK.

**Fallback: release + URL path.** A map uploaded with `--release` is also indexed under `(project, release, URL path of the minified file)`, for example `(web-store, 1.4.2, /assets/index-B3x9.js)`. A frame whose script has no debug id is looked up with the record's `service.version` and its URL path. The host is ignored, so the same upload serves `localhost`, staging and production CDNs. Build tools that cannot run the inject step still work this way.

### 2. Maps are stored in the rum-api bucket, per project

They use the same backend as replays (`storage.backend`), under a sibling prefix:

```
[<prefix>/]sourcemaps/<project>/debug-id/<uuid>.map.gz            the map (gzip)
[<prefix>/]sourcemaps/<project>/debug-id/<uuid>.json              meta: release, file, size, uploaded_at
[<prefix>/]sourcemaps/<project>/release/<sha256(release)>/<sha256(path)>.map.gz  fallback index
[<prefix>/]sourcemaps/<project>/release/<sha256(release)>/<sha256(path)>.json
```

The project is the one the upload token belongs to. A symbolication request only reads the project of the exception record (`ouo.project.id`, which the collector stamps), so one project's maps never resolve another project's frames. Hashed names keep arbitrary release strings and paths out of object keys. A map is limited to 64 MiB decompressed (`limits.max_sourcemap_bytes`).

### 3. Upload: `ouo-sourcemaps` CLI, project upload token

`@ouo11y/sourcemaps` (`sdk/sourcemaps`, Node 24, no dependencies) ships the `ouo-sourcemaps` binary:

```bash
ouo-sourcemaps inject dist/                        # debug ids into bundles and maps
ouo-sourcemaps upload dist/ --url https://rum-api.internal --project web-store \
  --release 1.4.2 --token "$OUO_UPLOAD_TOKEN"      # PUT every map
```

- `inject` is idempotent. `upload` also works on maps without a debug id, in which case only the release index is written. `--delete-after` removes the `.map` files from the output so they are never deployed publicly.
- Examples for Vite (`build.sourcemap: "hidden"` and a `closeBundle` hook or a `postbuild` npm script), webpack (`devtool: "hidden-source-map"`) and Next.js (`productionBrowserSourceMaps`, `.next/static`) are in `docs/sourcemaps.md`.
- **The upload token is per project and secret:** `projects.<id>.upload_token` in rum-api's config (`OUO_UPLOAD_TOKENS=web-store:ut_...,shop:ut_...`). It is a CI secret like a deploy key. It is never the public ingest token, and the read and admin tokens do not work in its place. The endpoint is `PUT /v1/sourcemaps` with `Authorization: Bearer <upload token>`. rum-api derives the project from the token.
- **Where the endpoint lives.** Uploads come from CI, not from browsers, so in this first version they go to rum-api directly. rum-api stays off the public internet: CI reaches it over the operator's network (a self-hosted runner, a VPN, or `kubectl port-forward` in the Helm case). An operator whose CI runs on hosted runners needs a public path. The planned follow-up (N41) is a collector route, `POST /v1/sourcemaps` in `ouo-collector`, with its own authenticator for the upload tokens. It forwards to the same rum-api sink, as the replay receiver and exporter do (ADR-0007), so that collector stays the only public edge.

### 4. Symbolication on read, in rum-api, with a cache

Loki keeps the raw stack untouched. rum-api symbolicates when it serves an exception:

- `GET /v1/sessions/{id}` (timeline) and `GET /v1/sessions/{id}/logs` add a `symbolicated` object to every exception item that has a stack. It holds the frames, each with the raw and the original position, a rewritten stack string, and a status (`ok`, `partial`, `no_maps`).
- `POST /v1/symbolicate` (read token) takes `{project_id, release, stacktrace, debug_ids}` for tools and the plugin.
- The parser is `github.com/go-sourcemap/sourcemap`, the source-map v3 consumer that Grafana Alloy's Faro receiver uses (section Consequences). Function names come from the map's `names` at the caller's call site, Sentry's caller-name rule. A frame without a caller keeps its minified name.
- The cache is an LRU of parsed maps per (project, debug id or release path), 128 entries by default (`sourcemaps.cache_entries`), plus a 60 s negative cache for misses so a page of exceptions without maps costs one lookup per script. A map changes only by re-upload, which evicts it on that replica. Other replicas see the new map when the entry ages out (`sourcemaps.cache_ttl`, default 10 min).
- Original source lines (`sourcesContent`) come back as three lines of context around the frame when the map embeds them.

Why on read, not in the collector: maps uploaded after the error still apply (a late CI step, a fixed upload). The raw record stays as evidence. The collector stays stateless and needs no bucket access. Errors are far fewer than reads of a session, so the cost is small: one parse per map per replica, then lookups. Measured on an M-series Mac: ouo-web's 1 MB map parses in about 8 ms, and a lookup takes about 12 ns. The alternative, a collector processor that rewrites `exception.stacktrace` before Loki, gives Loki queries on original file names. That feature can come later as an *added* attribute, written by a processor that calls rum-api's `POST /v1/symbolicate`, without changing this store.

### 5. Retention follows Phase 8b

- `retention.sourcemaps` (`SOURCEMAP_RETENTION`), default `2160h` (90 days), is measured from the upload. A re-upload refreshes it. It should be at least `retention.logs`, because a map must outlive the errors that need it. `config.verify` warns when it is shorter. `0` keeps maps forever.
- `projects.<id>.retention.sourcemaps` overrides it per project.
- The same sweeper (`retention.sweep_interval`) deletes expired maps on both backends.
- `DELETE /v1/admin/projects/{project}` deletes the project's maps and records how many in the audit entry.

### 6. React Native / Hermes reuse the same store

A Hermes or Metro bundle map is uploaded with the same CLI and token (`ouo-sourcemaps upload --release <app version> --file index.android.bundle <map>`). It is indexed by release + bundle name, because a Hermes bytecode bundle cannot carry a JS registration snippet. Metro's `debugId` support (React Native 0.77+, which Sentry also uses) can add the debug-id index later without a store change. The RN SDK then sends `ouo.exception.debug_ids` exactly like the browser. Hermes frames carry a bytecode offset as the column (`at foo (address at index.android.bundle:1:9123)`). The frame parser recognises that form, and the lookup is the same `(line 1, column)` query against the composed Hermes map (`compose-source-maps`). The Sentry bridge (N38) can feed the same frames: Sentry's `debug_meta.images` of type `sourcemap` carry the debug id, and the bridge copies it into `ouo.exception.debug_ids`. Native (dSYM / ProGuard) symbolication stays out of this ADR (A7). It would add a new `<project>/dsym/<uuid>` prefix next to `sourcemaps/`.

## Consequences

- One new rum-api dependency, `github.com/go-sourcemap/sourcemap` v2.1.4 (BSD-2). It is small and has no transitive dependencies. Grafana Alloy's `faro.receiver` uses it, so it is exercised on real browser stacks.
- One new npm package, `@ouo11y/sourcemaps`, published with the SDKs.
- The browser SDK grows by a few hundred bytes. `index.js` is 43.3 KB gzip, inside its 44 KB budget. It adds one attribute per exception, and only when the page registered debug ids.
- rum-api reads maps on the request path. A cold map costs one object GET plus a parse, about 8 ms for a 1 MB map. The cache keeps that off repeated reads. Symbolication errors never fail the read: the item just has no `symbolicated` field, or a frame has status `no_map`.
- A public upload path through the collector is still to build (N41). Until then CI needs network access to rum-api.
- Malicious maps (VISION 17): a project can only write its own maps, sizes are capped, the parser is memory-safe Go, and the plugin renders source lines as text, never HTML.
