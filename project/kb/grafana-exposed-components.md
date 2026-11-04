# Grafana exposed components (embedding a plugin's React views in another plugin)

Learned building R5 (ADR-0019) on Grafana 13.2 and `@grafana/data` / `@grafana/runtime` 13.2.2.

## API

- **Provider:** call `new AppPlugin().exposeComponent({ id, title, description, component })` in `module.tsx`. The id format is `<plugin id>/<name>/v<major>`.
- **Consumer:** `const { component, isLoading } = usePluginComponent<Props>(id)` from `@grafana/runtime`. `component` is `null` when the provider is missing, disabled or does not expose the id.
- **Provider `plugin.json`:** `extensions.exposedComponents: [{ id, title, description }]`. Grafana ignores a registration that plugin.json does not declare, so a test should keep `plugin.json` and the `exposeComponent` calls equal (`AppPlugin.exposedComponentConfigs` lists the registrations).
- **Consumer `plugin.json`:** `dependencies.extensions.exposedComponents: [id, ...]`. This makes Grafana load the provider app for the consumer's pages.

## Runtime behaviour worth knowing

- **Plugin context.** Grafana wraps the exposed component in the *provider's* plugin context: it fetches `/api/plugins/<provider>/settings` and renders it under a `PluginContextProvider`. So `usePluginContext()?.meta.jsonData` inside the component is the provider's settings (ouo reads its feature toggles there). Calls through the provider's `/api/plugin-proxy/<provider>/...` route keep the provider's route token and `reqRole`.
- **Props.** Props reach the component through a read-only proxy: never mutate them. Function props (callbacks such as `onSessionClick`) work.
- **Router.** The component renders inside the host page, which is inside Grafana's react-router. So `Link` and `useParams` work, but `useParams` returns the **host's** route params. Never take an id from the route in an embedded view; take it from props.
- **URL.** `locationService.getSearch()` is the host's URL too. ouo's pages read range and scope from the URL query, so embedded they get a query built from props instead (`EmbedContext`, read by `useSearchParams`). Nothing embedded calls `locationService.partial`.
- **Page chrome.** `PluginPage` inside an exposed component would render a second page header in the host page. ouo's `PageShell` renders only the children when embedded.
- **Lazy loading.** Lazy-load the heavy views (`React.lazy`). The provider's `module.js` loads for every host page that asks for a component, and webpack chunks resolve against `public/plugins/<provider>/`, so they load from any page.

## A host plugin without a build

Grafana loads plugin modules with SystemJS, which reads AMD. A one-file `module.js` can stand in for a host plugin:

```js
define(['react', '@grafana/data', '@grafana/runtime'], (React, data, runtime) => ({
  plugin: new data.AppPlugin().setRootPage(App),
}));
```

`react`, `@grafana/data`, `@grafana/runtime` and `@grafana/ui` are shared by Grafana. The example is `examples/embed-host-plugin`. For a local fixture, set `"autoEnabled": true` in its plugin.json, so it needs no provisioning file. That matters because a file bind-mounted into compose's read-only provisioning directory cannot be added from an override.

## Testing

- Render the exposed component directly in Jest. Mock `@grafana/runtime` with a `locationService` whose `partial` throws and whose `getSearch` returns a different range: that proves the component ignores the host URL.
- Wrap a component in `PluginContextProvider` to test settings-driven behaviour.
- Wrap it in `MemoryRouter` when it renders a react-router `Link`: Grafana always provides a router, but Jest does not.
