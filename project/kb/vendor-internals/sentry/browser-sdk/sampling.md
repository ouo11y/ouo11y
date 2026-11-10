# Sentry browser SDK: sampling decision points

- Package: `@sentry/browser` **11.11.0** (tag 2026-11-05). Compared with **10.78.0**.
- Research date: 2026-11-10.
- `B` = https://github.com/getsentry/sentry-javascript/blob/11.11.0 . `B10` = the same path at tag `10.78.0`.
- Every claim is marked **(code)** or **(docs, accessed 2026-11-10)**. `B/MIGRATION.md` is the in-repo migration guide.
- Siblings: [architecture.md](architecture.md), [reliability.md](reliability.md), [configuration.md](configuration.md), [wire-capture.md](wire-capture.md), [replay-browser.md](replay-browser.md). Option lists are in [../../../client-sdk-features/vendors/sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md).

## Why this matters for ouo

Every signal has its own dice roll, at its own time, and only some of them share a random value with the trace. If we compute rates or join replays, errors and traces, we must know which data was dropped on the client, and whether the client says so in a client report.

## 1. Errors: `sampleRate`

| Item | Detail | Where |
|---|---|---|
| Applies to | events with `type === undefined` only (errors and messages). Not transactions, feedback, replay, logs, metrics. | B/packages/core/src/client.ts#L1563, #L1870-L1872 (code) |
| Parse | `parseSampleRate`: booleans → 0/1, strings parsed, outside [0,1] → `undefined` (no sampling). | B/packages/core/src/utils/parseSampleRate.ts#L8-L20 (code) |
| Roll | `safeMathRandom() > parsedSampleRate` → sampled out. Fresh random per event. Not tied to `sample_rand`. | B/packages/core/src/client.ts#L1571-L1572 (code) |
| Drop (no ok session) | before processing: `recordDroppedEvent('sample_rate', 'error')` | B/packages/core/src/client.ts#L1579-L1584 (code) |
| Drop (ok session exists) | full pipeline runs, session gets updated (errored/unhandled), then `sample_rate:error` is recorded and the event is not sent | B/packages/core/src/client.ts#L1633-L1640 (code) |

So with `sampleRate < 1`, session error counts stay correct while error events are sampled. Release Health rates come from sessions, not from error volume.

## 2. Traces: `tracesSampleRate` / `tracesSampler`

### 2.1 When spans are enabled

