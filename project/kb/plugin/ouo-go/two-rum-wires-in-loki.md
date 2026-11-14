# Two RUM wires in one Loki

Learned 2026-11-14 porting rum-api's funnels to `libs/ouo-go` (agent [plugin-bff](../../../agents/plugin-bff/index.md)) and checking both against `examples/ouo-web` on a live env.

Since `@ouo11y/browser` 0.4.0 (ADR-0020, the client SDK spec) the web SDK writes a different wire from the mobile SDKs and from the MVP web SDK. Both arrive in the same Loki, often for the same project, so a reader of ours must accept both. rum-api was written for the old one only and nobody noticed, because its tests use MVP-shaped fixtures.

| What | Web SDK 0.4+ (spec wire) | Mobile SDKs, Sentry bridge, web before 0.4 |
|---|---|---|
| Page or screen change | `event_name="browser.navigation"`, `url_full` (full URL, sanitised; take its path), `browser_navigation_type` | `event_name="navigation"`, `url_path` |
| User | `enduser_id` | `user_id` |
| Custom event | any `event_name` the app chose; no marker | the name, plus `ouo_event_custom="true"` |
| Platform label | none: `ouo_platform` is empty for web sessions | `ouo_platform` (`mobile`, `web`) |
| Failed request event | none (failures are on the fetch span) | `http.request.failed` |
| Web vitals | `browser.web_vital` | `web_vital` |

Seen on env `ouo-go-readers` with three `examples/ouo-web/scripts/run.sh --env` journeys: rum-api's funnel `page:/ → page:/products/* → event:add_to_cart → event:checkout_submitted` counted 0 web sessions and its step suggestions listed no web page; `ouo-go` counted all 3. Its health %, vitals and traces were unaffected (they read `exception`, `session.*` and Tempo, which both wires share).

How the `ouo-go` funnel reads both without a second query: one selector with `event_name=~"navigation|browser[.]navigation"` and a LogQL label filter with `or`, `| url_path=~"<alt>" or url_full=~"[^/]*//[^/]*(<alt>)([?#].*)?"`. The `url_full` pattern only has to let every match through; the exact path match is redone in Go after `url.Parse`. Custom event suggestions use `| ouo_event_custom="true" or event_name!~"(session|ouo|browser|app|device)[.].*|exception|navigation|web_vital|http[.]request[.]failed"`.

Check for any new reader: run it against a session from `examples/ouo-web` (spec wire) and one from a mobile SDK or a fixture (old wire). A synthetic mobile session can be posted to an env's `http://otlp.<env>.ouo.localhost/v1/logs` as OTLP JSON with `Authorization: Basic base64(demo:pt_dev_demo_0000000000000000)`: the record's `eventName` becomes `event_name`, resource `ouo.platform` and `ouo.project.id` become stream labels.
