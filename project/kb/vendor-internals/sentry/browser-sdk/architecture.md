# Sentry browser SDK: architecture (init, client, scopes, integrations, transport, envelopes)

- Package: `@sentry/browser` **11.11.0** (tag 2026-11-05). Compared with **10.78.0**.
- Research date: 2026-11-10.
- `B` = https://github.com/getsentry/sentry-javascript/blob/11.11.0 . `B10` = the same path at tag `10.78.0`.
- Every claim is marked **(code)** (read in the tagged source) or **(docs, accessed 2026-11-10)**. `MIGRATION.md` is the in-repo migration guide at the same tag, so it counts as docs.
- Siblings: [sampling.md](sampling.md), [reliability.md](reliability.md), [configuration.md](configuration.md), [wire-capture.md](wire-capture.md), [replay-browser.md](replay-browser.md). The feature list lives in [../../../client-sdk-features/vendors/sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md); this file does not repeat it.

## Why this matters for ouo

If we read Sentry data or receive the same envelopes through an OTel Collector, we must know which code path builds each envelope, which header fields exist, what gets dropped before the wire, and which client report explains the drop.

## 1. Init flow

| Step | What happens | Where |
|---|---|---|
| 1 | `init(options)` checks for an embedded browser extension. If it finds one, it sets `enabled: false`. | B/packages/browser/src/sdk.ts#L97-L99, #L122 (code) |
| 2 | Default integrations are built: `EventFilters`, `FunctionToString`, `ConversationId`, `BrowserApiErrors`, `Breadcrumbs`, `Console`, `GlobalHandlers`, `LinkedErrors`, `Dedupe`, `HttpContext`, `CultureContext`, `BrowserSession`. | B/packages/browser/src/sdk.ts#L30-L49 (code) |
| 3 | `getIntegrationsToSetup` merges defaults and user integrations. Later entries with the same name win, but a default never overwrites a user instance. | B/packages/core/src/integration.ts#L25-L69 (code) |
| 4 | `tunnel: true` or an object is resolved to a same-origin path, and `Content-Type: application/x-sentry-envelope` is forced for that tunnel. A string tunnel is left as is. | B/packages/browser/src/sdk.ts#L121, B/packages/browser/src/utils/managedTunnel.ts#L15-L42 (code) |
| 5 | Transport defaults to `makeFetchTransport`. | B/packages/browser/src/sdk.ts#L125 (code) |
| 6 | `initAndBind` warns if a live client exists, applies `initialScope` to the current scope, builds the client, sets it on the current scope, calls `client.init()`. | B/packages/core/src/sdk.ts#L18-L42, #L76-L78 (code) |
| 7 | `BrowserClient` constructor: applies defaults (`sendClientReports: true`, `parentSpanIsAlwaysRootSpan: true`, release from `__SENTRY_RELEASE__` or `window.SENTRY_RELEASE.id`), sets SDK metadata `browser` and SDK source, sets `_unhandledSessionStatus = 'unhandled'`, sets `sdk.settings.infer_ip` from `dataCollection.userInfo`, installs page listeners. | B/packages/browser/src/client.ts#L124-L205, #L241-L252 (code) |
| 8 | Core `Client` constructor: defaults `attachStacktrace: true`, normalizes `traceLifecycle` to `'stream'` unless it is exactly `'static'`, builds the client promise buffer, parses the DSN, builds the transport with the envelope URL, wires log and metric weight flushing. | B/packages/core/src/client.ts#L261-L329 (code) |
| 9 | `client.init()` runs `_setupIntegrations()` only if the client is enabled (enabled flag and a transport exist) or a Spotlight integration is present. | B/packages/core/src/client.ts#L548-L563, #L1445-L1447 (code) |
| 10 | `_setupIntegrations` = `setupIntegrations` then `afterSetupIntegrations`. | B/packages/core/src/client.ts#L1378-L1382 (code) |

