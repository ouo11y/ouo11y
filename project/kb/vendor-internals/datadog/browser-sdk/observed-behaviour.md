# Browser SDK: what it actually sent

- **SDK:** `@datadog/browser-rum` / `@datadog/browser-logs` **7.17.0**, loaded from the npm package's `bundle/` files (no CDN). Captured 2026-11-10.
- **Rig:** [examples/datadog-capture](../../../../../examples/datadog-capture/README.md). The `proxy` option points at a local Node server that decodes and stores every request.
  - `drive.mjs` clicks and types in headless Chrome over the DevTools protocol, so all events are trusted (`isTrusted: true`).
  - It then navigates to `about:blank` to trigger the exit flush.
- **Runs:**
  - `run1-default`: default options plus replay 100 %.
  - `run2-compress-viewupdates`: `compressIntakeRequests` on, `betaEnableViewUpdates` on.
  - `run3-privacy-mask`: `defaultPrivacyLevel: 'mask'`.
  - `run4-viewupdates`: `betaEnableViewUpdates` on.
- `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/`.
- Fixtures: [../wire-format/fixtures/](../wire-format/fixtures/index.md). Every row below is `observed:` unless it cites code.

## Requests per run (run1, about 17 s of activity)

| # | Track | Transport (`_dd.api`) | Bytes | Why it was flushed |
|---|---|---|---|---|
| 1 | replay | fetch (multipart) | 3 253 | Segment 1, 5 s timer |
| 2 | rum | fetch | 15 555 | Bytes limit (16 KiB) |
| 3 | rum | fetch | 15 376 | Bytes limit |
| 4 | rum | fetch | 16 237 | Bytes limit (the estimate was just under, the real size just over) |
| 5–7 | replay | fetch | 3 026 / 1 197 / 2 749 | 5 s timer, then a new view (`view_change`) |
| 8 | rum | **beacon** | 11 301 | Page exit |
| 9 | logs | beacon (no `_dd.api` on logs) | 4 770 | Page exit |
| 10 | replay | fetch | 1 135 | Page exit. The `hidden` flush fired first, and that reason uses `send()` (fetch); other exit reasons use sendBeacon (see reliability page). |

- With 16 KiB uncompressed batches, a chatty page flushes on bytes, not on the 30 s timer.
- With `compressIntakeRequests` (run2), the limit counts **compressed** bytes. All RUM events of the run stayed in one batch until page exit.
  - That batch was 51 941 B raw and 5 702 B deflated, a 9.1× ratio.
  - It was sent as `text/plain` with `dd-evp-encoding=deflate` in the URL.
  - The events still waiting in the worker at exit went in a second, uncompressed request.

## Views

- One initial view (`loading_type: initial_load`) and one `route_change` view after `history.pushState('/checkout/42')`.
- Views are long-lived and mutable. `_dd.document_version` grows (2, 3, 5 …), and only the last version in a batch is sent, because the batch upserts by view id.
- **`view_update` (run4):** after the first full view had been flushed, the next batch carried a `view_update` with only the changed fields.
  - Changed fields: `action`, `custom_timings`, `frustration`, `id`, `resource`, `time_spent`, `url`.
  - Size: 733 B against 2 562 B for the full view.
  - The page-exit batch carried a full `view` again: an ended view is always sent in full (`src:browser-rum-core/src/transport/startRumBatch.ts`).
- With `proxy` set and no explicit flag, no `view_update` was sent (runs 1 and 3). This matches the code default.
- **Vitals on the view:**
  - `first_contentful_paint`, `largest_contentful_paint` plus target selector and sub-parts.
  - `interaction_to_next_paint` plus target, with `input_delay`, `processing_duration` and `presentation_delay`.
  - `cumulative_layout_shift`, `first_byte`, `dom_*`, `load_event`, `loading_time`.
  - INP moved to the 300 ms long-task button when it was clicked.
  - All durations are **nanoseconds**.
- The initial view ended with `is_active: false` when the route changed. The last view was still `is_active: true` in the exit batch. Datadog closes it server side.

## Actions and frustration signals

