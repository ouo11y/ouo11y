# plugin-demo

Takes the plugin from the BFF slices ([plugin-bff](../plugin-bff/index.md), [ADR-0023](../../../docs/adr/0023-plugin-bff-and-clearance.md)) to the full pilot demo: funnels and the overview on the spec wire, the demo apps and a one-command demo, releasable `ouo-go` and `@ouo11y/kit`, a starter plugin and a walkthrough. Never merges or releases; the founder does.

- Owns: `libs/ouo-go/`, `libs/ouo-kit/`, `plugins/ouo11y-rum-app/pkg/`, `plugins/ouo11y-rum-app/src/explore/`, `tests/e2e/plugin-bff/`, `tests/e2e/demo/`, `examples/ouo-web/`, `examples/ouo-mobile/` (demo flow only), `examples/plugin-starter/`, `project/kb/plugin/`, the BFF settings in `deploy/compose/grafana/provisioning/plugins/`.
- Does not change `sdk/`, `services/muninn`, the Collector, or #191's branch.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | The PR plan and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [reports/](reports/index.md) | HTML reports |
