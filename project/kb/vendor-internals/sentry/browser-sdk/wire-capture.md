# Sentry browser SDK: what goes on the wire (observed)

- SDK: `@sentry/react` and `@sentry/browser` **11.11.0** (2026-11-05), from npm, bundled by Vite 7.2.2. Browser: Chromium 152 (the Claude desktop browser pane).
- Server: self-hosted Sentry 26.10.0 (`getsentry/self-hosted`), project `step6-browser` (id 4).
- Captured 2026-11-10 with `sentrytap` ([collector/tools/sentrytap/main.go](../../../../../collector/tools/sentrytap/main.go)) in forward mode on `127.0.0.1:4520` → `localhost:9000`, and in sink mode on `:4522` (answering 429) behind a small CORS shim on `:4523`.
- Demo: [examples/sentry-web/](../../../../../examples/sentry-web/README.md). Every scenario is a button and `window.demo.<name>()`.
- Every statement here is **observed** unless marked (code). Code references use `B` = `https://github.com/getsentry/sentry-javascript/blob/11.11.0`.
- Fixtures: [fixtures/](fixtures/index.md). DSN public key replaced by 32 zeros, time zone replaced by `Etc/Redacted` (same byte length, so item `length` headers stay valid). Event, trace, replay and profiler ids are kept on purpose so the wire-storage and read-api agents can find the same data in Sentry.
- The normative envelope and item-type spec, verified against Relay 26.10.0, is [../wire-format/](../wire-format/index.md); this file does not re-specify it. It records what the **browser SDK** actually emits, and section 6 lists fields the browser sends that the wire-format files do not mention. Reading the data back is in [../read-apis/](../read-apis/index.md).

## 1. The HTTP request

One request per envelope. 85 requests were captured in the forward run, 18 in the sink runs.

| Part | Observed value | Notes |
|---|---|---|
| Method, path | `POST /api/<project_id>/envelope/` | The only endpoint the browser SDK used. No `/store/`, no `/minidump/`. |
| Query | `sentry_version=7&sentry_key=<public key>&sentry_client=sentry.javascript.react%2F11.11.0` | Auth travels in the **query string**. No `X-Sentry-Auth` header was ever sent (it would force a CORS preflight). `sentry_client` names the framework package, not `browser`. |
| `Content-Type` | `text/plain;charset=UTF-8` when the body is a string; **absent** when the envelope contains binary (replay, PNG attachment) | Not `application/x-sentry-envelope`. Plain text and a body with no type are CORS "simple requests", so there is no `OPTIONS` preflight. The body becomes a `Uint8Array` only when an item payload is binary (code: `B/packages/core/src/utils/envelope.ts`, `serializeEnvelope`). |
| `Content-Encoding` | never set | The browser SDK does not compress envelopes. Only the replay recording payload is compressed, inside the envelope. |
| `Origin`, `Sec-Fetch-Mode`, `Sec-Fetch-Site` | `http://127.0.0.1:4521`, `cors`, `cross-site` | Fetch in CORS mode; `keepalive` is not visible on the wire. |
| `User-Agent` | the browser's | Relay uses it when `infer_user_agent` is `auto`. |
| Body | newline-delimited envelope, no trailing newline | See section 2. |

### Response from self-hosted Relay

| Case | Status | Body | Headers the SDK reads |
|---|---|---|---|
| Envelope with `event_id` in its header (error, feedback, replay, transaction, profile_chunk) | 200 | `{"id":"<event_id>"}` | `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: x-sentry-error,x-sentry-rate-limits,retry-after`, `Cross-Origin-Resource-Policy: cross-origin` |
| Envelope without `event_id` (session, span, log, trace_metric, client_report) | 200 | `{}` | same |
| Rate limited (sink) | 429 | anything | `X-Sentry-Rate-Limits: 60:error;transaction;span;replay:organization`, `Retry-After: 60` |

