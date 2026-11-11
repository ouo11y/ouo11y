# Architecture decision records

Decisions for the post-MVP work. Numbering continues from the archive, so the next ADR is 0018.

MVP-era decisions are in [adr-archive](../adr-archive/README.md).

| ADR | Decision |
|---|---|
| [0019](0019-collector-to-muninn.md) | Proposed: replay chunks travel as OTLP logs through the Collector (stock components, disk queue with fsync) to Muninn, an object-store replay store with an OTLP ingest endpoint and a REST read API; rum-api's replay code retires. 0018 is taken by an open pull request |
