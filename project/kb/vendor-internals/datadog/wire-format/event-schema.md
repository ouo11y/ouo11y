# RUM, telemetry and log event schema

- **Schema repo:** `DataDog/rum-events-format` at commit `a435868176db82fc337d7b6771e16b758e188509` (2026-11-03).
- **Shorthand:** `schema:` = `https://github.com/DataDog/rum-events-format/blob/a435868176db82fc337d7b6771e16b758e188509/schemas/`
- The SDKs generate their TypeScript, Swift and Kotlin models from these JSON Schemas. For example, the browser's `rumEvent.types.ts` and `sessionReplay.ts` are generated, and Android ships a copy under `src/main/json/schemas/`.
- Platform variants: `rum-events-browser-schema.json`, `rum-events-mobile-schema.json`, `rum-events-electron-schema.json`.
- Research date 2026-11-10. Examples: [fixtures](fixtures/index.md).

## Conventions

- **Durations are nanoseconds** (`duration: 121000000` = 121 ms). **Dates are epoch milliseconds** (`date`). View-relative timings (`custom_timings`, `first_contentful_paint`) are ns since view start (observed).
- **IDs:**
  - `session.id`, `view.id`, `action.id`, `resource.id`, `error.id`, `vital.id`, `long_task.id` are UUID v4. `tab.id` (browser) too.
  - Trace ids are decimal strings in `_dd.trace_id` / `_dd.span_id`.
- **Format version:** `_dd.format_version: 2`.
- **Mutable views:** `_dd.document_version` increases with each update. The server keeps the highest version.
- **Tags:** `ddtags: "sdk_version:7.17.0,env:local,service:…,version:…"` is a string inside each event (v7 browser and mobile, observed).

## Common fields (every RUM event)

`schema:rum/_common-schema.json`:
- `date`, `application.id`, `service`, `version`, `build_version`, `build_id`, `source`, `ddtags`
- `session {id, type: user|synthetics|ci_test, has_replay, is_active, sampled_for_replay}`
- `view {id, url, referrer, name}`
- `usr {id, name, email, anonymous_id, …}`, `account`
- `connectivity`, `display.viewport`, `device`, `os` (mobile)
- `context` (global plus event context), `synthetics`, `ci_test`, `tab`, `stream`, `container`
- `_dd` (internal: `format_version`, `drift`, `configuration` sample rates, `sdk_name`, `session.plan`, `discarded`)

## Per-type fields

| `type` | Main object fields | Source |
|---|---|---|
| `view` | `view`: `loading_type` (initial_load, route_change, activity_/fragment_/view_controller_display and _redisplay, session_renewal, …), `loading_time`, `time_spent`, `is_active`, counters `action`/`error`/`resource`/`long_task`/`frustration`/`crash` `{count}`, web vitals (`first_contentful_paint`, `largest_contentful_paint`, `interaction_to_next_paint`, `cumulative_layout_shift` with target selectors), `performance {cls, fcp, inp, lcp …}` with sub-parts, `dom_*`, `first_byte`, `custom_timings`, scroll `max_depth…`, mobile `memory_*`, `refresh_rate_*`, `cpu_ticks_*`, `slow_frames`, `freeze_rate`, `in_foreground_periods`, `network_settled_time`, `interaction_to_next_view_time`. Also `feature_flags`, `privacy.replay_level`, `display.scroll`, `_dd.replay_stats {records_count, segments_count, segments_total_raw_size}`, `_dd.page_states` | `schema:rum/view-schema.json`, `_view-properties-schema.json`, `_view-performance-schema.json` |
| `view_update` | Same shape, but every field is optional except ids and `_dd.document_version`. It carries only what changed since the last state sent. | `schema:rum/view_update-schema.json` |
| `action` | `action {id, type: custom\|click\|tap\|scroll\|swipe\|application_start\|back, loading_time, target.name, frustration.type[] (rage_click, dead_click, error_click, rage_tap, error_tap), error/crash/long_task/resource counts}`, `_dd.action {position, target {selector, width, height}, name_source}` | `schema:rum/action-schema.json` |
| `resource` | `resource {id, type (document, xhr, fetch, js, css, image, font, media, beacon, native, other), method, url, status_code, duration, size, encoded_body_size, decoded_body_size, transfer_size, render_blocking_status, delivery_type, protocol, timing phases (redirect, dns, connect, ssl, first_byte, download {start, duration}), provider, graphql, request/response {headers}}`, `_dd {trace_id, span_id, rule_psr, discarded}` | `schema:rum/resource-schema.json` |
| `error` | `error {id, message, type, stack, causes[], source (network, source, console, logger, agent, webview, custom, report), source_type (android, browser, browser+wasm, ios, react-native, flutter, roku, ndk, …), handling, handling_stack, fingerprint, is_crash, category (ANR, App Hang, Exception, Watchdog Termination, Memory Warning, Network), threads[], binary_images[], meta (mach exception), csp, wasm_modules, resource {url, method, status_code}}`, `freeze` | `schema:rum/error-schema.json` |
| `long_task` | `long_task {id, duration, entry_type: long-task\|long-animation-frame, blocking_duration, first_ui_event_timestamp, render_start, style_and_layout_start, start_time, scripts[] {invoker, invoker_type, source_url, source_function_name, source_char_position, duration, …}, is_frozen_frame}` | `schema:rum/long_task-schema.json` |
| `vital` | `vital {id, type: duration\|app_launch\|operation_step\|websocket_*, name, duration, description}`. App launch adds `app_launch_metric (ttid/ttfd), startup_type (cold_start/warm_start), is_prewarmed`. | `schema:rum/vital-*.json` |
| `telemetry` | `telemetry {type: log\|configuration\|usage, status, message, error, configuration {…}, usage {feature}, runtime_env, connectivity, sdk_setup}`, `effective_sample_rate`, `experimental_features`. Sent on the `rum` track. | `schema:telemetry/*.json` |
| others | `transition`, `execution_context`, `stream`, `timeseries-cpu/-memory` | `schema:rum/` |

Observed in [rum-batch-fetch.json](fixtures/browser/rum-batch-fetch.json) and [ios/rum-batch.json](fixtures/ios/rum-batch.json).

## Logs events (not in rum-events-format)

Browser logs (observed, [logs-batch.json](fixtures/browser/logs-batch.json)):
- `date`, `message`, `status` (debug/info/notice/warn/error/critical), `origin` (logger, console, source, network, report)
- `service`, `version`, `ddtags`, `session_id`, `session {id}`, `application_id`
- `view {id, url, referrer}`, `user_action {id}`, `usr`, `tab`
- `error {kind, message, stack, causes, fingerprint}` and `http {method, status_code, url}` for network errors
- Logger attributes are merged at the top level (`order.id`)

iOS logs (observed): a JSON array of log objects with `status`, `message`, `service`, `logger {name, version, thread_name}`, `_dd.device`, `network.client` (with `networkInfoEnabled`), `usr`, and `application_id` / `session_id` / `view.id` when RUM is enabled.

**There is no OTel mapping anywhere.** Moving this data into OTel means mapping each type by hand, as [rum-semconv](../../../opentelemetry/index.md) (Step 2) does for our own SDK.
