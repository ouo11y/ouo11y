# rum-api retirement

> rum-api, the MVP Grafana plugin (`ouo11y-rum-app`) and the MVP replay path (`ouoreplay` receiver/exporter, :4319) were removed on 2026-11-15 (refactor!: remove rum-api, the MVP plugin and the MVP replay path). Text below that names them is the record of that time.

What `services/rum-api` did, which of it holds state, and where each duty goes once it is deleted.

| Entry | What |
|---|---|
| [what-rum-api-still-held.md](what-rum-api-still-held.md) | Route-by-route inventory (2026-11-14): only debug files and erasure hold data of their own; who writes each, how it is keyed, and where it goes (ADR-0026) |