`hasSpansEnabled` is true when `tracesSampleRate != null` (0 counts) or `tracesSampler` is set, and the build flag `__SENTRY_TRACING__` is not `false`. (code, B/packages/core/src/utils/hasSpansEnabled.ts#L23-L35)

### 2.2 Where the decision is made

Only **root (segment) spans** roll. `_startRootSpan` (code, B/packages/core/src/tracing/trace.ts#L480-L546):
1. Builds `{spanAttributes, spanName, parentSampled}` and emits `beforeSampling`. A hook may change `parentSampled` and attributes. (#L491-L498)
2. If tracing is suppressed → not sampled, no outcome.
3. Calls `sampleSpan(options, samplingContext, propagationContext.sampleRand)`. (#L503-L515)
4. `samplingContext` fields: `name`, `parentSampled`, `attributes`, `normalizedRequest` (from isolation scope), `parentSampleRate` (from the propagation context DSC `sample_rate`). Type: B/packages/core/src/types/samplingcontext.ts#L15-L52. `tracesSampler` also gets `inheritOrSampleWith(fallback)`.
5. Writes `sentry.sample_rate` on the root span only if a **local** rate was applied (sampler or `tracesSampleRate`, not plain inheritance). (#L517-L525)
6. If not sampled: records `dropReason || 'sample_rate'` for `span`, and also for `transaction` when `traceLifecycle` is `'static'`. (#L527-L538)

`sampleSpan` (code, B/packages/core/src/tracing/sampling.ts#L15-L129):

| Step | Rule |
|---|---|
| Resolve rate | 1. `tracesSampler(ctx)` if it is a function. If it throws, fall through. 2. else `parentSampled` if defined (boolean, so 0 or 1). 3. else `tracesSampleRate` (marked local). 4. else nothing → `[false, …, 'callback_error']`. |
| `inheritOrSampleWith(fb)` | returns `parentSampleRate` if numeric, else `Number(parentSampled)` if boolean, else `fb`. |
| Invalid rate | not sampled, no drop reason override. |
| Rate 0 | not sampled. |
| Compare | `sampled = sampleRand < rate`. |

Notes:
- The comparison uses the **propagated** `sample_rand`, not a new random. That is what makes the decision consistent across services. (code, #L60-L62)
- With a sampler, an inherited `parentSampled` is ignored unless the sampler calls `inheritOrSampleWith` or reads `parentSampled` itself. (code, #L87-L118)
- In stream mode `tracesSampler` runs before span start. Route names are not resolved yet, so match on attributes such as `url.path`. (docs, B/MIGRATION.md#L1123-L1160)

### 2.3 Child spans

Children never roll. They copy the parent's `sampled`. An unsampled parent yields a `SentryNonRecordingSpan` and records `sample_rate:span` per child, or the parent's own `dropReason` (`ignored`, `no_parent_span`). (code, B/packages/core/src/tracing/trace.ts#L553-L600)

`ignoreSpans` in stream mode is checked at span **start**; a match yields a non-recording span and `ignored:span`. (code, B/packages/core/src/tracing/trace.ts#L366-L385, #L636-L645)

## 3. `sample_rand`

### 3.1 Where it is generated

| Place | Code |
|---|---|
| Every new `Scope` | `{ traceId: generateTraceId(), sampleRand: safeMathRandom() }` — B/packages/core/src/scope.ts#L190-L193 (code) |
| `startNewTrace()` | same — B/packages/core/src/tracing/trace.ts#L284-L299 (code) |
| Browser navigation | new trace id and `sampleRand: Math.random()` at each navigation span start — B/packages/browser/src/tracing/browserTracingIntegration.ts#L528-L533 (code) |
| Incoming headers, no trace id | random — B/packages/core/src/utils/tracing.ts#L77-L82 (code) |
| Incoming headers with trace id | `getSampleRandFromTraceparentAndDsc` — B/packages/core/src/utils/tracing.ts#L133-L155 (code) |

`getSampleRandFromTraceparentAndDsc`:
1. Incoming `sentry-sample_rand` valid → use it.
2. Else incoming `sentry-sample_rate` and a sampled flag → draw a value that reproduces the upstream decision: `rand * rate` if sampled, `rate + rand * (1 - rate)` if not.
3. Else random.
The result is written back into the incoming DSC as a string. (code, B/packages/core/src/utils/tracing.ts#L84-L89)

### 3.2 How it travels

- Baggage entry `sentry-sample_rand=<value>`: every DSC key is prefixed with `sentry-` and URI-encoded. Empty values are skipped. Baggage is capped at 8192 chars; entries beyond that are dropped with a debug warning. (code, B/packages/core/src/utils/baggage.ts#L6, #L15, #L61-L80, #L149-L170)
- The value is the full `Number.toString()` (no rounding). (code, B/packages/core/src/tracing/dynamicSamplingContext.ts#L174-L179)
- `sample_rand` is only added to a span-derived DSC when spans are enabled. Without `tracesSampleRate` / `tracesSampler`, the client DSC has no `sampled` and no `sample_rand`. (code, B/packages/core/src/tracing/dynamicSamplingContext.ts#L169-L180)
- A trace continued with `sentry-trace` but **without** baggage gets an empty frozen DSC; the SDK folds in `sample_rand` so it still propagates. (code, B/packages/core/src/tracing/trace.ts#L422-L430)

### 3.3 `continueTrace`, `strictTraceContinuation`, `orgId`

`continueTrace({sentryTrace, baggage}, cb)` (code, B/packages/core/src/tracing/trace.ts#L195-L221):
1. Parse incoming baggage DSC.
2. `shouldContinueTrace(client, dsc.org_id)`; if false → `startNewTrace(cb)`.
3. Else set `propagationContextFromHeaders(...)` on a forked scope.

`shouldContinueTrace` (code, B/packages/core/src/utils/tracing.ts#L164-L190):
- Client org id = `orgId` option, else parsed from DSN host `o<digits>.` (code, B/packages/core/src/utils/dsn.ts#L7, #L127-L150).
- Both present and different → new trace (always, even without strict mode).
- `strictTraceContinuation: true` and exactly one side missing → new trace.

**Browser pageload does not call `shouldContinueTrace`.** It reads `sentry-trace` and `baggage` from `<meta>` tags or the navigation `Server-Timing` entries and calls `propagationContextFromHeaders` directly. Org-id checks do not apply there. (code, B/packages/browser/src/tracing/browserTracingIntegration.ts#L553-L567, #L828-L847)

## 4. Dynamic Sampling Context (DSC)

Type fields: `trace_id`, `public_key`, `sample_rate`, `release`, `environment`, `transaction`, `replay_id`, `sampled`, `sample_rand`, `org_id`. (code, B/packages/core/src/types/envelope.ts#L19-L30)

| Field | Source | Where |
|---|---|---|
| `trace_id` | span or propagation context trace id | B/packages/core/src/tracing/dynamicSamplingContext.ts#L43-L56 (code) |
| `public_key` | DSN public key | same |
| `release` | `options.release` | same |
| `environment` | `options.environment` or `production` | same |
| `org_id` | `orgId` option or DSN host | same, #L55 |
| `transaction` | root span name, **only if** `sentry.segment.name.source !== 'url'` | #L160-L167 |
| `sampled` | `String(spanIsSampled(root))`, spans enabled only | #L172-L173 |
| `sample_rand` | trace state, else captured scope propagation context | #L174-L179 |
| `sample_rate` | root span `sentry.sample_rate` or `sentry.previous_trace_sample_rate`; applied **even to a frozen DSC** | #L100-L112 |
| `replay_id` | added by Replay through the `createDsc` hook, only in `session` recording mode with an active session | B/packages/replay-internal/src/util/addGlobalListeners.ts#L34-L44 (code) |

The `createDsc` hook fires for a freshly built DSC (client or span), not for a frozen one. (code, #L58, #L184)

### 4.1 When the DSC is frozen

`getDynamicSamplingContextFromSpan` returns a frozen DSC first if the root span carries one. (code, B/packages/core/src/tracing/dynamicSamplingContext.ts#L114-L118) Freezing happens:
- When a root span is forced while a parent span exists: the parent's DSC is frozen on it. (code, B/packages/core/src/tracing/trace.ts#L389-L407)
- When a root span starts from a propagation context that has a `dsc` (continued trace, incoming baggage). (code, B/packages/core/src/tracing/trace.ts#L408-L430)
- In the browser, when the pageload/navigation span ends, the scope propagation context is updated with that span's trace id, sampled flag and DSC, so later errors and requests on that route reuse it. (code, B/packages/browser/src/tracing/browserTracingIntegration.ts#L481-L493)

Errors use the scope DSC (`getDynamicSamplingContextFromScope`: propagation context `dsc`, else a client DSC with no `sampled`) unless an active span supplies its DSC. (code, B/packages/core/src/tracing/dynamicSamplingContext.ts#L66-L80, B/packages/core/src/client.ts#L1488-L1495, B/packages/core/src/utils/scopeData.ts#L159-L168)

## 5. Outgoing headers

| Header | Format | Where |
|---|---|---|
| `sentry-trace` | `<32 hex trace>-<16 hex span>[-1|-0]`; the flag is omitted when undecided | B/packages/core/src/utils/tracing.ts#L105-L115 (code) |
| `traceparent` | `00-<trace>-<span>-01` or `-00` (undecided → `00`) | B/packages/core/src/utils/tracing.ts#L120-L126 (code) |
| `baggage` | `sentry-*` DSC entries, merged with existing non-sentry entries | B/packages/core/src/utils/baggage.ts#L61-L80, #L182-L230 (code) |

Parsing uses `TRACEPARENT_REGEXP` `^[ \t]*([0-9a-f]{32})?-?([0-9a-f]{16})?-?([01])?[ \t]*$` for `sentry-trace`. (code, B/packages/core/src/utils/tracing.ts#L13-L53)

`getTraceData` (code, B/packages/core/src/utils/traceData.ts#L35-L98):
- With an active recording span (or an unsampled one in tracing mode): headers from the span.
- In tracing-without-performance mode (no `tracesSampleRate`), or with no span: headers from the scope (`propagationSpanId`, `sampled`). In the browser, a random `propagationSpanId` is kept for the whole route. (code, B/packages/browser/src/tracing/browserTracingIntegration.ts#L569-L574)
- `traceparent` is added only when `propagateTraceparent: true` (default `false`). (code, B/packages/core/src/types/options.ts#L485-L489; B/packages/browser/src/tracing/request.ts#L150)
- Returns `{}` if the SDK is disabled or the header is invalid.

### 5.1 `tracePropagationTargets` in the browser

`shouldAttachHeaders(url, targets)` (code, B/packages/browser/src/tracing/request.ts#L274-L314):

| `window.location.href` | targets | Rule |
|---|---|---|
| missing | unset | only relative URLs starting with a single `/` |
| missing | set | `matchesTracePropagationTargets(url)` |
| present | **unset (default)** | **same origin only** (`new URL(url, href).origin === location.origin`) |
| present | set | full resolved URL matches, **or** same-origin and the pathname matches |
| URL parse fails | any | no headers |

`matchesTracePropagationTargets` (code, B/packages/core/src/utils/tracePropagationTargets.ts#L19-L63):
- Strings: case-insensitive substring match.
- RegExps: recompiled with `i` added and `g`/`y` removed (cached).

## 6. `linkPreviousTrace` and `consistentTraceSampling`

Defaults: `linkPreviousTrace: 'in-memory'`, `consistentTraceSampling: false`. (code, B/packages/browser/src/tracing/browserTracingIntegration.ts#L277-L291)

`linkTraces` (code, B/packages/browser/src/tracing/linkedTraces.ts#L49-L237):
- On each root `spanStart`, it stores `{spanContext, startTimestamp, sampleRate, sampleRand}` of the current trace. With `'session-storage'` it persists under key **`sentry_previous_trace`**. (#L40, #L63-L74, #L210-L230)
- When the trace id changes and the previous root started within **3600 s**, it adds a span link with `sentry.link.type = 'previous_trace'` and a temporary attribute `sentry.previous_trace = <trace>-<span>-<0|1>`. (#L37, #L164-L202)
- `consistentTraceSampling: true` hooks `beforeSampling`: it rewrites the scope DSC `sample_rate`/`sampled` and `sampleRand` to the previous trace's values, and sets `parentSampled`, `parentSampleRate` and `sentry.previous_trace_sample_rate`. So a whole browser session of traces follows the first decision. Exception: the first trace of a page load that continues a backend trace keeps the backend decision. (#L77-L125)

## 7. Replay

Options: `replaysSessionSampleRate` → `sessionSampleRate`, `replaysOnErrorSampleRate` → `errorSampleRate`, both parsed with `parseSampleRate`. If both are unset, replay is disabled with a warning. (code, B/packages/replay-internal/src/integration.ts#L428-L451)

| Step | Rule | Where |
|---|---|---|
| Manual only | both rates `<= 0` → no automatic start | B/packages/replay-internal/src/replay.ts#L325-L337 (code) |
| Session create | `sampled = Math.random() < sessionSampleRate ? 'session' : (errorSampleRate > 0 ? 'buffer' : false)` | B/packages/replay-internal/src/session/createSession.ts#L9-L11; B/packages/replay-internal/src/util/isSampled.ts#L7-L14; B/packages/replay-internal/src/replay.ts#L903-L920 (code) |
| Sticky reuse | an existing session in `sessionStorage` is reused (no new roll) until it expires | B/packages/replay-internal/src/session/loadOrCreateSession.ts#L12-L38 (code) |
| Mode | `'buffer'` only if `sampled === 'buffer'` and `segmentId === 0`, else `'session'` | B/packages/replay-internal/src/replay.ts#L356 (code) |
| Error roll | in buffer mode, per error event with an exception and no synthetic stack: `Math.random() < errorSampleRate` | B/packages/replay-internal/src/coreHandlers/util/shouldSampleForBufferEvent.ts#L11-L32 (code) |
| Tag | sampled error (or any error/transaction in session mode) gets tag `replayId`; buffer session is marked dirty | B/packages/replay-internal/src/coreHandlers/handleGlobalEvent.ts#L84-L108 (code) |
| Convert | after the tagged error is sent with a 2xx status, `beforeErrorSampling(event)` may veto, else `sendBufferedReplayOrFlush()` flushes the buffer and switches to `session` mode | B/packages/replay-internal/src/coreHandlers/handleAfterSendEvent.ts#L39-L70; B/packages/replay-internal/src/replay.ts#L592-L631 (code) |
| Manual | `start()` forces `sessionSampleRate: 1`; `startBuffering()` forces buffer mode | B/packages/replay-internal/src/replay.ts#L370-L435 (code) |

What turns buffer into session mode: a sampled error that the server accepted (2xx), `replay.flush()` called manually, or feedback submission (it calls `replay.flush()`). (code, handleAfterSendEvent.ts#L20-L24; handleGlobalEvent.ts#L59-L74)

Replay sampling uses plain `Math.random()`. It is **not** tied to trace `sample_rand`, so a sampled trace may have no replay and the reverse. `replay_id` enters the DSC only in `session` mode. (code, isSampled.ts#L13; addGlobalListeners.ts#L34-L44)

The `replay_event` carries `replay_type: session.sampled` (`'session'` or `'buffer'`). (code, B/packages/replay-internal/src/util/sendReplayRequest.ts#L40-L51)

No client report is recorded when a session is not sampled. Details of recording are in [replay-browser.md](replay-browser.md).

## 8. Profiling

11.x only has UI (continuous) profiling. (code, B/packages/browser/src/client.ts#L25-L46; docs, B/MIGRATION.md#L1820-L1825)

`shouldProfileSession` (code, B/packages/browser/src/profiling/utils.ts#L276-L307):
- Fails if the JS Self-Profiling constructor failed earlier in this page.
- `profileLifecycle` must be `'trace'` or `'manual'` (the integration defaults it to `'manual'`; code, B/packages/browser/src/profiling/integration.ts#L17-L20).
- `profileSessionSampleRate` must be valid and > 0.
- Roll: `Math.random() <= profileSessionSampleRate`, **once per page load** in `UIProfiler.initialize`. (code, B/packages/browser/src/profiling/UIProfiler.ts#L67-L82)

`'trace'` lifecycle: profiling runs while at least one **sampled** (recording) root span is active, max 5 minutes per root span, chunks every 60 s. It warns if tracing is disabled. (code, UIProfiler.ts#L22-L24, #L139; integration.ts#L24-L37)
`'manual'`: `uiProfiler.start()` / `stop()` and only if the session was sampled. (code, UIProfiler.ts#L95-L130)

The legacy `profilesSampleRate` (per transaction, `Math.random() < rate`) exists in 10.78.0 only. (code, B10/packages/browser/src/profiling/utils.ts#L655-L677)

## 9. Logs, metrics, feedback, sessions

| Signal | Sampling in SDK | Drops |
|---|---|---|
| Logs | none | `beforeSendLog` → `before_send` / `callback_error` on `log_item`. Buffer flush at 100 logs, ~800 KB weight, 5 s, or `flush`. (code, B/packages/core/src/logs/internal.ts#L32, #L62-L74, #L159-L174; B/packages/core/src/client.ts#L69, #L132-L184) |
| Metrics | none | `beforeSendMetric` → `before_send` / `callback_error` on `trace_metric`. Buffer 1000. (code, B/packages/core/src/metrics/internal.ts#L29, #L195-L211) |
| Feedback | none; `type: 'feedback'` skips `sampleRate` and `beforeSend` | transport drops only (code, B/packages/core/src/feedback.ts#L26) |
| Sessions | none | missing release → silent drop (code, B/packages/core/src/client.ts#L632-L651) |

## 10. Summary table

| Signal | Knob | Decided where | When | Inherited from upstream? | Client report on drop |
|---|---|---|---|---|---|
| Errors / messages | `sampleRate` | B/packages/core/src/client.ts#L1572 | per event, at capture | no (fresh random) | `sample_rate:error` |
| Root spans / transactions | `tracesSampleRate`, `tracesSampler` | B/packages/core/src/tracing/sampling.ts#L15-L75 via trace.ts#L503-L515 | span start | yes: `parentSampled`, `parentSampleRate`, and `sample_rand` from `sentry-trace` / baggage | `sample_rate:span` (+ `:transaction` in static mode); sampler throws with no fallback → `callback_error` |
| Child spans | parent decision | B/packages/core/src/tracing/trace.ts#L553-L597 | span start | yes (parent) | `sample_rate:span` or the parent's drop reason |
| Ignored spans | `ignoreSpans` | trace.ts#L366-L385 (stream), client.ts#L1802-L1852 (static) | start (stream) / send (static) | no | `ignored:span` (`ignored:transaction` for a static root) |
| Browser traces across navigations | `consistentTraceSampling` | B/packages/browser/src/tracing/linkedTraces.ts#L89-L124 | each root span | yes, from the previous trace | as for root spans |
| Replay (session) | `replaysSessionSampleRate` | B/packages/replay-internal/src/session/createSession.ts#L9-L11 | session creation (page load or session expiry) | no | none |
| Replay (on error) | `replaysOnErrorSampleRate`, `beforeErrorSampling` | shouldSampleForBufferEvent.ts#L31; handleAfterSendEvent.ts#L58-L61 | per error, while buffering | no | none |
| Profiling | `profileSessionSampleRate`, `profileLifecycle` | B/packages/browser/src/profiling/utils.ts#L276-L307 | once per page load | no; `'trace'` mode also needs a sampled root span | none |
| Logs | none (`beforeSendLog` filter) | logs/internal.ts#L159-L174 | per log | n/a | `before_send:log_item`, `callback_error:log_item` |
| Metrics | none (`beforeSendMetric` filter) | metrics/internal.ts#L195-L211 | per metric | n/a | `before_send:trace_metric`, `callback_error:trace_metric` |
| Feedback | none | — | — | n/a | transport reasons only |
| Sessions | none | — | — | n/a | none (missing release is silent) |

## Differences vs 10.78.0

| Area | 10.78.0 | 11.11.0 | Source |
|---|---|---|---|
| `tracesSampler` throws | exception propagates out of span start | caught; falls back to `parentSampled` then `tracesSampleRate`; with neither, not sampled and `callback_error` | B10/packages/core/src/tracing/sampling.ts#L24-L53; B/packages/core/src/tracing/sampling.ts#L25-L30, #L81-L129 (code) |
| Unsampled root outcome | `sample_rate` on `transaction` (static) **or** `span` (stream) | `span` always, plus `transaction` in static mode | B10/packages/core/src/tracing/trace.ts#L543; B/packages/core/src/tracing/trace.ts#L527-L538 (code) |
| Default lifecycle | static transactions | streamed spans; `ignoreSpans` and `tracesSampler` see unresolved names at start | B/packages/core/src/client.ts#L266; B/MIGRATION.md#L323-L333, #L1123-L1160 (code, docs) |
| `tracePropagationTargets` | case-sensitive; `g`/`y` regexps stateful | case-insensitive; `g`/`y` stripped | B/packages/core/src/utils/tracePropagationTargets.ts#L19-L63 (code); B/MIGRATION.md#L753-L773 (docs) |
| DSC with external propagation context | always a DSC | `undefined` while an external (OTLP) propagation context is active | B/packages/core/src/tracing/dynamicSamplingContext.ts#L66-L80 (code) |
| DSC `transaction` source attribute | `sentry.source` or `sentry.segment.name.source` | `sentry.segment.name.source` only | B10/.../dynamicSamplingContext.ts#L146-L148; B/.../dynamicSamplingContext.ts#L161 (code) |
| Profiling | legacy `profilesSampleRate` (per transaction) plus UI profiling | only `profileSessionSampleRate` + `profileLifecycle` | B10/packages/browser/src/profiling/utils.ts#L655-L677; B/MIGRATION.md#L1820-L1825 |
| Logs / metrics | `enableLogs` / `enableMetrics` gate | removed; capture on use | B10/packages/core/src/logs/internal.ts#L87-L88; B/MIGRATION.md#L547-L560 |

Unchanged: `utils/tracing.ts` (header formats, `sample_rand` derivation, `shouldContinueTrace`) and replay `constants.ts` are byte-identical. Replay sampling code did not change. (code, `diff`)

## Observed in the demo (2026-11-10)

- One `sample_rand` per trace, shared by every envelope's DSC and the outgoing `baggage` (`sentry-sample_rand=0.866375041749666`). A new trace started at each navigation and at each fetch made outside an active span. Values are sent as strings.
- `sampleRate: 0` dropped the error and produced `sample_rate:error` in the client report; the session update still went out.
- The DSC carried `replay_id` while a replay was in session mode, and also on the fetch `baggage`.
- `replaysSessionSampleRate: 0` + `replaysOnErrorSampleRate: 1` stored `sampled:"buffer"` in `sentryReplaySession` at load.
Fixtures and request ids: [wire-capture.md](wire-capture.md).
