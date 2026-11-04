# Embedding ouo in your Grafana plugin

ouo's session detail (with the replay player), sessions list and session health views can render inside your own Grafana app plugin. ouo exposes them as Grafana **exposed components**. Your plugin mounts one with `usePluginComponent` and passes props. ouo still serves the component and makes every rum-api call through its own plugin proxy, with its own read token and role rules. Your plugin needs no token, no proxy route and no rum-api URL. The design is in [ADR-0019](adr/0019-exposed-components.md).

## Requirements

- Grafana 13.0 or later. Both plugins live in the same Grafana.
- `ouo11y-rum-app` installed, enabled and configured (rum-api URL and read token) in that Grafana, at a plugin version that exposes the components (the first release after 0.11, see the plugin CHANGELOG).
- The viewer needs the org role that ouo's proxy route requires (Viewer, as on ouo's own pages).

## 1. Declare the dependency

Add the ids you use to your `plugin.json`, so Grafana loads ouo for your pages:

```json
{
  "dependencies": {
    "grafanaDependency": ">=13.0.0",
    "extensions": {
      "exposedComponents": [
        "ouo11y-rum-app/session-detail/v1",
        "ouo11y-rum-app/sessions-list/v1",
        "ouo11y-rum-app/overview-health/v1"
      ]
    }
  }
}
```

## 2. Mount a component

```tsx
import React from 'react';
import { usePluginComponent } from '@grafana/runtime';
import { Alert, LoadingPlaceholder } from '@grafana/ui';

type SessionDetailV1Props = {
  sessionId: string;
  timeRange?: { from: string | number; to: string | number };
  project?: string;
  app?: string;
};

export function OuoSession({ sessionId }: { sessionId: string }) {
  const { component: SessionDetail, isLoading } = usePluginComponent<SessionDetailV1Props>(
    'ouo11y-rum-app/session-detail/v1'
  );
  if (isLoading) {
    return <LoadingPlaceholder text="Loading ouo" />;
  }
  if (!SessionDetail) {
    return <Alert severity="info" title="ouo is not installed in this Grafana" />;
  }
  return <SessionDetail sessionId={sessionId} timeRange={{ from: 'now-7d', to: 'now' }} project="shop" />;
}
```

`usePluginComponent` returns `null` when ouo is missing, disabled or too old. Show a fallback then: a message, or a link to ouo.

## 3. The components and their props (v1)

Every component takes these optional props:

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `timeRange` | `{ from: string \| number; to: string \| number }` | last 24 hours | Relative (`now-6h`), ISO 8601, or epoch milliseconds. From a Grafana `TimeRange`, pass `range.raw` when it holds strings, else `{ from: range.from.valueOf(), to: range.to.valueOf() }`. |
| `project` | `string` | every project | ouo project id (`ouo.project.id`). |
| `app` | `string` | every app | `service.name` of the app inside the project. |

`project` and `app` narrow what the component shows; they are not an access boundary.

### `ouo11y-rum-app/session-detail/v1`

One session: header (user, platform, device, service, counts, vitals), the replay player (rrweb for web, frames or video for mobile) with its activity list and markers, traces with Tempo links, and logs.

| Prop | Type | Required | Meaning |
|---|---|---|---|
| `sessionId` | `string` | yes | The session to show. Without it the component shows an error and calls nothing. |

The time range must contain the session's start: rum-api looks the session up in it.

### `ouo11y-rum-app/sessions-list/v1`

The sessions table (sortable, newest first) for the time range. Filtering is done with props: the component has no filter inputs of its own, so your plugin owns the filter UI.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `filters` | `{ platform?: 'web' \| 'mobile'; status?: 'healthy' \| 'errored' \| 'crashed'; version?: string; user?: string }` | none | Each filter narrows the list. |
| `limit` | `number` | `100` | Most sessions to load, clamped to 1–1000. |
| `onSessionClick` | `(sessionId: string) => void` | link out | Called when a row is clicked. Without it, the row opens the session on ouo's own Session page. |

A typical host shows the list and mounts `session-detail/v1` for the clicked id.

### `ouo11y-rum-app/overview-health/v1`

Healthy, errored and crashed tiles, plus the version table, for web and mobile. A version row links out to ouo's Sessions page, filtered to that version.

## 4. Link out: the bridge for everything else

Funnels, ouo's own time and scope pickers, and any view without an exposed component are reached by linking to ouo's pages. They live in the same Grafana under the same session, so the link needs no login:

```
/a/ouo11y-rum-app/sessions/<session id>?from=now-24h&to=now&project=<project>&service=<app>
/a/ouo11y-rum-app/sessions?from=now-24h&to=now&project=<project>&service=<app>&status=errored
/a/ouo11y-rum-app/overview?from=now-7d&to=now
/a/ouo11y-rum-app/funnels?from=now-7d&to=now
```

The links inside the embedded components (a version row, the previous session, a settings hint) already go there. Link-out also works on Grafana versions older than 13, where exposed components are not available.

## Versioning and stability

- An id ends in its major version. Within `/v1`, props are only added, as optional props whose default keeps today's behaviour. A prop is never removed, renamed, retyped or given a new meaning there.
- A breaking change ships as `/v2` next to `/v1`. `/v1` stays for at least one plugin minor release, and the plugin CHANGELOG says so.
- The props types are `plugins/ouo11y-rum-app/src/exposed/types.ts`. Copy them into your plugin; they have no runtime dependency.

## What the host does and does not control

- **The host controls** where a component sits, its width (the components fill their container), and every prop.
- **The host does not control** ouo's styling (Grafana theme, light or dark as the user chose), ouo's API calls, or the token.
- An embedded component draws no page title, breadcrumbs or time picker. Those belong to your page.
- It never reads or changes your page's URL.
- ouo's feature toggles (for example `sessionTimelinePanel`) apply as configured in ouo's plugin settings.

## Try it locally

[`examples/embed-host-plugin`](../examples/embed-host-plugin/README.md) is a host plugin in one JavaScript file, with no build step. It mounts all three components:

```bash
npm run build -w plugins/ouo11y-rum-app
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.embed-host.yaml up -d
deploy/scripts/e2e.sh   # a few sessions, one with an rrweb replay
```

Open http://localhost:3000/a/ouo11y-embedhost-app/embedded (admin / testing567) and click a session.
