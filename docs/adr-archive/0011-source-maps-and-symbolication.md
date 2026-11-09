# ADR-0011 Source maps and dSYMs: debug ids, files in the rum-api bucket, symbolication on read

Status: proposed (2026-10-24). Implemented and verified on `ouo-env web-sourcemaps-fa863c` the same day. Implements A10 (web part) and part C of N36 in `project/tracker/checklist.md`. Revised 2026-10-29 for native iOS crashes (section 7, work package W7 of `project/kb-archive/mobile-sdk-research/roadmap.md`): dSYMs go through the same CLI, token, store, retention and read path. Revised 2026-11-04 for React Native (section 6, item B3): Hermes bundles get debug ids from Metro, so every OTA bundle has its own map, and Hermes columns are read as bytecode offsets.

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
- the bundle also ends with a one-line registration snippet. It takes its own script URL from `new Error().stack` (the first URL there) and sets `globalThis.__ouoDebugIds[<script url>] = "<uuid>"`. It is appended after the last line of code, so no existing mapping moves. A browser has no API that reads a script's `//# debugId` comment, so this is how the SDK learns it at runtime. Sentry uses the same mechanism (`_sentryDebugIds`), but keys it by the raw stack and parses that in the SDK. ouo parses in the snippet instead, which lives in the app's bundle, so the SDK's core bundle stays within its size budget.

The SDK (`exceptionAttributes` in `sdk/browser/src/errors/classify.ts`) reads `__ouoDebugIds`, keeps the registered URLs that the stack mentions followed by `:<line>`, and adds `ouo.exception.debug_ids` to the exception record. The value is a JSON object `{ "<script url>": "<debug id>" }`, limited to the scripts the stack actually names. Bundles without the snippet send nothing extra.

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

### 6. React Native / Hermes: debug ids from Metro, one map per OTA bundle (revision 2026-11-04, B3)

The first version of this section indexed React Native maps by release + bundle name only, on the belief that a Hermes bytecode bundle cannot carry a registration snippet. It can, and it must: an app that ships over-the-air updates (`hot-updater`, `expo-updates`, CodePush) runs several bundles per store version, all named `index.android.bundle` / `main.jsbundle`, and the release index holds one map per name, so each upload replaced the one before and errors from devices on an older OTA bundle mapped to the wrong lines.