Fixture: [fixtures/session-429-rate-limited.http.json](fixtures/session-429-rate-limited.http.json). Every fixture has a `.http.json` with the request line, the headers that matter and the response.

**CORS matters for any receiver.** The first sink run answered 429 without CORS headers. The browser hid the response, `fetch` rejected, and the SDK treated it as a network failure: it kept sending every category, replay retried its segment after 5 s and 10 s, and the client report said `network_error`, not `ratelimit_backoff` ([fixtures/client-report-network-error-cors.envelope](fixtures/client-report-network-error-cors.envelope)). With `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers` added, the SDK honoured the limits. An ouo endpoint that receives browser envelopes must send both headers, on every status. `sentrytap -sink` sends neither, so it cannot stand in for Sentry in front of a browser without a shim.

## 2. Envelope framing

```
{envelope header JSON}\n
{item header JSON}\n
{payload}\n
{item header JSON}\n
{payload}
```

- Item headers carry `length` only when the payload is binary or may contain a newline: `attachment` and `replay_recording`. JSON items (`event`, `session`, `span`, `log`, ...) have no `length` and end at the next newline.
- No trailing newline after the last payload (observed with `od -c` on [fixtures/session-init.envelope](fixtures/session-init.envelope)).
- One envelope per request. The browser SDK never put two events in one envelope; an error and its attachments travel together, and a replay segment is one `replay_event` plus one `replay_recording`.

### Envelope headers seen

| Envelope | `event_id` | `sent_at` | `sdk` | `trace` (DSC) | `dsn` |
|---|---|---|---|---|---|
| event (error/message) | yes | yes | yes | yes | no |
| transaction (`traceLifecycle:'static'`) | yes | yes | yes | yes | no |
| feedback | yes | yes | yes | yes | no |
| span (v2 container) | no | yes | yes | yes | no |
| replay_event + replay_recording | yes = `replay_id` | yes | yes | **no** | no |
| profile_chunk | yes (random) | yes | yes | no | no |
| session | no | yes | yes | no | no |
| log container | no | **no** | yes | **no** | no |
| trace_metric container | no | **no** | yes | **no** | no |
| client_report | no | no | no | no | header is `{}` |

- `sdk` is always `{"name":"sentry.javascript.react","version":"11.11.0"}`.
- `dsn` appears only with the `tunnel` option (code: `B/packages/core/src/envelope.ts`, `createEventEnvelopeHeaders`, `!!tunnel && dsn`). Not exercised here.
- The `trace` header is the dynamic sampling context. Observed keys and order: `environment, release, public_key, trace_id, replay_id, sampled, sample_rand, sample_rate`. All values are **strings** (`"sampled":"true"`, `"sample_rate":"1"`). `transaction` was absent because the root span name source was `url`. `org_id` was absent (no `orgId` option and a self-hosted DSN host without an `o<id>.` prefix).
- The same DSC goes out as the `baggage` request header on traced fetches:
  `sentry-environment=step6,sentry-release=sentry-web-demo%401.0.0,sentry-public_key=…,sentry-trace_id=e62f…,sentry-replay_id=bb6e…,sentry-sampled=true,sentry-sample_rand=0.866375041749666,sentry-sample_rate=1`
  together with `sentry-trace: <trace_id>-<span_id>-1` and, because the demo set `propagateTraceparent: true`, `traceparent: 00-<trace_id>-<span_id>-01`. The demo's `/api/hello` echoes them; see [sampling.md](sampling.md) for where each part is decided.

## 3. Item types, one by one

The table lists every item type the browser SDK sent. Fixture names are in [fixtures/index.md](fixtures/index.md).

