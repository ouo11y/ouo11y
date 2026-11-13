# plugin-bff

Builds the plugin's Go backend (the BFF), `ouo-go`, `ouo-kit` and the Session explorer pages, on [ADR-0023](../../../docs/adr/0023-plugin-bff-and-clearance.md) (post-MVP step 9, first slice for the pilot).

- Owns: `libs/ouo-go/`, `libs/ouo-kit/`, `plugins/ouo11y-rum-app/pkg/`, `plugins/ouo11y-rum-app/src/explore/`, `plugins/ouo11y-rum-app/scripts/build-backend.mjs`, the BFF settings in `deploy/compose/grafana/provisioning/plugins/`, `tests/e2e/plugin-bff/`, `project/kb/plugin/`.
- Does not change `sdk/`, `services/`, the Collector, the MVP pages and their rum-api data path, or Helm.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [reports/](reports/index.md) | HTML reports (end-to-end run with screenshots) |
| [The kb entries](../../kb/plugin/bff/index.md) | What building it taught |