- **The id goes in at bundle time, in Metro.** Every release build compiles Metro's output with `hermesc` right away (Gradle plugin, `react-native-xcode.sh`, hot-updater, `expo export`), so nothing can be appended to the bytecode later. `@ouo11y/sourcemaps/metro` adds the registration snippet while Metro serializes: `withOuoDebugIds(config)` wraps `serializer.customSerializer` (Metro's own, from `metro/private`, or the app's) for bare React Native, and `ouoExpoDebugIdPlugin` is an `unstable_beforeAssetSerializationPlugins` entry for Expo, whose export path never calls a custom serializer. Bare: the id is a UUID from the SHA-256 of the bundle, and the snippet goes at the end of Metro's prelude line, which has no mappings, so Metro's map stays exact and the id is registered before any module runs. Expo: Expo's serializer already computes an id per bundle and writes it as `//# debugId=` and into the map; the plugin reuses it and inserts a one-line virtual module after the prelude, which Expo's map accounts for. `ouo-sourcemaps inject` does the same for `.bundle` / `.jsbundle` files between Metro and hermesc in a hand-written pipeline.
- **The snippet survives Hermes.** It holds the id as one string literal, `"ouo-debug-id:<uuid>"`, which `hermesc -O` keeps byte for byte in the bytecode's string table, and registers `globalThis.__ouoDebugIds[<file of its first frame>] = <uuid>`. Hermes stacks name files, not URLs (`address at index.android.bundle:1:9`, the OTA bundle's absolute path), so the snippet takes the file of any frame form, and the SDK normalises it like the stack (`app:///index.android.bundle`).
- **Upload reads the id from the bundle.** React Native's `compose-source-maps` (and so the Gradle plugin, Xcode, hot-updater) drops `debugId` from the composed map. `ouo-sourcemaps upload` takes it from the map when present, else from `//# debugId=`, else from the literal in the bundle, text or bytecode (Sentry's `sentry-dbid-<uuid>` literal too). `--bundle` / `--sourcemap` pairs cover builds that write the two to different folders; `ouo-sourcemaps compose` composes the two maps with the app's `metro-source-map` and keeps the id; `@ouo11y/sourcemaps/hot-updater` wraps hot-updater's build plugin and uploads each OTA bundle's map before it is deployed. There is no `--file` flag; the first version of this section named one.
- **The SDK sends `ouo.exception.debug_ids`** with every JavaScript exception, the browser's shape: `{ "app:///index.android.bundle": "<uuid>" }`, the registered files whose normalised location the stack names. It is read when the error is captured, so a record sent later still names the bundle that threw. With no ouo id registered it reads Sentry's `_sentryDebugIds` (keyed by a stack), so an app moving from Sentry keeps readable stacks with its existing Metro plugin. Native crashes have no JavaScript frames and keep using dSYMs (section 7).
- **An unknown debug id never takes another build's map.** When the frame's debug id is not in the store, rum-api still tries the release index, but uses that map only when it names no debug id or the same one. Every OTA bundle of a store version has the same path, so the release map of `/index.android.bundle` is usually another bundle's: one OTA deploy without an upload would otherwise show confident, wrong lines. The frames stay `no_map` instead. `PUT /v1/sourcemaps` writes the request's `debug_id` into the stored map when the map has none (a composed Hermes map never has one), so the copy in the release index says which bundle it belongs to; maps uploaded with no id at all still serve as the fallback. The same holds for the web: same release and path, different id, different build.
- **rum-api's lookup order is unchanged** (debug id, then release + path), and it is fixed in two places. The React Native SDK's frames end with ` [in app]`, which the frame parser did not accept, so no React Native frame was ever looked up; it does now, and keeps the marker in the rewritten stack. And a Hermes column is the bytecode offset itself (`appendBytecodeFrame` in Hermes' `lib/VM/JSError.cpp` prints `bytecodeOffset + virtualOffset`), the 0-based generated column of the Hermes map, while browsers print 1-based columns. rum-api used `column - 1` for every frame, which on a Hermes frame lands on the previous instruction, often another line. It now uses the column as is for an `address at` frame and for any frame looked up in a map with `x_hermes_function_offsets` (hermesc's map, kept by composition), because the SDK's normalised stack no longer says `address at`. The fixture is real: two OTA bundles built by Metro (Expo's serializer, `ouoExpoDebugIdPlugin`), `hermesc -O` and composition (`services/rum-api/internal/sourcemap/testdata/hermes/generate.mjs`).
- **The Sentry bridge** (N38) feeds the same frames; Sentry's own registry covers apps that keep Sentry's Metro plugin. Native iOS symbolication (dSYM) is section 7. Android (R8 / ProGuard mappings) comes with W9 and will follow the same pattern.

Why Metro and not a `hermesc` wrapper (`HERMES_CLI_PATH` in Xcode, `hermesCommand` in Gradle), which would see the JavaScript right before compilation: hot-updater's `bare` plugin resolves `hermesc` itself and offers no override, and every build path reads `metro.config.js`. Sentry made the same choice (`withSentryConfig`).

### 7. Native iOS crashes: dSYMs by build UUID (revision 2026-10-29, W7)

