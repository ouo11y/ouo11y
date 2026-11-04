# Embed host fixture

A minimal Grafana app plugin (`ouo11y-embedhost-app`) standing in for a customer's own plugin. It mounts ouo's three exposed components with `usePluginComponent`, which proves the contract of [ADR-0019](../../docs/adr/0019-exposed-components.md) in a real Grafana. It is a test fixture, not a template for production plugins: those are built with `@grafana/create-plugin` (see [docs/embedding.md](../../docs/embedding.md)).

| File | Content |
|---|---|
| [plugin/plugin.json](plugin/plugin.json) | app plugin, `autoEnabled`, declares the three ids under `dependencies.extensions.exposedComponents` |
| [plugin/module.js](plugin/module.js) | the whole plugin: one hand-written AMD module (Grafana loads plugin modules with SystemJS), no build step, no dependencies |
| [plugin/img/logo.svg](plugin/img/logo.svg) | logo |

## Run it

```bash
npm run build -w plugins/ouo11y-rum-app
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.embed-host.yaml up -d
deploy/scripts/e2e.sh
```

Then open http://localhost:3000/a/ouo11y-embedhost-app/embedded (admin / testing567). The page has three dashed boxes, one per component: session health, sessions (the last 20), and session detail. Clicking a session row sets `?sessionId=` and mounts the session detail with its replay. The query keys `from`, `to`, `project`, `app` and `sessionId` are passed to the components as props.

`compose.embed-host.yaml` mounts `plugin/` into Grafana and adds the fixture to the unsigned-plugin and frontend-sandbox lists. The default stack does not load it.
