# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the first ADR here is 0018. Numbers 0018 and 0019 are taken by pull requests that were open on 2026-11-12.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0019](0019-collector-to-muninn.md) | Proposed: replay chunks travel as OTLP logs through the Collector (stock components, disk queue with fsync) to Muninn, an object-store replay store with an OTLP ingest endpoint and a REST read API; rum-api's replay code retires. 0018 is taken by an open pull request |
| [0020](0020-web-sdk-rebuilt-on-the-spec.md) | The web SDK is rebuilt on the client SDK spec inside the same package: keep the OpenTelemetry base, transport pieces and safety harness; rewrite API, sessions, sampling, signals, privacy and replay; spec wire only (proposed) |
