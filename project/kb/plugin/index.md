# Plugin

What a client's own Grafana plugin (backend and frontend) meets when it reads ouo11y data, and how the generic libraries `libs/ouo-go` and `@ouo11y/kit` fit in ([ADR-0025](../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)). Learned building a BFF and a Session explorer in PRs #189 and #191, which were not merged. MVP-era plugin notes are in [kb-archive/grafana-app-plugin.md](../../kb-archive/grafana-app-plugin.md).

| Folder | What it covers |
|---|---|
| [backend/](backend/index.md) | Building and running a plugin's Go backend in our stacks, what Grafana passes it, and reading Loki's answers from it |
| [idp-tokens/](idp-tokens/index.md) | How a plugin backend gets the user's identity-provider tokens on open-source Grafana (only a datasource with `oauthPassThru`), the settings, captured headers, and what token verification must hold against |
| [ouo-go/](ouo-go/index.md) | Using `libs/ouo-go` itself: the two RUM wires its readers must accept, and fetching it (public since 2026-11-15) |
