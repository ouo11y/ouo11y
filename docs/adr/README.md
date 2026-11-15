# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the first ADR here is 0018. Numbers 0018 and 0019 are taken by pull requests that were open on 2026-11-12.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0019](0019-collector-to-muninn.md) | Proposed: replay chunks travel as OTLP logs through the Collector (stock components, disk queue with fsync) to Muninn, an object-store replay store with an OTLP ingest endpoint and a REST read API; rum-api's replay code retires. 0018 is taken by an open pull request |
| [0020](0020-web-sdk-rebuilt-on-the-spec.md) | The web SDK is rebuilt on the client SDK spec inside the same package: keep the OpenTelemetry base, transport pieces and safety harness; rewrite API, sessions, sampling, signals, privacy and replay; spec wire only (proposed) |
| [0021](0021-react-native-sdk-keep-and-extend.md) | React Native SDK: keep the OpenTelemetry JS core and extend it; spec wire only; replay over OTLP chosen by one `replay.mode` string (`pixel/frames`, `pixel/video`, `structure/wireframe`), recorders borrowed from Sentry and Datadog; JavaScript owns session, queue and exporter |
| [0025](0025-generic-libs-clients-own-plugin-and-access.md) | Proposed: we ship generic libraries (`libs/ouo-go` readers, including funnels, health %, vitals and session traces since amendment 1, with optional `redact` and `oidc` helpers, `@ouo11y/kit` replay player); each client owns its plugin backend, frontend and access model (groups, a ladder, Grafana roles or nothing); supersedes the unmerged ADR-0023 and ADR-0024; decides the top-level `libs/`; the MVP plugin goes with rum-api |
| [0026](0026-debug-files-and-erasure-without-rum-api.md) | Proposed: debug files upload from the client's CI straight to one public, write-only, token-checked Muninn route (amends ADR-0022's Collector route and the Collector-only edge); symbolication on read in `ouo-go/symbolicate`; erasure is the `ouo-erase` operator CLI with audit entries in Muninn; rum-api keeps nothing |
| [0027](0027-r8-mappings-and-retrace.md) | Proposed: a random mapping id per minified Android build (Gradle script, APK asset), sent as `ouo.exception.mapping_id`; CI uploads `mapping.txt` with `ouo-sourcemaps upload-proguard` to Muninn kind `proguard`; `ouo-go/symbolicate` retraces JVM frames, inlined frames included |
