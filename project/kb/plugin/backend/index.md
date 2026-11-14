# Plugin backend

What building a Go backend for a Grafana plugin taught (agent [plugin-bff](../../../agents/plugin-bff/index.md), 2026-11-13 and 2026-11-14).

| Entry | What it answers |
|---|---|
| [grafana-backend-plugin.md](grafana-backend-plugin.md) | How a Go backend is built, named, shipped and called in our stacks; what Grafana passes it about the user; which settings users can read; traps (Admin-made instances, renamed logins, leaking store errors) |
| [loki-answers.md](loki-answers.md) | What a Loki query answer looks like to a backend on our OTLP setup: label names, structured metadata, selectors that work, limits |
