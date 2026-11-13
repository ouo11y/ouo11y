# symbolication

Designs where source-map storage and stack-trace lookup live once `services/rum-api` is removed, with a prototype and measurements.

- **Owns:** `project/agents/symbolication/` (prototype, report), `project/kb/symbolication/`, `docs/adr/0022-debug-files-without-rum-api.md`.
- **Does not touch:** `services/rum-api`, `plugins/`, `collector/`, the Muninn design files.

| Path | What it is |
|---|---|
| [tracker.md](tracker.md) | What is done and what is left |
| [summaries/](summaries/index.md) | Dated run summaries |
| [reports/](reports/index.md) | HTML report with options, measurements and decisions |
| [prototype/](prototype/README.md) | Go module: write-once debug-file store, resolver shaped like `ouo-go`, demo and measure command |