A native crash report from `OuoCrash` (project/kb-archive/ios-native-crashes.md) has, per frame, `instruction_addr` and `image_addr`, and per binary image `debug_id` (the image's `LC_UUID`), `image_addr` and `image_vmaddr`. The React Native SDK keeps them in `ouo.crash.frames` and `ouo.crash.images` next to an Apple-style `exception.stacktrace` (`sdk/react-native/src/crash.ts`). Nobody can read those addresses without the build's dSYM.

- **The key is the build UUID.** Xcode writes a new `LC_UUID` into every linked binary and the same UUID into its dSYM's DWARF file, one per architecture. It plays the role the debug id plays for a source map, and every crash report already carries it. No release index is needed: there is no frame without an image UUID. A `--release` given at upload is kept in the meta only, for listing.
- **Upload: `ouo-sourcemaps upload-dsym <path>...`** finds every `<name>.dSYM/Contents/Resources/DWARF/<binary>` under the paths (a `.dSYM`, an archive's `dSYMs/`, a build products folder) and PUTs each file, gzip-compressed, to `PUT /v1/dsyms` with the same project upload token as maps. rum-api splits a universal file into its slices (`debug/macho`), checks that each has an `LC_UUID` and DWARF (`__debug_info`; the app binary uploaded by mistake is a 400), and stores each slice under its UUID. A file is limited to 512 MiB (`limits.max_dsym_bytes`); a React Native app's Release dSYM is about 50 MiB.
- **Store: `<project>/dsym/<uuid>.dwarf.gz` and `.json`**, inside the same `sourcemaps/` root as the maps, so per-project isolation, `retention.sourcemaps`, the sweeper, `GET /v1/sourcemaps` (with `"kind":"dsym"`) and delete-by-project apply unchanged. A separate root would duplicate all four for no gain.
- **Symbolication on read, as for maps.** When rum-api serves an `exception` with `ouo_crash_frames`, it resolves each frame against the dSYM of its image: `svma = instruction_addr - image_addr + image_vmaddr`, minus one for every frame after the first (a return address points after the call; one byte back lands inside the call instruction, which is the line the caller is on). The lookup uses Go's standard `debug/macho` and `debug/dwarf`, no new dependency: the compilation unit's line table gives file and line, the `DW_TAG_subprogram` / `DW_TAG_inlined_subroutine` entries around the address give the function and the functions it was inlined into, each one frame as `atos -i` prints it, with `DW_AT_call_file` / `DW_AT_call_line` as the caller's position. Code without DWARF gets the name of the nearest symbol in the dSYM's symbol table, without a file. Frames whose image has no uploaded dSYM stay as they are (`no_map`).
- **The response is the same `symbolicated` object**, with native frames carrying `address`, the image name as `generated.file` and `inlined`. The stack text is rewritten in atos style (`crash_here (in App) (Crash.swift:8)`), the Binary Images section is kept. `POST /v1/symbolicate` takes the same `frames` and `images`.
- **Cache.** Parsed dSYMs share the LRU of parsed maps, which now also has a byte budget (`sourcemaps.cache_bytes`, 512 MiB by default, counted as the decompressed size). Measured on a 26.5 MiB arm64 slice of a React Native app (Expo, Sentry, react-native-screens): 24–31 ms to parse, about 21 MiB of heap, 0.85 ms per address on average and 11 ms at worst. Real dSYMs have overlapping compilation-unit ranges (dsymutil writes a unit's span), so rum-api indexes the units once and tries each unit that covers the address, instead of `Reader.SeekPC`, which stops at the first.
- **Not done here.** Swift names are DWARF names (`level2`), not demangled signatures (`level2(_:)`), since Go has no Swift demangler; the symbol-table fallback shows mangled names (`$s6Sentry...`). The crashed thread is the only one (an `OuoCrash` limit). Bitcode is gone since Xcode 14, so no symbol map step is needed. Upload through the collector waits for N41, as for maps.

Why rum-api and not a separate symbolicator (Sentry's `symbolicator`, `atos` on a Mac): the store, token, retention and read path exist already, the standard library reads Mach-O and DWARF, and one Go service stays the only reader of the bucket.

## Consequences

- One new rum-api dependency, `github.com/go-sourcemap/sourcemap` v2.1.4 (BSD-2). It is small and has no transitive dependencies. Grafana Alloy's `faro.receiver` uses it, so it is exercised on real browser stacks.
- One new npm package, `@ouo11y/sourcemaps`, published with the SDKs.
- The browser SDK grows by about 80 bytes gzip. `index.js` is 45,036 of its 45,056-byte (44.0 KB) budget. It adds one attribute per exception, and only when the page registered debug ids.
- rum-api reads maps on the request path. A cold map costs one object GET plus a parse, about 8 ms for a 1 MB map. The cache keeps that off repeated reads. Symbolication errors never fail the read: the item just has no `symbolicated` field, or a frame has status `no_map`.
- A public upload path through the collector is still to build (N41). Until then CI needs network access to rum-api.
- Native crashes (section 7): no new dependency (`debug/macho`, `debug/dwarf`), one endpoint (`PUT /v1/dsyms`), two settings (`limits.max_dsym_bytes`, `sourcemaps.cache_bytes`), one CLI command (`upload-dsym`). A dSYM lookup costs about 1 ms per frame after a cold parse of a few tens of milliseconds. The audit count of delete-by-project (`sourcemaps.deleted`) counts dSYM slices with maps.
- React Native (section 6): no new dependency. `@ouo11y/sourcemaps` gains two entry points (`/metro`, `/hot-updater`, CommonJS and ESM, which `metro.config.js` and `hot-updater.config.ts` load) and one command (`compose`); Metro internals and `metro-source-map` are resolved from the app at build time, never shipped. A bundle grows by about 200 bytes of bytecode. Metro's `metro/private` paths are internal: a Metro release that moves `baseJSBundle` or `bundleToString` breaks the bare-React-Native wrapper, loudly, at bundle time.
- Malicious maps (VISION 17): a project can only write its own maps, sizes are capped, the parser is memory-safe Go, and the plugin renders source lines as text, never HTML.
