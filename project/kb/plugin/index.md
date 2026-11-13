# Plugin

The Grafana app plugin after the MVP: its Go backend (the BFF), `ouo-go`, `ouo-kit` and Clearance. Decisions are in [ADR-0023](../../../docs/adr/0023-plugin-bff-and-clearance.md) and [ADR-0025](../../../docs/adr/0025-funnels-and-home-in-the-bff.md). MVP-era plugin notes are in [kb-archive/grafana-app-plugin.md](../../kb-archive/grafana-app-plugin.md).

| Folder | What it covers |
|---|---|
| [bff/](bff/index.md) | Building and running the plugin's Go backend in our stacks, and reading Loki's answers from it |
| [funnels-home/](funnels-home/index.md) | Funnels and the Home page on the spec wire: records, labels, span metrics in Mimir |
