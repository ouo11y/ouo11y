# ADR-0019 Embedding ouo in other Grafana plugins: versioned exposed components

Status: proposed (2026-11-04, R5 of the JUHI gap list)

## Context

A customer runs its own Grafana app plugin (the "host plugin") and wants ouo's session and replay views inside its pages, not in a second app. ADR-0001 makes the `ouo11y-rum-app` plugin the only UI, and its pages call rum-api only through the plugin's own proxy route (`/api/plugin-proxy/ouo11y-rum-app/rum/*`). Grafana adds the read token there server-side, and the routes are restricted by method and role (N30). The pages are plain React with no Scenes. They read their time range, scope and filters from the URL query.

There are three ways to get ouo into another plugin:

1. **Copy or import the code into the host.** The host would need its own proxy route to rum-api, and with it the read token, ouo's auth rules and ouo's API version. Every rum-api change would break it.
2. **iframe the ouo page.** That gives two Grafana chromes, no shared theme or time range, and sizing hacks.
3. **Grafana exposed components** (`AppPlugin.exposeComponent` in the providing plugin, `usePluginComponent` in the host). Grafana loads ouo's own module and renders ouo's React component inside the host page, in ouo's plugin context. Calls still go through ouo's proxy route with ouo's token and role rules.

## Decision

1. **ouo exposes components.** Only option 3 keeps rum-api, the read token and the proxy routes ouo's alone. The host needs no token, no route and no knowledge of rum-api.
2. **The ids are `ouo11y-rum-app/<component>/v<major>`.** The first set:

   | Id | Shows |
   |---|---|
   | `ouo11y-rum-app/session-detail/v1` | one session: header, replay player (rrweb, frames or video) with its activity list, traces, logs |
   | `ouo11y-rum-app/sessions-list/v1` | the sortable sessions table for a range, filtered by props |
   | `ouo11y-rum-app/overview-health/v1` | healthy / errored / crashed tiles and the version table per platform |

   Each id is declared in `plugin.json` `extensions.exposedComponents` (Grafana ignores a registration plugin.json does not declare) and registered in `module.tsx`. A test keeps the two lists equal.
3. **Props are the contract, and they are stable within a major.** The types live in `src/exposed/types.ts` and are copied in [docs/embedding.md](../embedding.md).
   - Every component takes optional `timeRange` (`{ from, to }`: relative, ISO or epoch ms; default the last 24 hours), `project` (`ouo.project.id`) and `app` (`service.name`).
   - `session-detail/v1` requires `sessionId`.
   - `sessions-list/v1` takes `filters` (`platform`, `status`, `version`, `user`), `limit` (1 to 1000, default 100) and `onSessionClick(sessionId)`. The default for `onSessionClick` is a link out to ouo's own Session page.

   Within `/v1` a prop may be added only as optional, with a default that keeps the old behaviour. Removing, renaming or retyping a prop, or changing what it means, ships as a new `/v2` id. `/v1` stays registered next to it for at least one plugin minor release, with a CHANGELOG entry.
4. **Embedded pages reuse ouo's pages, not copies.**
   - An `EmbedContext` hands the pages a query built from the props (`from`, `to`, `project`, `service`) in place of the browser URL. The host's URL is the host's: an embedded component never reads or writes it.
   - `PageShell` drops ouo's page chrome (title, breadcrumbs, the time and scope pickers): the host owns those.
   - ouo's feature toggles come from ouo's plugin settings, because Grafana renders an exposed component inside the providing plugin's context.
   - Links inside the components (a version row, the previous session, error alerts) open ouo's own pages. That link-out is also the bridge for every view that is not exposed, such as funnels.
5. **The minimum is Grafana 13 on both sides.** That is `grafanaDependency >=13.0.0`, as the plugin already requires. The host declares the ids under `dependencies.extensions.exposedComponents` in its `plugin.json`, so Grafana loads ouo for it.
6. **ADR-0001 still holds.** The plugin remains the only UI: every pixel inside the host's slot is ouo's code, served from ouo's plugin, through ouo's proxy and auth. The host chooses where the components sit and which props they get.

## Consequences

- An org Viewer of the host sees ouo data only if they can use ouo's plugin: the proxy route's `reqRole` (Viewer) applies as on ouo's pages. The scope props narrow what is shown; like the scope selector, they are not an access boundary (one read token, ADR-0007).
- ouo must be installed and enabled in the same Grafana. Without it, `usePluginComponent` returns no component, and the host should show a link or an explanation, as the fixture does.
- The props are now a public API: page refactors must keep `/v1` working. The contract tests in `src/exposed/*.test.*` fail on a renamed id or an undeclared component.
- Embedded, the components have no time picker of their own: the host passes the range. A host that wants ouo's full pages links out.
- `examples/embed-host-plugin` is a hand-written host plugin (no build step), provisioned only by `deploy/compose/compose.embed-host.yaml`. It proves the contract in a real Grafana.