| Item type | Item header | When it was sent | Fixture |
|---|---|---|---|
| `event` | `{"type":"event"}` | each error, message, failed HTTP request (httpClientIntegration), React ErrorBoundary error | event-*.envelope |
| `attachment` | `{"type":"attachment","length":N,"filename":"note.txt","content_type":"text/plain"}` | with the event it belongs to | event-with-text-attachment.envelope |
| `feedback` (+ `attachment` `screenshot.png`, `image/png`) | `{"type":"feedback"}` | `captureFeedback` | feedback-with-screenshot.envelope.bin |
| `session` | `{"type":"session"}` | at init, at `setUser`, on the first error | session-*.envelope |
| `span` (v2 container) | `{"type":"span","item_count":N,"content_type":"application/vnd.sentry.items.span.v2+json"}` | when a segment (root) span ends, and for standalone web-vital spans | span-v2-*.envelope |
| `transaction` | `{"type":"transaction"}` | only with `traceLifecycle:'static'` | transaction-static-pageload.envelope |
| `log` (container) | `{"type":"log","item_count":4,"content_type":"application/vnd.sentry.items.log+json"}` | buffer flush (`Sentry.flush()` here; also on hide, timer, size) | log-container.envelope |
| `trace_metric` (container) | `{"type":"trace_metric","item_count":3,"content_type":"application/vnd.sentry.items.trace-metric+json"}` | same as logs | trace-metric-container.envelope |
| `profile_chunk` | `{"type":"profile_chunk","platform":"javascript"}` | with `profileLifecycle:'trace'`, one chunk after each root span | profile-chunk.envelope |
| `replay_event` + `replay_recording` | `{"type":"replay_event"}` and `{"type":"replay_recording","length":N}` | each replay segment | replay-*.envelope.bin |
| `client_report` | `{"type":"client_report"}` | only when the page becomes hidden (and on unload) | client-report-*.envelope |

Not sent by the browser SDK in any run: `check_in` (crons are server-side; `captureCheckIn` is not exported by `@sentry/browser`), `statsd` / `metric_buckets` (v11 metrics are `trace_metric`), `user_report` (feedback replaced it), `profile` (the legacy transaction profile; v11 browser profiling sends `profile_chunk`), `sessions` aggregates (browser sends individual `session` updates).

### 3.1 `event` (error)

Observed top-level keys of a thrown error ([fixtures/event-error-thrown.envelope](fixtures/event-error-thrown.envelope)): `exception, level, event_id, platform, request, contexts, timestamp, environment, release, sdk, tags, user, transaction, breadcrumbs`.

| Field | Observed | Notes |
|---|---|---|
| `exception.values[]` | `type`, `value`, `stacktrace.frames[]` (`filename`, `function`, `in_app`, `lineno`, `colno`), `mechanism` | Minified frames; symbolication needs uploaded source maps. |
| `mechanism.type` | `auto.browser.browserapierrors.setTimeout` (timer throw), `auto.browser.global_handlers.onunhandledrejection`, `generic` (manual), `chained` (cause) | `handled:false` for the timer and rejection. |
| Linked errors | `values[0]` = cause `TypeError` with `mechanism {type:"chained", source:"cause", exception_id:1, parent_id:0}`, `values[1]` = outer `Error` with `exception_id:0` | Innermost first ([fixtures/event-linked-errors.envelope](fixtures/event-linked-errors.envelope)). |
| `request` | `url`, `headers.User-Agent`, `headers.Referer` when present | From httpContextIntegration. |
| `contexts` | `trace {trace_id, span_id}`, `profile {profiler_id}`, `react {version}`, `culture {locale, timezone, calendar}` | No `browser`/`os`/`device`: Relay derives them from the User-Agent. |
| `sdk` | `name`, `version`, `packages[]`, `integrations[]` (20 names), `settings.infer_ip: "auto"` | `infer_ip:auto` is v11's default (no `dataCollection`): Relay stores the client IP. |
| `tags` | user tags plus `replayId` | The replay integration adds the `replayId` tag. |
| `user` | `{id}` from `setUser` | |
| `transaction` | `/` (URL path) | |
| `breadcrumbs[]` | `timestamp` (seconds, float), `category` (`fetch`, `navigation`, `ui.click`, `console`, `sentry.event`, ...), `type`, `level`, `data` (`method`, `url`, `status_code`, `response_body_size`, `__span`) | `data.__span` links a fetch breadcrumb to its span. |

