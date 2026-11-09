# OpenTelemetry logs and events

Sources: `specification/logs/data-model.md` (Stable), `logs/v1/logs.proto`, semantic-conventions `docs/general/events.md` (Development). Versions in [common-model.md](common-model.md).

This is probably the most important model for ouo, because replay chunks and most RUM facts look set to be log records.

## Wire shape

```
ResourceLogs → ScopeLogs → LogRecord
```

| # | Field | Type | Meaning |
|---|---|---|---|
| 1 | `time_unix_nano` | fixed64 | When it happened, source clock. 0 means unknown |
| 11 | `observed_time_unix_nano` | fixed64 | When OTel saw it |
| 2 | `severity_number` | enum | 0 unspecified, 1 to 24 |
| 3 | `severity_text` | string | Original level string |
| 5 | `body` | AnyValue | The content. Can be anything |
| 6 | `attributes` | KeyValue[] | Facts about this occurrence |
| 7 | `dropped_attributes_count` | uint32 | |
| 8 | `flags` | fixed32 | Low 8 bits are W3C trace flags. Mask them; upper bits are reserved |
| 9 | `trace_id` | bytes (16) | Optional |
| 10 | `span_id` | bytes (8) | Optional. If set, `trace_id` should be too |
| 12 | `event_name` | string | Non-empty makes this an Event (proto since v1.5.0) |

Field 4 is reserved.

A small inconsistency between the sources: the spec says `ObservedTimestamp` SHOULD be set, the proto comment says MUST.

## What makes a log record an Event

Exactly one thing: a non-empty `event_name`. There is no separate event signal, message or endpoint. An Event is a log record that promises a known shape.

The spec's rule: the name SHOULD uniquely identify the event's structure, both attributes and body. The semantic conventions (Development) add:

- Names MUST NOT include dynamic values. Use attributes for those.
- `Timestamp` MUST be set to when the event occurred.
- Semantic conventions MUST NOT define `ObservedTimestamp`.
- Recommended at most 256 characters, fully qualified (proto).

Semconv's guidance on when to use each:

| Use | When |
|---|---|
| **Event** | A named moment: a checkpoint, state change or outcome. No new trace context or children needed |
| **Span** | An operation with a duration and a meaningful boundary |
| **Span attribute** | Describes the whole operation, needs no timestamp of its own |
| **Plain log** | Unstructured diagnostic text, not meant to be queried by name |

It names user interactions and exceptions as examples of events. Events can be emitted inside or outside an active trace.

## Body as AnyValue

The body can be a string, a number, a nested map, an array or **raw bytes**. Three consequences:

- A protobuf OTLP request carries `bytes_value` raw, with no base64. This is what makes replay chunks as log records plausible on the wire.
- The SDK attribute limits do not apply to the body. The spec sets no size limit on it. Backends do.
- What survives depends on the backend. Loki converts every body to a string, and a bytes body **becomes a base64 string**, 4/3 the size (tested). VictoriaLogs also base64-encodes bytes (source).

Log records are not an obviously good container for large binary payloads. The transport allows it, but Loki's default line limit is 256 KB and the record is stored inline with everything else. The `*_ref` alternative, where the record carries a URI to object storage, avoids those limits. Muninn (Step 8) decides this; this entry only records the constraint.

## Severity

`severity_number` is the comparable value. Ranges are TRACE 1 to 4, DEBUG 5 to 8, INFO 9 to 12, WARN 13 to 16, ERROR 17 to 20, FATAL 21 to 24. 17 or above means an error. 0 is unspecified. `severity_text` is the original string; compare on the number only.

A backend may read a missing severity as INFO (spec).

## How a log record ties to a span

By carrying `trace_id` and `span_id` of the context it was emitted in, nothing more. Consequences:

- A log can exist with no trace at all.
- A log can point at a span that was sampled out or that never arrives. Nothing checks this.
- By default a log under an unsampled trace is still exported. `trace_based` filtering exists in `LoggerConfig` (Development) and defaults to off.
- Keeping the ids costs about 30 gzipped bytes per record in our measurement, because random ids do not compress.

## Timestamps in practice

`Timestamp` is the event time from the device clock. `ObservedTimestamp` is set by the SDK, normally to the same value. So in a browser it is close to the device clock too.

A single-timestamp consumer should use `Timestamp`, falling back to `ObservedTimestamp` (spec). Loki does exactly this, then falls back to arrival time (tested).

## Span events and OTEP 4430

A `Span.Event` is a name, time and attributes inside its parent span. OTEP 4430 plans to **deprecate the Span Event API, not the data**:

- Instrumentation should emit events through the Logs API.
- `Span.events` stays in the proto. The SDK will keep a way to turn log-based events into span events for people who need them in the span envelope.
- Stable instrumentations switch only in their next major version.

**Where it actually stands at spec v1.62.0:** it is a plan that is partly done. `AddEvent` and `RecordException` are **not** marked Deprecated in `trace/api.md`. The event-to-span-event bridge exists in the logs SDK spec at Development. The semantic conventions already say instrumentation SHOULD record exceptions as log records.

Practical effect for ouo: emit events as logs, not span events. Details that need no timestamp of their own go on the span as attributes.

## Limits (see the [backends](../storage-backends/signal-choice-and-backends.md) file for the full picture)

| Limit (Loki defaults) | Value | At the limit (tested) |
|---|---|---|
| `max_line_size` (body) | 256 KB | Record rejected. `400`, other records in the batch still stored |
| `max_structured_metadata_size` (attributes) | 64 KB | Same. A 70 KB `exception.stacktrace` attribute hits this |
| `max_structured_metadata_entries_count` | 128 | Rejected (source) |

## Gotcha: `event_name` on native Loki OTLP

**Loki 3.7.x has no mapping for the OTLP `EventName` field, so it isn't stored; attributes are unaffected.** On 3.7.9 `otlp.go` never reads the field, and a test record sent with `eventName` came back with no such field (tested). An attribute named `event_name` is kept. Since this field is what makes a record an Event, on 3.7.x something must copy it to an attribute first, for example in the Collector.

**Loki 4.0 (release candidates so far) stores it as `event_name` structured metadata**, and the field wins over a log attribute of the same name (`pkg/loghttp/push/otlplabels/labels.go` at v4.0.0-rc.3, source only, not run). On 4.0 the Collector copy is only a stopgap. Structured metadata is not an index label, so filtering on it is slower than on a stream label. VictoriaLogs keeps it, and makes it a stream field (source).
