# plugin-bff

Builds the generic libraries a client's own Grafana plugin may use, on [ADR-0025](../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md): `libs/ouo-go` (typed Loki, Tempo and Muninn readers, including funnels, health % and vitals, optional `redact` and `oidc` helpers) and `libs/ouo-kit` (`@ouo11y/kit`, the replay player). Earlier runs built a BFF, a Session explorer and Clearance inside our plugin (PRs #189 and #191, on the superseded ADR-0023 and ADR-0024); that code is reference material for the demo client zero, which lives in its own repository.

- Owns: `libs/ouo-go/`, `libs/ouo-kit/`, `project/kb/plugin/`.
- Does not change `plugins/ouo11y-rum-app` (its MVP pages stay as on `main`), `sdk/`, `services/`, the Collector, `deploy/`.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [The kb entries](../../kb/plugin/index.md) | What building it taught |
