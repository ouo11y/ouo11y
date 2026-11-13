# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the first ADR here is 0018. Numbers 0018 and 0019 are taken by pull requests that were open on 2026-11-12.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0019](0019-collector-to-muninn.md) | Proposed: replay chunks travel as OTLP logs through the Collector (stock components, disk queue with fsync) to Muninn, an object-store replay store with an OTLP ingest endpoint and a REST read API; rum-api's replay code retires. 0018 is taken by an open pull request |
| [0020](0020-web-sdk-rebuilt-on-the-spec.md) | The web SDK is rebuilt on the client SDK spec inside the same package: keep the OpenTelemetry base, transport pieces and safety harness; rewrite API, sessions, sampling, signals, privacy and replay; spec wire only (proposed) |
| [0023](0023-plugin-bff-and-clearance.md) | Proposed: the plugin's own Go backend is the BFF; `ouo-go` (queries and Clearance) and `ouo-kit` (player) in a new `libs/`; Clearance levels 0 to 5 by Grafana role and login, enforced in `ouo-go` with deny by default; direct Loki and Muninn URLs; first slice built. 0021 and 0022 are taken by open pull requests |
| [0024](0024-clearance-from-idp-groups.md) | Proposed: Clearance levels come from identity-provider groups, read from the user's verified OIDC ID token (highest group wins, deny by default); the org-role mapping is a separate mode for a Grafana with no IdP; the per-login override is removed; the BFF moves to a datasource nested in the plugin, the only place open-source Grafana forwards the token; the mapping is a secure setting |