| Click | Action name | Frustration |
|---|---|---|
| Button with `data-dd-action-name` | "named click" | — |
| Plain button | its text | — |
| Button with no handler, once | its text | `dead_click` |
| Same button, 4 clicks in about 320 ms | one action | `rage_click` + `dead_click` |
| Buttons that throw, reject, `console.error` or `addError` | text | `error_click` + `dead_click` (no DOM change followed) |
| Password input | "Masked Element" | — |
| Text input | its label, "Name" | — |

- An action's `loading_time` was 1 ms when the handler changed the DOM, and missing for dead clicks.
- `_dd.action.target.selector` and `_dd.action.position` are recorded for heatmaps.
- The view's `frustration.count` went up to 12. Datadog counts each frustration type separately.

## Errors (RUM) and logs

| Trigger | RUM `error.source` / `handling` | Log `origin` |
|---|---|---|
| `setTimeout(() => throw)` | `source` / `unhandled` | `source` |
| `Promise.reject(new TypeError)` | `source` / `unhandled` | `source` |
| `console.error(msg, obj)` | `console` / `handled`, with the object pretty-printed into the message | `console` (we forwarded `error` and `warn`) |
| `addError(err with cause and dd_context, ctx)` | `custom` / `handled`, `causes[1]`, context merged | — |
| `fetch('/api/fail')` → 500 | not an error; a `resource` with `status_code: 500` | `network` "Fetch error GET …" (`forwardErrorsToLogs`) |
| `logger.info` / `warn` | — | `logger`, with the attributes at the top level (`order.id`) |

Log events carry `session_id`, `view`, `application_id` and `usr`, so logs join to RUM sessions.

## Resources and trace propagation

- Resources were `document`, `js` (×5), `image` (the data-URI SVG), `fetch` and `xhr`.
  - Fetch and XHR resources include timing phases (`first_byte`, `download`), sizes, `delivery_type` and `render_blocking_status`.
  - With `trackResourceHeaders: true` they also include `response.headers`.
- Our backend received these headers on `/api/ok`, `/api/fail` and `/api/slow`:
  - `traceparent: 00-0000000000000000<16 hex>-<16 hex>-01`
  - `tracestate: dd=s:1;o:rum`
  - `x-datadog-trace-id`, `x-datadog-parent-id` (decimal), `x-datadog-origin: rum`, `x-datadog-sampling-priority: 1`
  - `baggage: session.id=<uuid>,user.id=user-123`
- The resource event carries the same ids as `_dd.trace_id` / `_dd.span_id` (decimal) and `_dd.rule_psr: 1`.
- **The trace id is 64-bit.** The upper 64 bits of the W3C id are zero. An OTel backend can join on `traceparent`, but the ids are not random 128-bit ids.

## Long tasks and vitals

- The 300 ms busy loop produced a `long_task` with `entry_type: long-animation-frame` and `duration` / `blocking_duration`.
  - It also has a `scripts[]` attribution: `invoker: BUTTON#btn-longtask.onclick`, `source_url`, `source_char_position`.
- In run1 this was the only long task. Earlier runs also recorded one during page boot in headless Chrome.
- `startDurationVital('demo.compute')` / `stopDurationVital('demo.compute')` produced a `vital` event: `type: duration`, `duration: 121000000` ns, with its own context merged.
- `addTiming('hero_image_loaded')` added `view.custom_timings.hero_image_loaded` (ns since view start). It is not a separate event.

## Session Replay

- Five segments for two views (`creation_reason`: `init`, `segment_duration_limit` ×2, `view_change`, `segment_duration_limit`). Each was 1–3 KB on the wire.
- In total 11 360 B of HTTP bodies for 17.3 s of replay, about **0.65 KB/s or 39 KB/min**, on a small static page.
- Masking:
  - With `mask-user-input`: the typed values ("Jane Secret", the password) **never appear**. Inputs became the string `"***"`.
  - Text inside `data-dd-privacy="mask"` became `x` runs.
  - `data-dd-privacy="hidden"` content was absent.
  - With `mask`, all text became `x` runs, including the in-page log text.
- Format details are in [browser-replay-format.md](../wire-format/browser-replay-format.md).

## Telemetry

- Telemetry events go to the `rum` track as `type: telemetry`.
- Observed messages include `Session manager init metrics` (debug) from both the RUM and Logs SDKs, and seven `usage` events in run2 (one per public API feature used). We forced `telemetrySampleRate: 100`.
- They include `telemetry.connectivity`, `runtime_env` and `sdk_setup: cdn`.