**`captureMessage` changed in v11.** With `attachStacktrace: true` (the v11 default), a message event carries a synthetic `exception` (`type: null`, `value` = message, `mechanism {type:"generic", handled:true, synthetic:true}`, a stack). Self-hosted Sentry then titled the event `Of` (the minified function name) and parsed `type:"demo"`, `value:"captureMessage info"` from the message text (observed via `GET /api/0/projects/sentry/step6-browser/events/a08d6dfc…/`). Grouping and titles of message events therefore depend on the bundle.

### 3.2 `transaction` (legacy, `traceLifecycle:'static'`)

Keys: `contexts, environment, event_id, measurements, platform, release, request, sdk, spans, start_timestamp, tags, timestamp, transaction, transaction_info, type, user`. `measurements` held `connection.rtt`, `ttfb`, `ttfb.requestTime`; `transaction_info.source` was `url`; the pageload had 9 child spans in `spans[]` (`browser.unload_event`, `browser.dns`, `resource.script`, ...). Fixture: [fixtures/transaction-static-pageload.envelope](fixtures/transaction-static-pageload.envelope).

### 3.3 `span` v2 (the v11 default, `traceLifecycle:'stream'`)

Payload: `{"version":2,"ingest_settings":{"infer_ip":"auto","infer_user_agent":"auto"},"items":[...]}`.

Each item:

| Field | Example |
|---|---|
| `name` | `Pageload`, `Navigation`, `GET 127.0.0.1`, `Click`, `127.0.0.1` (resource) |
| `span_id`, `trace_id`, `parent_span_id` | hex |
| `start_timestamp`, `end_timestamp` | seconds, float |
| `is_segment` | `true` for the root (pageload/navigation/fetch-without-parent) |
| `status` | `ok` / `error` |
| `attributes` | `{key: {"value": v, "type": "string" \| "integer" \| "double" \| "boolean"}}` |

Pageload segment attributes observed (35): `sentry.origin`, `sentry.op`, `sentry.segment.name(.source)`, `sentry.segment.id`, `sentry.sample_rate`, `sentry.trace_lifecycle=stream`, `sentry.idle_span_finish_reason=idleTimeout`, `sentry.profiler_id`, `sentry.replay_id`, `sentry.release`, `sentry.environment`, `sentry.sdk.name/version/integrations`, `sentry.is_localhost`, `url.path`, `url.full`, `thread.id/name`, `network.connection.effective_type/rtt`, `device.memory.estimated_capacity`, `device.processor_count`, `browser.web_vital.ttfb.value/request_time`, `browser.navigation.type`, `browser.performance.time_origin`, `browser.performance.navigation.activation_start`, `user.id`, `user_agent.original`, `culture.*`, `react.version`.

Names are static in v11: the URL is in `url.full`, not in the span name. The 9 pageload children (`browser.dns`, `browser.connect`, `browser.request`, `browser.response`, `browser.cache`, `browser.dom_content_loaded_event`, `browser.load_event`, `browser.unload_event`, `resource.script`) arrive in the same container as the segment. `http.client` spans carry `http.request.*` timing attributes (`fetch_start`, `domain_lookup_*`, `connect_start`, `request_start`, `response_start`, `response_end`, `time_to_first_byte`, ...), `http.response.status_code`, `http.response.body.size`, `network.protocol.*`.

Web vitals as spans: **INP** arrived as its own container with one non-segment span `Click` (`op ui.interaction.click`, `browser.web_vital.inp.value: 2552`, `browser.web_vital.inp.target: "body > div#root > main > div > button#btn-boom"`, `interaction_type: click`), parented to the pageload span ([fixtures/span-v2-inp-click.envelope](fixtures/span-v2-inp-click.envelope)). **LCP and CLS were not observed**: in stream mode they are sent as standalone spans on page hide or the next navigation (code: `B/packages/browser/src/integrations/webVitals.ts#L100-L136`, `B/packages/browser-utils/src/web-vitals/reportEvents.ts#L16-L44`), but the browser pane never produced a `largest-contentful-paint` entry (the pane was hidden and `document.hasFocus()` was false). Unverified on the wire.

