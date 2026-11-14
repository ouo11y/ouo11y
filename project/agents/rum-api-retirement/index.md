# rum-api-retirement

Moves the two things only `services/rum-api` still held, debug files with symbolication and erasure with its audit log, to Muninn and `libs/ouo-go`, so rum-api can be deleted ([ADR-0026](../../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md)).

- Owns: `services/muninn/internal/muninn/{debugfiles,audit}.go`, Muninn spec sections 13 and 14 and MUN-45, `libs/ouo-go/{debugfiles,muninn_admin}.go`, `libs/ouo-go/symbolicate/`, `libs/ouo-go/erase/`, `libs/ouo-go/cmd/ouo-erase/`, the upload half of `sdk/sourcemaps`, `project/kb/rum-api-retirement/`.
- Does not delete `services/rum-api` or its plugin pages (the next step).

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
