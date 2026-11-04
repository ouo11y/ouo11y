# Project and app scope (R1, 2026-11-04)

Question: how does the plugin scope every view to one project or app, and what bit us?

- **Project = `ouo_project_id` Loki stream label** (resource `ouo.project.id`, stamped by the collector from the Basic username). Funnels, retention and delete-by-project use the same label. A stream matcher, not a `|` filter, so Loki prunes streams.
- **The options come from a metric query.** `GET /v1/projects` asks Loki for `sum by (ouo_project_id, service_name, ouo_platform) (count_over_time({service_name=~".+", event_name="session.start"} [Ns]))` as an instant query. That is cheap: 80 sessions gave 2 series in about 10 ms. A label that a series lacks comes back missing from `metric`, and is treated as "".
- **Round `to` up, not down.** Rounding both ends down to the minute, to make the cache hit, dropped the sessions of the current minute. The e2e lists sessions that started seconds earlier, so it failed. Round `from` down and `to` up.
- **Stale data under new labels.** `useRumQuery` keeps the previous data while a new key loads. That is fine for a time-range change, but wrong for a scope change: the page showed the old project's numbers under the new project's heading for one round trip. Fix: `dataKey` on the query state, plus `isOtherScope(dataKey, scope)` on the scope suffix of the key.
- **Grafana `Combobox` in Jest** measures text with a canvas. Stub `HTMLCanvasElement.prototype.getContext` to return `{ measureText }`. `Icon` drops `aria-label` in tests, so put the label or test id on a wrapping span. Do not use `''` as an option value; use a sentinel (`*` for all projects).
- **Grafana pages through Playwright.** `httpCredentials` does not log in, because Grafana redirects to `/login` instead of answering 401. Send `extraHTTPHeaders: { Authorization: 'Basic …' }`.
- **Two projects in a local stack** without editing htpasswd: run `deploy/scripts/e2e.sh` twice, with `OUO_PROJECT_ID=internal OUO_PROJECT_TOKEN=pt_dev_internal_00000000000000` the second time. Both projects are in `collector/projects.htpasswd`. Set `OUO_ENV_FILE` to an env file with the `OUO_*_PORT`s.
- **Not an access boundary.** One read token reads every project; per-project tokens are Phase 11.
