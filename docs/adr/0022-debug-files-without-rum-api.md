# ADR-0022 Debug files without rum-api: source maps are write-once files in Muninn, resolved by `ouo-go` on read

Status: **proposed** (2026-11-13). Not accepted and not to be merged by a session; the founder merges, after confirming the choices in [section 11](#11-open-decisions-and-recommendations). A design with a working prototype for the web; nothing in `services/rum-api`, the plugin or the Collector is changed here.

Replaces, once accepted, the storage, upload and read path of [ADR-0011](../adr-archive/0011-source-maps-and-symbolication.md). Its debug-id mechanism, the `ouo-sourcemaps` CLI, the Hermes rules and the dSYM lookup stay as they are.

Evidence: [report with the measurements](../../project/agents/symbolication/reports/source-maps-without-rum-api.html), [prototype](../../project/agents/symbolication/prototype/README.md), [kb entries](../../project/kb/symbolication/index.md).

## 1. Context

`services/rum-api` is removed entirely (founder decision of 2026-11-13 on question 9 of the Collector-to-Muninn design, ADR-0019, still an open pull request). Replay goes to Muninn, query logic goes to `ouo-go` in the plugin's Go backend (the BFF). One job has no new home: `services/rum-api/internal/sourcemap` stores uploaded source maps and dSYMs and turns a minified stack trace into original files, lines and functions when an error is read. Without it every production web error reads `at $_ (https://shop.example/assets/index-CGNPO9Y4.js:12:6894)`.

What is already decided and not reopened:

- All ingest goes through the OTel Collector; no other service is exposed.
- Muninn is object storage only: write-once objects, opaque bodies, no database, tenant and project in the key, a REST read API for the BFF.
- The exception record in Loki stays as the SDK sent it. `@ouo11y/browser` 0.4.0 sends `exception.stacktrace` and `ouo.exception.debug_ids` (script URL to debug id) for bundles that ran `ouo-sourcemaps inject`.
- ADR-0011's findings hold: a debug id names the exact build, a release label does not; Hermes columns are bytecode offsets; a dSYM is found by the image's `LC_UUID`.

Four questions: where the files live, how they get there, where and when a stack is resolved, and how a frame finds its file.

## 2. Decision in brief

1. **Storage.** Debug files (source maps now, dSYMs and R8 mappings later) are a second kind of object in Muninn: write-once, opaque, keyed by tenant, project, kind and debug id. Muninn never parses one.
2. **Upload.** `ouo-sourcemaps upload` keeps its request (`PUT /v1/sourcemaps`, the project's upload token, a gzip body). The request goes to the Collector, where a small route checks the token and streams the body to Muninn, and Muninn's answer is the CLI's answer.
3. **Resolution.** A library in `ouo-go` resolves a stack when the BFF serves an error, with a cache of parsed maps. Nothing is resolved at ingest and nothing is written back.
4. **Lookup.** By debug id. A frame without one falls back to release and URL path, and is mapped only when exactly one build was uploaded for them.

## 3. Storage: debug files in Muninn

```
[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>          body exactly as sent (gzip)
[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>.json     meta: sha256, bytes, release, file, uploaded_at
[<prefix>/]debug-files/<tenant>/<project>/release/<h(release)>/<h(path)>/<debug id>   empty pointer
```

- `kind` is `sourcemap`, `dsym` or `proguard`. `debug id` is a UUID: the one `inject` wrote for a source map, the `LC_UUID` for a dSYM slice, the mapping UUID for R8.
- **Write-once.** The first write of a key stays. A repeat with the same bytes answers 200 and changes nothing; a repeat with other bytes answers 409. This is the rule Muninn has for replay chunks, and it removes rum-api's re-upload, cache eviction and "which replica saw the new map" cases.
- **Every map has an id.** A map uploaded without a debug id (a bundle that did not run `inject`) is stored under a UUID made from the SHA-256 of its bytes. So there is one index, not two copies of each map as in rum-api.
- **Pointers** record that a debug id was uploaded for a release and URL path (host dropped, as today). They are empty write-once objects; listing the prefix gives the candidates.
- **Opaque.** Muninn checks the key, a size limit per kind and the hash. It does not parse a map or a Mach-O file. The CLI already knows whether it holds a source map, and the reader treats an unreadable file as a miss.
- **API**, beside the replay API:

```
PUT /api/v1/projects/{project}/debug-files/{kind}/{id}[?release=&file=]   201, 200 same bytes, 409 other bytes
GET /api/v1/projects/{project}/debug-files/{kind}/{id}                    the body as stored
GET /api/v1/projects/{project}/debug-files/{kind}?release=&file=          {"debug_ids": [...]}
```

  with `X-Scope-OrgID` and the service tokens Muninn already has.
- **Retention** is counted from the upload, per project, default one year, `0` keeps forever. A file must outlive the errors that need it, and a mobile release stays in use for months, so the default is longer than rum-api's 90 days. Deleting a project deletes its prefix. Storage cost is small (section 9).

Why Muninn and not a bucket the BFF reads itself: one service owns the bucket, so tenancy, retention, delete-by-project and credentials exist once, and the BFF already has a Muninn client. Why not Muninn's chunk keys as they are: a chunk key is `session/replay/stream/sequence`; a debug file has none of those, so it gets its own prefix and three routes, and shares everything else.

## 4. Upload: through the Collector, answered by Muninn

The Collector has no stock component that passes a file on, so this needs one small custom component (an extension with an HTTP route, since no telemetry flows through it):

- `PUT /v1/sourcemaps?file=&debug_id=&release=` and `PUT /v1/dsyms`, as the CLI sends them today.
- `Authorization: Bearer <upload token>`. The upload token is per project and secret, a CI credential (ADR-0011 section 3). The public project token never authorises an upload. The route finds the project of the token.
- The body is streamed to Muninn's `PUT`, not buffered and not read. Muninn's status is returned as is.

Why not send maps as OTLP log records through the stock pipeline, as replay chunks travel: the Collector answers 2xx when a record is queued, not when Muninn stored it, so CI could not tell a failed upload from a good one, and a build that deploys without its maps is exactly what the upload step exists to stop. Records are also capped at the receiver (`max_request_body_size`, 20 MiB by default), so dSYMs would need a chunking scheme only for this.

The CLI changes in two small ways: it treats 409 as "already stored" with a warning (gzip output differs between zlib versions, so the same map can arrive as other bytes), and for dSYMs it splits a universal file into slices and reads each `LC_UUID` itself, which rum-api did on the server.

## 5. Lookup: debug id, then exactly one build of the release

- A frame whose script has an entry in `ouo.exception.debug_ids` is mapped with that id's map or not at all. It never falls back to the release: ADR-0011 section 6 found that the fallback mapped one OTA bundle's frames with another bundle's map.
- A frame without a debug id asks for the candidates of `(service.version, URL path)`. One candidate: use it. None: `no_map`. Several: `ambiguous`, and the frame stays as recorded. Two builds under one version and path cannot be told apart, and a wrong original line is worse than a minified one.

This is simpler than rum-api's rule (debug id, then release, then "only if the release map names no other id") and gives the same answers on its fixtures, except the one case rum-api got wrong on purpose (last upload wins for frames without ids), which is now `ambiguous`.

## 6. Resolution: `ouo-go`, when an error is read

`ouo-go/symbolicate` takes `{project, release, stacktrace, debug_ids}` from the exception record and returns the frames and the rewritten stack, the same JSON rum-api returns today, so the plugin's `StackTrace` component keeps working. It reads maps through the Muninn client and keeps parsed maps in an LRU.

- The parser stays `github.com/go-sourcemap/sourcemap`, and the frame parser, the function-name rules, the Hermes column rule and the dSYM reader move from `services/rum-api/internal/sourcemap` as they are. In the prototype `stack.go` and `helpers.go` are copies.
- **Cache.** Files are write-once, so a parsed map never goes stale: entries live an hour and are bounded by count and bytes. A parsed map holds about twice its decompressed size on the heap (section 9), so the byte budget counts that. A miss is remembered for 60 seconds, so a map uploaded after the error applies a minute later.
- **Failure.** A stack whose maps are missing, ambiguous or unreadable comes back unchanged with a status per frame. A Muninn outage is an error only when no frame could be looked up.

Why on read and not at ingest (a Collector processor that rewrites the stack before Loki), which is what Sentry, Datadog and PostHog do:

- A map uploaded after the error still applies. At ingest it does not: Sentry's documentation says it does not go back to annotate earlier events.
- The Collector stays stateless: no bucket access, no map cache, no parse of a 30 MB map on the ingest path.
- The record in Loki stays what the SDK sent.
- Those vendors resolve at ingest because they group errors into issues there. ouo has no issue grouping yet. When it does, a processor can add resolved attributes by calling the same library, without changing the store.

The cost is one parse per map per BFF process, then sub-millisecond lookups (section 9).

## 7. React Native (Hermes)

Nothing new in the design: the Metro plugins put a debug id into every bundle, the CLI reads it from the bytecode, and the SDK sends `ouo.exception.debug_ids`. The prototype resolves rum-api's Hermes fixture (two OTA bundles of one store version, both `index.android.bundle`) to the right file, line and function for each, and answers `ambiguous` for the same stacks without ids. A real React Native app on a device was not run here.

## 8. Native symbolication (design only)

- **iOS dSYM.** Kind `dsym`, id the slice's `LC_UUID`, which every crash report already carries per image. No pointers. The DWARF reader (`debug/macho`, `debug/dwarf`) moves to `ouo-go` with the cache. A slice is tens of megabytes, so the byte budget matters more here than for maps.
- **Android R8 / ProGuard.** Kind `proguard`, id a UUID made from the mapping file, written into the app at build time and sent with the error, as Sentry's Gradle plugin does (`io.sentry.proguard-uuid`) and Datadog's newer `build_id` does. The resolver is a retrace over `mapping.txt` (class, method and line ranges). It does not exist yet and is the only new code of this kind.
- **Android NDK** crashes need the unstripped `.so` by ELF build id: the same shape as dSYM with `debug/elf`. Not planned here.

## 9. Evidence

Measured on the prototype (Apple M5, Go 1.26.2, store and resolver in one process over loopback HTTP). A cold resolve is a store GET, gunzip, parse and lookup with an empty cache.

| Map | Size | Stored (gzip) | Cold resolve, median (p95) | Warm resolve, median | Heap kept by the parsed map |
|---|---|---|---|---|---|
| ouo-web replay chunk | 49 KB | 13 KB | 1.2 ms (1.7), 30 runs | 0.03 ms | 0.2 MB |
| ouo-web main bundle, real 10-frame stack | 1.12 MB | 296 KB | 18.9 ms (23.3), 30 runs | 0.28 ms | 3.0 MB |
| 8.6 MB bundle of `@grafana/ui`, `@grafana/data`, `monaco-editor`, `ol` | 33.6 MB | 7.3 MB | 592 ms (631), 10 runs | 0.59 ms | 64.5 MB |

- A missing map costs 0.27 ms cold (one 404) and 0.03 ms once remembered (30 runs).
- Peak process memory for the 33.6 MB map: 167 to 212 MB (3 runs, two parses each, store included). For the 1.12 MB map: 24 MB.
- One ouo-web release (three maps, 1.58 MB) takes 424 KB in the store.
- The real stack from `@ouo11y/browser` 0.4.0, minified `at $_ (…/index-CGNPO9Y4.js:12:6894)`, resolves to `at RenderBomb (src/components/ChaosPanel.tsx:18:20)` with the source lines around it; all 10 frames map.
- Missing map: frames `no_map`, stack returned as recorded. Wrong release without debug ids: `no_map`. Two builds of one release and path without ids: `ambiguous`. Unknown debug id: `no_map` whatever the release holds. Map uploaded after the error: mapped after the 60 s miss memory. Other project: `no_map`. Garbage uploaded as a map: `no_map`. Each is a test in the prototype.
- `ouo-sourcemaps upload` from `sdk/sourcemaps` uploaded to the prototype's route unchanged; a repeat answered 200, a wrong token 401.

Not measured: S3 instead of the filesystem (adds one object GET per cold map), a real Collector in front, a React Native app on a device, dSYMs in the new store.

## 10. Alternatives considered

| Alternative | Why not |
|---|---|
| The BFF reads and writes its own bucket prefix | Two owners of the bucket: tenancy, retention, delete-by-project and credentials twice. CI would have to reach Grafana, or the Collector route would need bucket access |
| Keep a small symbolication service (rum-api reduced to this) | Keeps a service the founder decided to remove, for about 1,600 lines that fit a library |
| Maps as OTLP log records through the stock pipeline | No answer for CI that the file was stored; body cap needs chunking for dSYMs (section 4) |
| Resolve at ingest in the Collector | Late uploads never apply, the Collector gains state and bucket access (section 6) |
| Release and path as the only key (Datadog's older scheme, Faro's) | Two deploys of one version, and every OTA bundle, share a path; rum-api already hit this |
| A pre-built lookup format instead of the raw map (Sentry's SourceMapCache) | 592 ms cold for a 33.6 MB map, once per process, does not justify a second format yet. Write-once files make it easy to add later as another kind |

## 11. Open decisions and recommendations

| # | Decision | Recommendation |
|---|---|---|
| D1 | Does Muninn hold debug files, as a second object kind with three routes? | Yes. The alternative is the BFF's own bucket prefix with the same layout; the `ouo-go` code is the same either way |
| D2 | Upload path for the pilot: the Collector route now, or CI straight to Muninn over the operator's network until the route exists? | Build the route with Muninn's debug-file routes; it is small and CI on hosted runners needs it. Direct upload is the fallback if the pilot's CI is inside the network |
| D3 | Is the release fallback kept at all? | Yes, with the exactly-one rule. It costs one pointer object per map and serves bundles that cannot run `inject` |
| D4 | Retention default for debug files | One year from upload, per project override, `0` forever |
| D5 | Resolve on read only, or also at ingest? | On read only until issue grouping exists |
| D6 | Order of native work | dSYM moves with the JavaScript code (it exists); R8 retrace is new work, after the web and React Native paths are live |

## 12. Consequences

- `services/rum-api/internal/sourcemap` can be deleted once `ouo-go/symbolicate` and Muninn's debug-file routes exist. Maps already uploaded to rum-api are not migrated: CI uploads the next release to the new path, and old releases can be re-uploaded with the same CLI.
- Muninn's spec grows by one prefix, three routes and a retention setting. The Muninn design files are not edited by this ADR; if D1 is accepted they get a section.
- The Collector gains one custom component for uploads.
- `ouo-go` gains one dependency, `github.com/go-sourcemap/sourcemap` (BSD-2, no transitive dependencies), which rum-api has today.
- The BFF holds parsed maps in memory: budget about twice the decompressed size of the maps in use.
- `docs/sourcemaps.md` and `docs/symbolication.md` change only where they name rum-api and its settings.