### 3.4 `session`

```
{"sid":"58e7…","init":true,"started":"2026-11-10T03:35:32.467Z","timestamp":"…","status":"ok","errors":0,
 "attrs":{"release":"sentry-web-demo@1.0.0","environment":"step6","ip_address":"{{auto}}","user_agent":"Mozilla/5.0 …"}}
```

- Three updates per page in the demo: `init:true` at start, `init:false` with `did` (the user id) right after `setUser`, then `status:"unhandled"`, `errors:1` on the first error. A later handled `captureMessage` also produced an update.
- No `duration` (v11 `ignoreDuration`), no `exited` update: the browser session ends with the page and is never closed on the wire.
- `ip_address: "{{auto}}"` asks Relay to fill the IP (v11 default).
- One new `sid` per page load, including same-tab reloads (v11 `lifecycle:'page'`).

### 3.5 `log` container

```
{"items":[{"timestamp":1794281753.0942,"level":"info","body":"user demo-user-1 opened checkout","trace_id":"…","severity_number":9,
  "attributes":{"demo.step":{"value":1,"type":"integer"},"sentry.message.template":{"value":"user %s opened %s","type":"string"},
  "sentry.message.parameter.0":{…},"user.id":{…},"sentry.release":{…},"sentry.environment":{…},"sentry.sdk.name":{…},
  "sentry.sdk.version":{…},"sentry.replay_id":{…},"sentry.timestamp.sequence":{"value":0,"type":"integer"}}}, …]}
```

- `severity_number` follows OTel (info 9, warn 13, error 17). `console.warn` via `consoleLoggingIntegration` adds `sentry.origin: auto.log.console`.
- `logger.fmt` sends the template and parameters as attributes.
- `trace_id` is set; there is no `span_id`.
- Logs flowed without any `enableLogs` option (removed in v11, see [configuration.md](configuration.md)).

### 3.6 `trace_metric` container

Items: `{"timestamp", "trace_id", "name", "type": "counter"|"gauge"|"distribution", "value", "unit"?, "attributes"}`. Same attribute style as logs, with `sentry.timestamp.sequence`. One item per call; no client-side aggregation was seen (three calls, three items).

### 3.7 `profile_chunk` (UI profiling, `profileLifecycle:'trace'`)