Consequence: without a DSN there is no transport, so `_isEnabled()` is false and **no integration is set up** (no global handlers, no breadcrumbs). (code, B/packages/core/src/client.ts#L304-L314, #L1445-L1447)

The envelope URL is `<protocol>//<host>[:port][/path]/api/<projectId>/envelope/?sentry_version=7&sentry_key=<publicKey>&sentry_client=<name>/<version>`. With a tunnel, the URL is the tunnel string and no auth query is added. (code, B/packages/core/src/api.ts#L9-L46)

## 2. The client

### 2.1 Error capture path

`Sentry.captureException` → `getCurrentScope().captureException` → `client.captureException(exception, hint, scope)`. (code, B/packages/core/src/exports.ts#L27-L29, B/packages/core/src/scope.ts#L674-L690)

| Function | Role | Where |
|---|---|---|
| `captureException` | New `event_id` (uuid4). Skips an object already captured. Queues `eventFromException → _captureEvent` in the client promise buffer under category `error`. | B/packages/core/src/client.ts#L335-L358 (code) |
| `captureEvent` | Same, but uses `capturedSpanScope` / `capturedSpanIsolationScope` from `sdkProcessingMetadata` when present (span-ended transactions). | B/packages/core/src/client.ts#L402-L426 (code) |
| `_process` | Adds the task to `_promiseBuffer`. If full, records `queue_overflow` for that category. | B/packages/core/src/client.ts#L1688-L1706 (code) |
| `_captureEvent` | Calls `_processEvent` and turns rejections into debug logs. Returns `event_id` or `undefined`. | B/packages/core/src/client.ts#L1510-L1536 (code) |
| `_processEvent` | Error sampling, `_prepareEvent`, `beforeSend*`, session update, drop outcomes, `sendEvent`. | B/packages/core/src/client.ts#L1552-L1683 (code) |
| `_prepareEvent` (browser) | Sets `platform = 'javascript'`, then calls core. | B/packages/browser/src/client.ts#L228-L237 (code) |
| `_prepareEvent` (core) | Emits `preprocessEvent`, sets last event id on isolation scope, runs `prepareEvent`, emits `postprocessEvent`, merges trace context from the current scope, puts the scope DSC in `sdkProcessingMetadata.dynamicSamplingContext` (a span DSC already there wins). | B/packages/core/src/client.ts#L1463-L1501 (code) |
| `sendEvent` | Emits `beforeSendEvent`, extracts gen_ai spans, `createEventEnvelope`, appends attachments, `sendEnvelope`, then emits `afterSendEvent` with the transport response. | B/packages/core/src/client.ts#L605-L627 (code) |
| `sendEnvelope` | Emits `beforeEnvelope`. If enabled, `transport.send`, then `afterEnvelope`. Errors are swallowed and return `{}`. | B/packages/core/src/client.ts#L1331-L1349 (code) |
| `recordDroppedEvent(reason, category, count)` | If `sendClientReports`, increments `_outcomes["reason:category"]`. Nothing is sent here. | B/packages/core/src/client.ts#L665-L677 (code) |
| `flush(timeout)` | Emits `flush` (drains log, metric and span buffers), waits for processing, then `transport.flush`. | B/packages/core/src/client.ts#L495-L511 (code) |
| `close(timeout)` | Marks the client closed, flushes, sets `enabled = false`, emits `close`. | B/packages/core/src/client.ts#L522-L528 (code) |

A sampled-out error still runs the full pipeline when a session with status `ok` exists, so the session can be marked errored. Only after that is it dropped with `sample_rate`. Without such a session it is dropped before processing. (code, B/packages/core/src/client.ts#L1576-L1584, #L1633-L1640)

Session update rule: the first error sets `errors: 1`. An unhandled exception (`mechanism.handled === false`) or `level: 'fatal'` sets status to `unhandled` in the browser. (code, B/packages/core/src/client.ts#L1385-L1417, B/packages/browser/src/client.ts#L135-L136)

Sessions without a release are silently not sent (debug warning only, no client report). (code, B/packages/core/src/client.ts#L632-L651)

### 2.2 Two promise buffers, not one

| Buffer | Size | What it guards | Drop reason |
|---|---|---|---|
| Client `_promiseBuffer` | `transportOptions.bufferSize ?? DEFAULT_TRANSPORT_BUFFER_SIZE` = **64** | Event processing (errors, messages, transactions) before an envelope exists | `queue_overflow` with the event category |
| Browser transport buffer | `options.bufferSize \|\| DEFAULT_BROWSER_TRANSPORT_BUFFER_SIZE` = **40** | In-flight HTTP requests | `queue_overflow` per envelope item |

Sources: B/packages/core/src/client.ts#L274, B/packages/core/src/transports/base.ts#L22, B/packages/browser/src/transports/fetch.ts#L7, #L67 (code). Logs, metrics, streamed spans, sessions, replays and client reports call `sendEnvelope` directly. They only meet the transport buffer.

### 2.3 Hooks (`client.on(...)`)

`on()` wraps each callback so the same function can be registered twice. It returns an unsubscribe function. `emit()` calls callbacks synchronously in insertion order. (code, B/packages/core/src/client.ts#L1032-L1051, #L1320-L1325)

Every hook name declared in 11.11.0 (code, `on` overloads in B/packages/core/src/client.ts):

| Group | Hooks (line of the `on` overload) |
|---|---|
| Span lifecycle | `spanStart` L685, `prepareSpanScope` L694, `beforeSampling` L704, `spanEnd` L723, `beforeIdleSpanEnd` L726, `afterSpanEnd` L732, `afterSegmentSpanEnd` L738, `idleSpanEnableAutoFinish` L760, `flushTraceSpans` L939 |
| Streamed span processing | `preprocessSpan` L744, `processSpan` L749, `processSegmentSpan` L754 |
| Envelope | `beforeEnvelope` L766, `afterEnvelope` L772 |
| Event pipeline | `applyFrameMetadata` L778, `beforeSendEvent` L786, `preprocessEvent` L801, `postprocessEvent` L809, `afterSendEvent` L816 |
| Sessions | `beforeSendSession` L793, `startRequestSession` L925 |
| Breadcrumbs | `beforeAddBreadcrumb` L824 |
| DSC | `createDsc` L830 |
| Feedback | `beforeSendFeedback` L839, `openFeedbackWidget` L846 |
| Replay | `replayStart` L852, `replayEnd` L859 |
| Browser routing | `startPageLoadSpan` L866, `endPageloadSpan` L877, `afterStartPageLoadSpan` L883, `beforeStartNavigationSpan` L890, `startNavigationSpan` L899 |
| Outgoing HTTP | `beforeOutgoingRequestSpan` L908, `beforeOutgoingRequestBreadcrumb` L917 |
| Lifecycle | `flush` L931, `close` L945 |
| Logs | `beforeCaptureLog` L952, `afterCaptureLog` L959, `flushLogs` L966 |
| Metrics | `afterCaptureMetric` L973, `flushMetrics` L980, `processMetric` L987 |
| Server only | `httpServerRequest` L996, `orchestrion.module-injected` L1027 |
| Profiling | `startUIProfiler` L1007, `stopUIProfiler` L1016 |

For ouo, `beforeEnvelope` is the cleanest tap to mirror every envelope; it fires even when the transport is disabled. `afterSendEvent` carries the HTTP status. (code, B/packages/core/src/client.ts#L1332, #L626)

## 3. Scopes

Three scopes are merged for every event: **global → isolation → current**. (code, B/packages/core/src/utils/scopeData.ts#L110-L115)

| Scope | Browser source | Notes |
|---|---|---|
| Global | `getGlobalSingleton('globalScope')` | Applies to all events. B/packages/core/src/currentScopes.ts#L57-L59 (code) |
| Isolation | default stack strategy, `getDefaultIsolationScope()` | Breadcrumbs go here. B/packages/core/src/breadcrumbs.ts#L46 (code) |
| Current | top of the `AsyncContextStack` | `init` puts the client here. B/packages/core/src/sdk.ts#L76-L78 (code) |

The browser registers no async context strategy, so `getAsyncContextStrategy` falls back to the stack strategy. (code, B/packages/core/src/asyncContext/index.ts#L22-L30) The stack is created lazily with the default current and isolation scopes. In the stack strategy, `withIsolationScope` pushes a new current scope and passes the **same** isolation scope. `withSetIsolationScope` ignores its argument. (code, B/packages/core/src/asyncContext/stackStrategy.ts#L122-L165) So in the browser there is effectively one isolation scope per page.

Merge rules in `mergeScopeData` (code, B/packages/core/src/utils/scopeData.ts#L23-L73):
- `extra`, `tags`, `attributes`, `user`, `contexts`: shallow merge, later scope wins per key.
- `level`, `transactionName`: later scope wins if set.
- `breadcrumbs`, `fingerprint`, `eventProcessors`, `attachments`: concatenated (global first).
- `propagationContext`: shallow merge.

Apply to event, `applyScopeDataToEvent` (code, B/packages/core/src/utils/scopeData.ts#L13-L20, #L117-L156):
1. Data: `extra`, `tags`, `user`, `contexts` are spread **under** the event (event keys win). `level` overrides. `transactionName` sets `event.transaction` for non-transaction events.
2. Fingerprint.
3. Breadcrumbs: the event's own first, then scope breadcrumbs.
4. `sdkProcessingMetadata` merged.

Then the active span adds `contexts.trace` and the span DSC (B/packages/core/src/utils/scopeData.ts#L159-L175), and escaped-error span attribution runs. (code, B/packages/core/src/utils/prepareEvent.ts#L94-L103)

## 4. Integration lifecycle

Integration members: `name`, `setupOnce`, `beforeSetup`, `setup`, `afterAllSetup`, `preprocessEvent`, `processEvent`, `processSpan`, `processSegmentSpan`. (code, B/packages/core/src/types/integration.ts#L10-L67)

Order inside `setupIntegrations` (code, B/packages/core/src/integration.ts#L77-L152):
1. `beforeSetup(client)` for **all** integrations.
2. Per integration, `setupIntegration`: skip if the name is already in this client's index; run `setupOnce()` only if the name is not in the module-global `installedIntegrations` array; run `setup(client)`; register `preprocessEvent` as a `preprocessEvent` hook; register `processEvent` as a client event processor with `id = name`; register `processSpan` / `processSegmentSpan` as hooks.
3. Then `afterAllSetup(client)` for all.

`installedIntegrations` is module-global (B/packages/core/src/integration.ts#L10), so a second `init()` does not re-run `setupOnce` (global handlers are not patched again).

`client.addIntegration(i)` after init: runs `beforeSetup` only if new, then `setupIntegration`, then `afterAllSetup` only if new. (code, B/packages/core/src/client.ts#L587-L600) `Sentry.addIntegration` does nothing without a client. (code, B/packages/core/src/integration.ts#L155-L164)

### Lazy loading

`lazyLoadIntegration(name, nonce?)` accepts only 18 names: `replayIntegration`, `replayCanvasIntegration`, `feedbackIntegration`, `feedbackModalIntegration`, `feedbackScreenshotIntegration`, `captureConsoleIntegration`, `contextLinesIntegration`, `linkedErrorsIntegration`, `dedupeIntegration`, `extraErrorDataIntegration`, `graphqlClientIntegration`, `httpClientIntegration`, `reportingObserverIntegration`, `rewriteFramesIntegration`, `browserProfilingIntegration`, `userTimingIntegration`, `interactionsIntegration`, `moduleMetadataIntegration`. (code, B/packages/browser/src/utils/lazyLoadIntegration.ts#L9-L28)

- URL: `new URL('/' + SDK_VERSION + '/' + bundle + '.min.js', cdnBaseUrl || 'https://browser.sentry-cdn.com')`. (code, #L112-L117)
- The script gets `crossOrigin = 'anonymous'`, `referrerPolicy = 'strict-origin'`, an optional `nonce`, and is appended to `body` or `head`. (code, #L73-L95)
- It returns `window.Sentry[name]`. A feedback shim (`_isShim`) does not count as loaded. (code, #L64-L71, #L103-L109)
- It returns the integration **function**. The caller still calls `Sentry.addIntegration(fn())`.

Span streaming is installed lazily, not by `init()`. The first browser `startSpan*` call, or `browserTracingIntegration.afterAllSetup`, adds `spanStreamingIntegration` when `traceLifecycle === 'stream'`. This keeps error-only bundles small. (code, B/packages/core/src/tracing/browserSpanApi.ts#L13-L41, B/packages/browser/src/tracing/browserTracingIntegration.ts#L612-L620)

## 5. Event processor order

Inside `prepareEvent` (code, B/packages/core/src/utils/prepareEvent.ts#L46-L152):
1. Copy the event, set `event_id`, `timestamp`.
2. `applyClientOptions`: `environment` (default `production`), `release`, `dist`, truncate `request.url` and exception values to `maxValueLength`.
3. `sdk.integrations` metadata.
4. Emit `applyFrameMetadata`.
5. Debug IDs on frames (errors only).
6. Merge scopes, apply scope data, apply the active span, escaped-error attribution.
7. Processors: **client processors** (integrations' `processEvent`, in setup order) **then scope processors** (global, isolation, current). Each gets a shallow copy. Returning `null` drops with `event_processor`. Throwing drops with `callback_error`. Transactions also record `1 + spans` `span` outcomes. (code, #L105-L127, B/packages/core/src/eventProcessors.ts#L29-L71)
8. Spans removed by processors are recorded as `event_processor:span`. (code, #L134-L139)
9. `debug_meta`, then `normalize` to `normalizeDepth` (default 3) and `normalizeMaxBreadth` (default 1000). (code, #L54, #L145-L150)

After `prepareEvent` come `beforeSend` / `beforeSendTransaction` (section 9).

## 6. Breadcrumbs

`addBreadcrumb` (code, B/packages/core/src/breadcrumbs.ts#L20-L47):
- Needs a client. `maxBreadcrumbs` defaults to 100. `<= 0` disables.
- Adds `timestamp`, runs `beforeBreadcrumb` inside `consoleSandbox` and `safeCallback`. A throw or `null` drops silently (no client report).
- Emits `beforeAddBreadcrumb`, then stores on the **isolation** scope.

`Scope.addBreadcrumb` truncates `message` to 2048 chars and keeps the last `maxBreadcrumbs`. (code, B/packages/core/src/scope.ts#L567-L590)

## 7. Transport

### 7.1 `makeFetchTransport`

(code, B/packages/browser/src/transports/fetch.ts#L12-L69)

| Aspect | Value |
|---|---|
| fetch impl | `getNativeImplementation('fetch')`, taken once when the transport is built |
| Method / body | `POST`, serialized envelope |
| `referrerPolicy` | `'strict-origin'` |
| Headers | `options.headers` only. No default Content-Type. A managed tunnel adds `application/x-sentry-envelope`. |
| `keepalive` | `pendingBodySize <= 60_000 && pendingCount < 15` |
| Override | `...options.fetchOptions` is spread last, so it can override `keepalive` |
| Response | `{ statusCode, headers: { 'x-sentry-rate-limits', 'retry-after' } }` |
| On throw | clears the cached fetch, rethrows |
| Buffer | 40 |

The keepalive budget:
- `pendingBodySize` and `pendingCount` are incremented **before** `keepalive` is computed, so the current request counts. They are decremented in `finally`. (code, #L16-L22, #L58-L61)
- The comment cites the Fetch spec 64 KiB in-flight keepalive limit, but the code threshold is **60,000**. (code, #L33-L40)
- `request.body.length` is the size. For a string body this counts UTF-16 code units, not bytes. Non-ASCII payloads can pass the check and still exceed the real 64 KiB. (inference from code, #L20)

`getNativeImplementation` (code, B/packages/browser-utils/src/getNativeImplementation.ts#L27-L72):
- Returns a cached, `window`-bound function.
- If `window.fetch` looks native, it is used. Otherwise a hidden iframe is created, its `contentWindow.fetch` is taken, and the iframe is removed. This bypasses fetch wrappers, including Sentry's own, so SDK requests make no spans or breadcrumbs.
- `clearCachedImplementation('fetch')` after a failure forces a new probe next time.

`sendBeacon` is not used anywhere in the browser, browser-utils, core or replay sources. (code, grep of `packages/*/src` at the tag)

### 7.2 `createTransport` (core)

(code, B/packages/core/src/transports/base.ts#L30-L132)

1. For each envelope item, map the item type to a data category. If rate-limited, record `ratelimit_backoff` and drop the item. A transaction item also records `1 + spans` `span` outcomes. `item_count` is honored. (#L40-L59)
2. If nothing is left, resolve `{}` without a request. (#L62-L64)
3. Rebuild the envelope with the same header and the remaining items.
4. Request task: `makeRequest({ body: serializeEnvelope(...) })`.
   - 413: record `send_error` for every item, return the response. (#L86-L93)
   - Any other status: update rate limits from the response, return it. Non-2xx is not an error. (#L96-L105)
   - Network error: record `network_error` for every item, rethrow. (#L107-L111)
5. `buffer.add(task)`. If full, record `queue_overflow` for every item and resolve `{}`. (#L114-L125)
6. An envelope that contains a `client_report` item never records outcomes about itself. (#L69-L74)

There is **no retry** in the base transport. Retries exist only in the offline transport and in replay (see [reliability.md](reliability.md)).

`makePromiseBuffer(limit)` is a `Set` of in-flight promises. `add` rejects with `SENTRY_BUFFER_FULL_ERROR` when `size >= limit`. Tasks start at once. `drain(timeout)` waits for all (allSettled) or resolves `false` on timeout. (code, B/packages/core/src/utils/promisebuffer.ts#L18-L96)

### 7.3 Multiplexed transport

`makeMultiplexedTransport(createTransport, matcher?)` (code, B/packages/core/src/transports/multiplexed.ts#L93-L177):
- The default matcher reads `event.extra.MULTIPLEXED_TRANSPORT_EXTRA_KEY` (array of DSN strings or `{dsn, release}`).
- One transport per `dsn[:release]`, cached in a `Map`. Each gets its URL from that DSN (or the tunnel).
- The envelope header `dsn` is overwritten with the target DSN. With a release, `release` is overwritten on `event`, `transaction`, `profile`, `replay_event` items. (#L52-L84)
- No match → fallback transport, header untouched.
- Sends to all targets in parallel and returns the **first** result. `flush` flushes all.

## 8. Envelope creation

### 8.1 Builders

| Envelope | Builder | Header fields | Items |
|---|---|---|---|
| Event / transaction | `createEventEnvelope` | `event_id`, `sent_at`, `sdk {name, version}`, `dsn` (only with a tunnel), `trace` (DSC from `sdkProcessingMetadata.dynamicSamplingContext`) | `[{type}, event]`; `sdkProcessingMetadata` deleted; `event.sdk` merged with integrations, packages, settings |
| Session | `createSessionEnvelope` | `sent_at`, `sdk`, `dsn` (tunnel) | `session`, or `sessions` for aggregates |
| Client report | `createClientReportEnvelope` | `dsn` only with a tunnel | `client_report {timestamp, discarded_events}` |
| Streamed spans | `createStreamedSpanEnvelope` | `sent_at`, `trace` (only if the DSC has `trace_id` and `public_key`), `sdk`, `dsn` (tunnel) | one `span` item, `item_count`, `content_type: application/vnd.sentry.items.span.v2+json`, body `{version: 2, ingest_settings: {infer_ip, infer_user_agent}, items}` |
| Logs | `createLogEnvelope` | `sdk`, `dsn` (tunnel). **No `sent_at`, no `trace`.** | one `log` item, `item_count`, `content_type: application/vnd.sentry.items.log+json`, `{version: 2, ingest_settings?, items}` |
| Replay | `createReplayEnvelope` | via `createEventEnvelopeHeaders` | `replay_event` + `replay_recording` |

Sources (code): B/packages/core/src/envelope.ts#L52-L103; B/packages/core/src/utils/envelope.ts#L237-L253; B/packages/core/src/utils/clientreport.ts#L11-L24; B/packages/core/src/tracing/spans/envelope.ts#L12-L53; B/packages/core/src/logs/envelope.ts#L17-L68; B/packages/replay-internal/src/util/createReplayEnvelope.ts#L8-L20.

`infer_ip` / `infer_user_agent` are `'auto'` only when `dataCollection.userInfo` is on, else `'never'`. (code, B/packages/core/src/tracing/spans/envelope.ts#L39-L45, B/packages/browser/src/client.ts#L138-L147)

`sent_at` is `new Date(safeDateNow()).toISOString()`. The offline transport rewrites it on retry. (code, B/packages/core/src/utils/envelope.ts#L246, B/packages/core/src/transports/offline.ts#L113)

`createSpanEnvelope` (v1 standalone span envelope) no longer exists in 11.x. (code: absent from B/packages/core/src/envelope.ts; docs, B/MIGRATION.md#L1541)

### 8.2 Serialization

`serializeEnvelope` writes `JSON(header)\nJSON(itemHeader)\npayload...` as one string and switches to `Uint8Array` once any payload is binary. A payload that fails `JSON.stringify` is normalized and tried again. (code, B/packages/core/src/utils/envelope.ts#L90-L128)

### 8.3 Data category mapping

`envelopeItemTypeToDataCategory` overrides: `sessions→session`, `event→error`, `client_report→internal`, `user_report→default`, `profile_chunk→profile`, `replay_event→replay`, `replay_recording→replay`, `check_in→monitor`, `raw_security→security`, `log→log_item`, `metric→trace_metric`. All others map to themselves (`session`, `attachment`, `transaction`, `profile`, `feedback`, `span`, `trace_metric`). (code, B/packages/core/src/utils/envelope.ts#L196-L222)

## 9. `before*` callbacks

| Callback | Called where | On `null` | On throw |
|---|---|---|---|
| `beforeSend` (errors: `type === undefined`) | `processBeforeSend`, after event processors | `before_send` + category | `callback_error` |
| `beforeSendTransaction` | same; only with `traceLifecycle: 'static'` (stream mode makes no transactions) | `before_send:transaction` + `before_send:span` × (1 + spans − ignored) | `callback_error` |
| `beforeSendSpan` (static) | must be wrapped with `withStaticSpan`; applied per span inside the transaction | cannot drop: `null` keeps the original span | span sent unmodified |
| `beforeSendSpan` (stream) | `captureSpan`, after `preprocessSpan` / `processSegmentSpan` / `processSpan` hooks | cannot drop | span sent unmodified |
| `ignoreSpans` (static, at send) | root match drops the transaction (`ignored`); child match reparents its children, records `ignored:span` | | |
| `ignoreSpans` (stream, at span start) | `_shouldIgnoreStreamedSpan` returns a non-recording span, records `ignored:span` | | |
| `beforeSendLog` | `_INTERNAL_captureLog`, after `beforeCaptureLog` | `before_send:log_item` | `callback_error:log_item` |
| `beforeSendMetric` | `_INTERNAL_captureMetric`, after `processMetric` | `before_send:trace_metric` | `callback_error:trace_metric` |
| `beforeBreadcrumb` | `addBreadcrumb` | silent drop | silent drop |

Sources (code): B/packages/core/src/client.ts#L1610-L1631, #L1772-L1868; B/packages/core/src/tracing/spans/beforeSendSpan.ts#L26-L74; B/packages/core/src/tracing/spans/captureSpan.ts#L63-L86; B/packages/core/src/tracing/trace.ts#L366-L385, #L636-L645; B/packages/core/src/logs/internal.ts#L159-L174; B/packages/core/src/metrics/internal.ts#L195-L211; B/packages/core/src/breadcrumbs.ts#L32-L40.

Feedback events have `type: 'feedback'`, so neither `sampleRate` nor `beforeSend` applies. (code, B/packages/core/src/feedback.ts#L26, B/packages/core/src/client.ts#L1870-L1872)

If a user event processor renames a transaction, the SDK sets `transaction_info.source = 'custom'`. (code, B/packages/core/src/client.ts#L1650-L1659)

## 10. Client reports

- Enabled by default in the browser (`sendClientReports: true`). (code, B/packages/browser/src/client.ts#L247)
- Kept in memory as `"reason:category" → count`. (code, B/packages/core/src/client.ts#L665-L677)
- **Sent only when the page becomes hidden** (`visibilitychange` → `hidden` → `_flushOutcomes()`). There is no interval timer in the browser client, and `flush()` / `close()` do not send them. A page that is never hidden never sends its outcomes. (code, B/packages/browser/src/client.ts#L160-L187; B/packages/core/src/client.ts#L1727-L1749)
- Needs a DSN. `dsn` goes in the header only with a tunnel. (code, B/packages/core/src/client.ts#L1737-L1746)
- `client_report` maps to category `internal`, so only an `all` or `internal` rate limit drops it.

Discard reasons, `EventDropReason` (code, B/packages/core/src/types/clientreport.ts#L3-L16):

| Reason | Emitted by (11.11.0) |
|---|---|
| `before_send` | `beforeSend*`, `beforeSendLog`, `beforeSendMetric` returned `null` |
| `callback_error` | a user callback threw (new in 11) |
| `event_processor` | an event processor returned `null` |
| `network_error` | fetch threw |
| `queue_overflow` | client or transport buffer full |
| `ratelimit_backoff` | category under an active rate limit; replay rate limit |
| `sample_rate` | error `sampleRate`, trace sampling, unsampled child span |
| `send_error` | HTTP 413; replay non-2xx or retries exhausted |
| `internal_sdk_error` | replay event buffer error |
| `buffer_overflow` | replay event buffer > 20 MB |
| `ignored` | `ignoreSpans` |
| `invalid` | replay past max duration |
| `no_parent_span` | `onlyIfParent` without a parent |

## 11. CDN loader script

The loader Sentry serves per project is not in this repo. The repo has a test copy at B/packages/browser/test/loader.js (and a minified fixture under dev-packages). The behaviour below comes from that copy (code, test fixture; may differ from what Sentry serves).

- Parameters: `window, document, 'script', 'onerror', 'onunhandledrejection', 'Sentry', publicKey, sdkBundleUrl, config, lazy`. (#L1-L12, #L222-L224)
- `data-lazy="no"` on the loader `<script>` turns lazy mode off. (#L16-L25)
- It installs `window.Sentry` stubs for `init`, `addBreadcrumb`, `captureMessage`, `captureException`, `captureEvent`, `configureScope`, `withScope`, `showReportDialog` that push `{f, a}` into a queue. (#L180-L194)
- It wraps `window.onerror` and `window.onunhandledrejection` to queue `{e: args}` / `{p: reason}` and call the previous handler. (#L196-L215)
- Lazy mode: the bundle is injected on the first queued error, rejection, or `capture*` / `showReportDialog` call. `onLoad(cb)` queues the callback and injects only when not lazy or after `forceLoad()`. Non-lazy mode injects on the next tick. (#L32-L49, #L162-L177, #L217-L221)
- On bundle load: restore the old handlers, set `window.SENTRY_SDK_SOURCE = 'loader'`, wrap `SDK.init` so user options merge onto the loader `config` (which holds the DSN). Then run `onLoad` callbacks, replay queued calls (calling `init()` first if needed), then feed queued errors to the real `onerror` / `onunhandledrejection` handlers. (#L69-L157)
- The SDK copies `window.SENTRY_SDK_SOURCE` into SDK metadata. (code, B/packages/browser/src/client.ts#L126)
- Typed surface `LoaderSentry`: `init`, `addBreadcrumb`, `captureMessage`, `captureException`, `captureEvent`, `showReportDialog`, `withScope(callback)`, `onLoad`, `forceLoad`. Queued calls return `void`. (code, B/packages/browser/src/loader-types.ts#L5-L46)
- In the npm package, `forceLoad()` is a no-op and `onLoad(cb)` calls `cb` at once. (code, B/packages/browser/src/sdk.ts#L137-L147)

Note: the test copy decides "init already called" with `__SENTRY__.hub?.getClient()` (#L115-L119). Hubs were removed in v8, so that check looks stale in the copy. Whether the served loader still does this is not verified.

## 12. `diagnoseSdkConnectivity()`

(code, B/packages/browser/src/diagnose-sdk.ts#L12-L51)
- Returns `'no-client-active'`, `'no-dsn-configured'`, `'sentry-unreachable'`, or `undefined` (reachable).
- It does **not** use the project DSN. It POSTs `'{}'` (`mode: 'cors'`, `credentials: 'omit'`) to the tunnel if set, else to a fixed, disabled Sentry project (`o447951`, project `4509632503087104`), inside `suppressTracing`.
- Only a thrown fetch (ad blocker, DNS, CORS) counts as unreachable. Any HTTP status counts as reachable.
- It uses global `fetch`, not the cached native one.

## 13. Pipeline as a numbered list (for a later SVG)

1. App calls `Sentry.init(options)`.
2. Browser `init` builds default integrations and resolves the tunnel.
3. `initAndBind` creates `BrowserClient` and sets it on the current scope.
4. The client constructor builds the transport (`makeFetchTransport`) and installs `visibilitychange` / `pagehide` listeners.
5. `client.init()` runs `setupIntegrations`: beforeSetup, then setupOnce / setup / register processors and hooks, then afterAllSetup.
6. Instrumentation (global handlers, breadcrumbs, browser tracing) observes the page.
7. An error reaches `client.captureException`.
8. The task enters the client promise buffer (64). Full → `queue_overflow`.
9. `eventFromException` parses the stack.
10. `_processEvent` rolls the error `sampleRate`.
11. `_prepareEvent`: `preprocessEvent` hook → client options → scopes merged (global, isolation, current) → active span and DSC → client processors → scope processors → normalize → `postprocessEvent` hook.
12. `beforeSend` / `beforeSendTransaction` / `ignoreSpans`.
13. Session update. A sampled-out error is dropped here.
14. `sendEvent`: `beforeSendEvent` hook → `createEventEnvelope` (header `event_id`, `sent_at`, `sdk`, `trace` DSC, `dsn` if tunnel) → attachments.
15. `sendEnvelope`: `beforeEnvelope` hook.
16. Transport drops rate-limited items (`ratelimit_backoff`).
17. Transport promise buffer (40). Full → `queue_overflow`.
18. `serializeEnvelope` → native `fetch` POST, `keepalive` if under 60,000 and 15 requests in flight.
19. Response: 413 → `send_error`; rate-limit headers update state; a thrown fetch → `network_error`.
20. `afterEnvelope` and `afterSendEvent` hooks fire (replay uses the latter).
21. Page hidden → client report envelope, then `client.flush()` drains logs, metrics and streamed spans.

## Differences vs 10.78.0

| Area | 10.78.0 | 11.11.0 | Source |
|---|---|---|---|
| `traceLifecycle` default | `'static'` (transactions) | `'stream'` (span v2 envelopes); any value other than `'static'` becomes `'stream'` | B10/packages/core/src/types/options.ts#L551-L557; B/packages/core/src/client.ts#L262-L267 (code) |
| Default integrations | `InboundFilters`, no `Console` | `EventFilters`, plus `Console` (console breadcrumbs left `Breadcrumbs`) | B/packages/browser/src/sdk.ts#L35-L48 (code); B/MIGRATION.md#L1595 (docs) |
| `attachStacktrace` | default false | default true | B/packages/core/src/client.ts#L262-L266 (code); B/MIGRATION.md#L637 (docs) |
| `tunnel` | string only | also `true` / object → managed same-origin tunnel | B/packages/browser/src/utils/managedTunnel.ts#L15-L42 (code) |
| Browser client listeners | `visibilitychange` only | adds `freeze`, `resume`, `pagehide`, `pageshow` for clock-drift checks; all removed on `close` | B/packages/browser/src/client.ts#L153-L200 (code) |
| Session status on unhandled error | `crashed` | `unhandled` | B/packages/browser/src/client.ts#L135-L136 (code); B/MIGRATION.md#L563-L567 (docs) |
| Logs / metrics enablement | `enableLogs` / `enableMetrics` gate capture and flushers | options removed; flushers always wired; capture on use | B10/packages/core/src/logs/internal.ts#L87-L88; B/packages/core/src/client.ts#L316-L327 (code) |
| A user callback throws | propagates or becomes an internal error | caught by `safeCallback`; new `callback_error` reason | B/packages/core/src/types/clientreport.ts#L5 (code) |
| `beforeSendSpan` returns `null` | warning, span kept | span kept silently; callback format must match lifecycle (`withStaticSpan`) | B/packages/core/src/tracing/spans/beforeSendSpan.ts#L62-L74 (code) |
| Transport loss outcomes | one outcome per item | also `span` outcomes for transactions (1 + spans) and `item_count` for container items | B/packages/core/src/transports/base.ts#L40-L47 (code) |
| `createSpanEnvelope` | exists (standalone v1 spans) | removed | B/MIGRATION.md#L1541 (docs) |
| Hooks | — | new: `prepareSpanScope`, `beforeIdleSpanEnd`, `afterEnvelope`, `startRequestSession`, `flushTraceSpans`, `orchestrion.module-injected` | `diff` of `packages/core/src/client.ts` B10 vs B (code) |
| `lazyLoadIntegration` names | included AI client helpers | AI helpers removed; `userTimingIntegration`, `interactionsIntegration` added | B/packages/browser/src/utils/lazyLoadIntegration.ts#L9-L28 (code) |
| Import path inside the SDK | `@sentry/core/browser` | `@sentry/core` (browser-only APIs on `@sentry/core/browser`) | B/MIGRATION.md#L1526 (docs) |

Byte-identical between the two tags: `core/src/integration.ts`, `core/src/utils/promisebuffer.ts`, `core/src/utils/ratelimit.ts`, `core/src/transports/multiplexed.ts`, `browser-utils/src/getNativeImplementation.ts`, `browser/test/loader.js`. (code, `diff`)
