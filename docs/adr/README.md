# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the first ADR here is 0018. Numbers 0018 and 0019 are taken by pull requests that were open on 2026-11-12.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0020](0020-web-sdk-rebuilt-on-the-spec.md) | The web SDK is rebuilt on the client SDK spec inside the same package: keep the OpenTelemetry base, transport pieces and safety harness; rewrite API, sessions, sampling, signals, privacy and replay; spec wire only (proposed) |
| [0019](0019-react-native-sdk-keep-and-extend.md) | React Native SDK: keep the OpenTelemetry JS core and extend it in two steps (wire-compatible musts, then the spec wire with replay over OTLP in pixel and structure formats); JavaScript owns session, queue and exporter |
| [0019](0019-react-native-sdk-keep-and-extend.md) | React Native SDK: keep the OpenTelemetry JS core and extend it; spec wire only, in two pull requests (missing layers, then names and replay over OTLP in pixel and structure formats); JavaScript owns session, queue and exporter |
