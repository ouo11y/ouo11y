# plugin-bff

Builds the plugin's Go backend (the BFF), `ouo-go`, `ouo-kit` and the Session explorer pages, on [ADR-0023](../../../docs/adr/0023-plugin-bff-and-clearance.md) (post-MVP step 9, first slice for the pilot), and Clearance from identity-provider groups on [ADR-0024](../../../docs/adr/0024-clearance-from-idp-groups.md).

- Owns: `libs/ouo-go/`, `libs/ouo-kit/`, `plugins/ouo11y-rum-app/pkg/`, `plugins/ouo11y-rum-app/src/explore/`, `plugins/ouo11y-rum-app/scripts/build-backend.mjs`, `plugins/ouo11y-rum-app/src/datasource/`, the BFF's datasource in `deploy/compose/grafana/provisioning/datasources/`, `deploy/compose/compose.idp.yaml` and `deploy/compose/keycloak/`, `tests/e2e/plugin-bff/`, `project/kb/plugin/`.
- Does not change `sdk/`, `services/`, the Collector, the MVP pages and their rum-api data path, or Helm.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [reports/](reports/index.md) | HTML reports (end-to-end run with screenshots) |
| [The kb entries](../../kb/plugin/bff/index.md) | What building it taught |
