# rum-api-retirement

> rum-api, the MVP Grafana plugin (`ouo11y-rum-app`) and the MVP replay path (`ouoreplay` receiver/exporter, :4319) were removed on 2026-11-15 (refactor!: remove rum-api, the MVP plugin and the MVP replay path). Text below that names them is the record of that time.

Moves the two things only `services/rum-api` still held, debug files with symbolication and erasure with its audit log, to Muninn and `libs/ouo-go`, so rum-api can be deleted ([ADR-0026](../../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md)).

- Owns: `services/muninn/internal/muninn/{debugfiles,audit}.go`, Muninn spec sections 13 and 14 and MUN-45, `libs/ouo-go/{debugfiles,muninn_admin}.go`, `libs/ouo-go/symbolicate/`, `libs/ouo-go/erase/`, `libs/ouo-go/cmd/ouo-erase/`, the upload half of `sdk/sourcemaps`, `project/kb/rum-api-retirement/`.
- Does not delete `services/rum-api` or its plugin pages (the next step).

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
