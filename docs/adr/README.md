# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the first ADR here is 0018. Numbers 0018 and 0019 are taken by pull requests that were open on 2026-11-12.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0019](0019-collector-to-muninn.md) | Proposed: replay chunks travel as OTLP logs through the Collector (stock components, disk queue with fsync) to Muninn, an object-store replay store with an OTLP ingest endpoint and a REST read API; rum-api's replay code retires. 0018 is taken by an open pull request |
| [0020](0020-web-sdk-rebuilt-on-the-spec.md) | The web SDK is rebuilt on the client SDK spec inside the same package: keep the OpenTelemetry base, transport pieces and safety harness; rewrite API, sessions, sampling, signals, privacy and replay; spec wire only (proposed) |
| [0021](0021-react-native-sdk-keep-and-extend.md) | React Native SDK: keep the OpenTelemetry JS core and extend it; spec wire only; replay over OTLP chosen by one `replay.mode` string (`pixel/frames`, `pixel/video`, `structure/wireframe`), recorders borrowed from Sentry and Datadog; JavaScript owns session, queue and exporter |
| [0023](0023-plugin-bff-and-clearance.md) | Proposed: the plugin's own Go backend is the BFF; `ouo-go` (queries and Clearance) and `ouo-kit` (player) in a new `libs/`; Clearance levels 0 to 5 by Grafana role and login, enforced in `ouo-go` with deny by default; direct Loki and Muninn URLs; first slice built. 0022 is taken by an open pull request |
| [0025](0025-funnels-and-home-in-the-bff.md) | Proposed: funnels (with PR #168's conditions and failed outcome) and the Home page move into `ouo-go` on the spec wire, page steps match web pages and mobile screens; definitions provisioned in plugin settings; counts at c1; Home reads Loki and Mimir (span metrics); reusable pieces in `ouo-kit`. 0024 is taken by an open pull request |
