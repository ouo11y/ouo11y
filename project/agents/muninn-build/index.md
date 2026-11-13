# muninn-build

Builds Muninn, ouo's replay store, and the Collector configuration that feeds it, from the design in PR #180 (ADR-0019, the draft `docs/specs/muninn.md`), so the pilot can store and read the replay chunks `@ouo11y/browser` 0.4.0 sends.

- Owns: `services/muninn/`, `deploy/compose/collector/config.muninn.yaml`, `deploy/compose/compose.muninn.yaml`, `deploy/compose/muninn/`, the `--muninn` part of `deploy/envs/`, `tests/e2e/muninn/`, `project/kb/muninn/build/`.
- Does not change `sdk/`, `plugins/`, `services/rum-api`, the MVP Collector config and components, or Helm.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [The kb entries](../../kb/muninn/build/index.md) | What building it taught |