Payload keys: `chunk_id, client_sdk, debug_meta {images: []}, environment, platform: "javascript", profile {frames, samples, stacks, thread_metadata}, profiler_id, release, version: "2"`. A sample is `{"stack_id", "thread_id": "0", "timestamp"}` (seconds); a frame is `{"function", "abs_path", "lineno", "colno"}`. 79 samples in a 1 s pageload chunk. The `profiler_id` also appears in `contexts.profile` of errors and in `sentry.profiler_id` on spans. Requires the `Document-Policy: js-profiling` response header on the HTML (the demo's Vite config sets it). The envelope has no `trace` header.

### 3.8 `feedback`

`{"type":"feedback"}` with an event-like payload: `type:"feedback"`, `level:"info"`, `contexts.feedback {message, name, contact_email, replay_id}`, plus the usual `contexts.trace`, `tags`, `user`, `request`, `breadcrumbs`. The screenshot is an `attachment` item in the same envelope (`filename:"screenshot.png"`, `content_type:"image/png"`, PNG bytes). The demo used `captureFeedback` with an attachment, which is what the widget does after the user submits; the widget UI itself was not clicked through. Replay recorded a `sentry.feedback` breadcrumb with `feedbackId`.

### 3.9 `client_report`

```
{}
{"type":"client_report"}
{"timestamp":1794281901.452,"discarded_events":[{"reason":"ratelimit_backoff","category":"span","quantity":10},
 {"reason":"ratelimit_backoff","category":"replay","quantity":4},{"reason":"ratelimit_backoff","category":"error","quantity":3}]}
```

Reasons observed: `before_send` (beforeSend returned null), `sample_rate` (`sampleRate: 0`), `ratelimit_backoff` (after a 429 with categories), `network_error` (CORS-blocked 429), `no_parent_span` (a fetch outside any active span with `traceLifecycle:'static'`). Client reports were sent **only** on `visibilitychange` to hidden or on unload (a report from the previous page arrived right after a navigation). `Sentry.flush()` did not send one. The envelope header is `{}`.

### 3.10 `replay_event` and `replay_recording`

See [replay-browser.md](replay-browser.md) for the mechanics. Observed:

- Envelope header `event_id` = `replay_id`; no `trace` header.
- `replay_event` fields: `type:"replay_event"`, `replay_id`, `segment_id`, `replay_type` (`session` or `buffer`), `replay_start_timestamp`, `timestamp`, `error_ids[]`, `trace_ids[]`, `segment_names[]` (span names such as `Pageload`, `GET 127.0.0.1`), `urls[]`, `request {url, headers}`, `contexts`, `environment`, `release`, `sdk` (with `settings.infer_ip`), `tags`, `user`, `transaction`, `platform`, `event_id` (= replay id). `segment_names` is not in older docs.
- `replay_recording`: item header `{"type":"replay_recording","length":N}`, payload `{"segment_id":N}\n` followed by a **zlib** stream (first bytes `78 9c`, deflate inside a zlib wrapper, not gzip) of a JSON array of rrweb events. Every captured segment was compressed by the worker.
- The `options` custom event said `"useCompression": false` while the bytes were compressed. The flag is written before the worker has loaded, so it is not evidence of how the payload is encoded; check the first byte instead.
- Event census over the decoded fixtures: rrweb types 2 (FullSnapshot), 3 (IncrementalSnapshot: sources 0 mutation, 2 mouse interaction, 4 viewport resize, 5 input), 4 (Meta), 5 (Custom). Custom tags: `options`, `breadcrumb` (`console`, `navigation`, `ui.click`, `ui.focus`, `sentry.feedback`), `performanceSpan` (`memory`, `navigation.navigate`, `navigation.push`, `paint`, `resource.fetch`, `resource.script`, `web-vital`).
- Timestamps (census of every type-5 event in all captured recordings): rrweb core events (types 2, 3, 4) and the `options` event have a top-level `timestamp` in **milliseconds**. Every `performanceSpan` (44 events: memory, navigation.*, paint, resource.*, web-vital) has a top-level `timestamp` in **float seconds**. `breadcrumb` events are mostly milliseconds (console, navigation, ui.click, sentry.feedback) but `ui.focus` (2 of 2) came in **seconds**. Inside the payloads (`data.payload.timestamp`, `startTimestamp`, `endTimestamp`) the unit is always seconds. This **confirms** the read-api finding of mixed units in @sentry/react 11.11.0 replays ([../read-apis/replays.md](../read-apis/replays.md)); a converter must normalise per event (for example: values below 1e12 are seconds).
- Masking: text nodes became runs of `*` with spaces kept (`"****** * ***"`); the input value `secret value 123` was recorded as `"****************"` (same length). Element ids and attributes such as `id="secret"` are not masked.
- Network details: with `networkDetailAllowUrls` matching `/api/`, `resource.fetch` spans carried response headers and the JSON body. The body included the echoed `baggage` (so a recording can contain the DSN public key; the fixtures were re-encoded with the key zeroed).
- Canvas: with `replayCanvasIntegration` the `options` event said `shouldRecordCanvas: true`, but no canvas mutation events were recorded in the hidden pane. Unverified.

## 4. Sequences observed

**Session-mode page load** (forward run, seconds after init): session (0.0) → session update after `setUser` (0.05) → profile_chunk (1.0) → span container with the pageload segment and 9 children (1.5) → replay segment 0 (5.1, `{"segment_id":0}`, Meta + FullSnapshot + options).

**Buffer mode, error at t=24 s**: nothing replay-related for 24 s; spans and profile chunks as usual → at the error: session update, the error event, and replay segment 0 (`replay_type:"buffer"`, `error_ids:[the error]`) in the same second → segment 1 five seconds later. The session stored in `sessionStorage` kept `sampled:"buffer"` after the conversion, and a same-tab reload continued as `replay_type:"buffer"` with the next segment id.

**Reload in the same tab**: the replay id and segment counter continued (`sentryReplaySession` = `{"id":"bb6e…","started":…,"lastActivity":…,"segmentId":8,"sampled":"session","dirty":false}`); the release-health session got a new `sid`. Segment ids also advanced for segments that were dropped by the rate limiter (stored 8 while the server had 5).

**Tab closed 300 ms after activity** (navigate to `about:blank`): the error event, the session update and a span container arrived; the pending replay segment (the typed input and the navigation) **never arrived**. Replay data from the last up-to-5 s before a close is lost.

**Offline transport**: with the DSN pointing at a closed port, six envelopes (sessions, spans, an error, a replay segment) were stored in IndexedDB database `sentry-offline`, object store `queue`, as serialized strings (replay as `Uint8Array`). One key was `-1` (a failed send put back at the front). After a reload with a working DSN, all six were sent within one second of start-up (`flushAtStartup: true`) and the queue was empty.

**Rate limit (429 with `X-Sentry-Rate-Limits: 60:error;transaction;span;replay:organization`)**: after the first 429, errors, spans and replay segments were not sent; sessions, profile chunks, logs and trace metrics (categories not in the header) still were. On hide, one client report listed `ratelimit_backoff` for span 10, replay 4, error 3. The replay recorder stayed enabled, because the transport dropped the items before any request was made (see [reliability.md](reliability.md) section 8).

## 5. What this means for ouo (topologies a, b, c)

- (b) A collector receiver placed in front of browsers must speak CORS exactly like Relay, accept `text/plain` and untyped bodies, read the key from the query string, and answer `{"id":…}` or `{}`.
- The DSC is in the envelope header of errors, transactions, spans and feedback, but **not** of replay, profile, log, metric or session envelopes. Linking those needs ids inside the payloads (`replay_id` in log/metric attributes and span attributes, `profiler_id`, `trace_id` in logs).
- Spans are v2 containers by default in 11.x, with typed attributes; a receiver written for 10.x `transaction` events would see nothing from 11.x SDKs with default options.
- Client reports are the only loss signal and come only on page hide.

## 6. Fields the browser sends that the wire-format files do not mention

Checked against [../wire-format/](../wire-format/index.md) (grep, 2026-11-10). Relay accepted all of them (200).

| Where | Field | Observed value |
|---|---|---|
| span v2 container | `ingest_settings` next to `version` and `items` | `{"infer_ip":"auto","infer_user_agent":"auto"}` |
| event / replay_event `sdk` | `settings.infer_ip` | `"auto"` (v11 default without `dataCollection`) |
| log and trace_metric items | attribute `sentry.timestamp.sequence` | integer, orders items with equal timestamps |
| log / trace_metric / span attributes | `sentry.replay_id`, `sentry.profiler_id` | the only link from these envelopes to a replay or profile, since their envelopes carry no DSC |
| replay recording | `options` custom event fields `useCompression`, `useCompressionOption`, `shouldRecordCanvas`, `networkDetailHasUrls`, ... | see section 3.10; `useCompression:false` even when the payload is zlib |
| client_report | reason `no_parent_span` | for a fetch outside any span with `traceLifecycle:'static'` |
| HTTP request | `Content-Type` absent for binary envelopes (replay, PNG attachment) | not only `text/plain` |
