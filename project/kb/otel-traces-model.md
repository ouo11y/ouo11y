# OpenTelemetry traces

Sources: `specification/trace/api.md`, `trace/sdk.md` (Stable except where marked), `trace/v1/trace.proto`. Versions in [otel-common-model.md](otel-common-model.md).

## Wire shape

```
ResourceSpans → ScopeSpans → Span → Event[] and Link[]
```

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `trace_id` | bytes (16) | Required |
| 2 | `span_id` | bytes (8) | Required |
| 3 | `trace_state` | string | W3C tracestate |
| 4 | `parent_span_id` | bytes (8) | Empty means root |
| 16 | `flags` | fixed32 | Bits 0-7 W3C flags; bit 8 "is-remote known"; bit 9 "parent is remote" |
| 5 | `name` | string | Required. Low-cardinality operation name |
| 6 | `kind` | enum | See below |
| 7 | `start_time_unix_nano` | fixed64 | Required in meaning |
| 8 | `end_time_unix_nano` | fixed64 | Required in meaning; `end >= start` expected |
| 9, 10 | `attributes`, `dropped_attributes_count` | | |
| 11, 12 | `events`, `dropped_events_count` | | |
| 13, 14 | `links`, `dropped_links_count` | | |
| 15 | `status` | Status | |

`Span.Event`: `time_unix_nano` 1, `name` 2, `attributes` 3, `dropped_attributes_count` 4.

`Span.Link`: `trace_id` 1, `span_id` 2, `trace_state` 3, `attributes` 4, `dropped_attributes_count` 5, `flags` 6.

`Status`: `message` 2, `code` 3 (`UNSET` 0, `OK` 1, `ERROR` 2).

## Span kinds

| Kind | Value | Means |
|---|---|---|
| `UNSPECIFIED` | 0 | Do not use. Receivers may treat as INTERNAL |
| `INTERNAL` | 1 | Inside the app (the default) |
| `SERVER` | 2 | Handling an incoming request |
| `CLIENT` | 3 | A request out to something else |
| `PRODUCER` | 4 | Initiates work to happen later |
| `CONSUMER` | 5 | Does that later work |

A browser `fetch` is `CLIENT`. Its `SERVER` child is on the backend, joined through `traceparent`.

## Status

The default is `Unset`, and that is the normal state of a successful span. Instrumentation sets `Error` when semantic conventions say so and SHOULD NOT set `Ok`. `Ok` is reserved for an application developer or operator asserting success, and it is final. Order: `Ok > Error > Unset`. `message` is only for `Error`.

## Links

A link points at another span with no parent relation, in the same trace or another. Use it where parent/child would be false: one batch processing many requests, or a new trace started because the old one should stop growing. The default limit is 128 per span.

This is the standard tool for relating traces within a session without making one huge trace.

## Sampling and how it propagates

Two separate bits exist in a running SDK (spec):

| `IsRecording` | `Sampled` flag | Processor sees it | Exporter sees it |
|---|---|---|---|
| true | true | yes | yes |
| true | false | yes | no |
| false | true | not allowed | not allowed |
| false | false | no | no |

The default sampler is `parentbased_always_on`: a root span is sampled, and a child follows its parent's flag. The decision travels in `traceparent` flags. The **root makes the decision for the whole distributed trace**. So if a browser starts the trace, the browser's rate decides what the backend records, unless the backend ignores the parent's flag.

- `TraceIdRatioBased` is deprecated in favour of `ProbabilitySampler` (Development), which compares a threshold against 56 bits of trace-id randomness (`R >= T`) and records the threshold in tracestate as `ot=th:...`.
- Span ids are still generated when not sampled, so logs can reference them.
- Tail sampling happens in a Collector and needs all spans of a trace to reach one instance within a wait window, which works poorly for traces that stay open for a long time.

## The client-side problem: long-lived and never-ended spans

The spec's span is something with a start and an **end**. Three facts together cause trouble on a client:

1. **A span is handed to the export pipeline only when it ends.** `OnEnd` is what feeds exporters.
2. **OTLP has no partial or in-progress span.** `end_time` is semantically required. The spec has no concept of updating a span already sent, and no text about long-running or unended spans.
3. **Browser tabs do not end politely.** A closed tab, a killed app, a crash or a frozen background page means `End` never runs.

So:

- A span open when the page dies is **lost completely**, with all its attributes and events.
- Its already-ended children were exported, so the backend holds **orphans** pointing at a parent that never arrives.
- "One root span for the whole session" means nothing about it is visible until the session ends, and in the common failure mode, never.
- Tempo has `max_bytes_per_trace` of 5 MB by default, and rejects with `TRACE_TOO_LARGE` beyond that (source).
- Resending a span with the same id to simulate updates is not defined by the spec.

Common ways around it, for Step 2 and 3 to decide among: end spans on `pagehide` with what is known; keep spans short and link them, with `session.id` on each; or emit a start event that survives even if the span does not. There is no standard answer.

## Limits

| Limit | Default | At the limit |
|---|---|---|
| Span attributes, events, links | 128 each (SDK) | Discarded, counted in `dropped_*` |
| Tempo `max_attribute_bytes` (distributor) | 2048 | **Truncated** (source). A long URL or stack is cut, with only a metric to show it |
| Tempo `max_bytes_per_trace` | 5 MB | Rejected, `TRACE_TOO_LARGE` |
| Tempo metrics-generator `metrics_ingestion_time_range_slack` | 30 s | Spans that ended earlier than that are left out of generated metrics |

The 30 s window is short for a browser: SDK batching, a slow network or a wrong device clock can put a span outside it.

Span events are capped at 128, and an event in a span cannot be sent until the span ends, which is another reason OTEP 4430's direction suits us.
