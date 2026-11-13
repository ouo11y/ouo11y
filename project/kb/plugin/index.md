# Plugin

The Grafana app plugin after the MVP: its Go backend (the BFF), `ouo-go`, `ouo-kit` and Clearance. Decisions are in [ADR-0023](../../../docs/adr/0023-plugin-bff-and-clearance.md) and [ADR-0024](../../../docs/adr/0024-clearance-from-idp-groups.md). MVP-era plugin notes are in [kb-archive/grafana-app-plugin.md](../../kb-archive/grafana-app-plugin.md).

| Folder | What it covers |
|---|---|
| [clearance-idp/](clearance-idp/index.md) | How the backend learns the user's identity-provider groups on open-source Grafana: the options checked, the settings, captured headers |
| [bff/](bff/index.md) | Building and running the plugin's Go backend in our stacks, and reading Loki's answers from it |
