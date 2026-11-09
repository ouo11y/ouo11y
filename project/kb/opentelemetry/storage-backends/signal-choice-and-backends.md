# Log, span or metric: what each choice costs, and how backends store them

Builds on the [common](../data-models/common-model.md), [logs](../data-models/logs.md), [traces](../data-models/traces.md) and [metrics](../data-models/metrics.md) entries. This describes the trade-offs. It does not decide RUM semantic conventions; Step 2 does, using [these questions](../questions-for-step-2.md).

## Which one is it

| Question about the thing | Points to |
|---|---|
| A moment, with no meaningful length | Event (log record with `event_name`) |
| Work with a start and an end, and possibly children or a downstream call | Span |
| Only ever looked at as a count, rate or distribution | Metric |
| Free text for debugging | Plain log |
| A big payload | Probably a reference, not the record itself |

A span and an event overlap for anything with a duration that you know only after it finished. If the duration is the only thing that makes it a span, the two are close on the wire. What differs is query and correlation.

## Wire size, measured

One API call with 6 attributes, 7 resource attributes and realistic random ids. Average bytes per record. Reproduce with [`wire_size.py`](../../../agents/otel-data-models/scripts/wire_size.py); a real Collector accepted each protobuf body, and its debug output showed the expected fields.

| Form | Alone in a request: protobuf / gzip / JSON gzip | In a batch of 50: protobuf / gzip / JSON gzip |
|---|---|---|
| Log, no trace ids | 497 / 387 / 428 | 246 / 26 / 28 |
| Event with trace ids | 548 / 444 / 495 | 297 / 56 / 63 |
| Span | 556 / 463 / 509 | 305 / 69 / 79 |
| Span with 3 span events | 652 / 486 / 537 | 401 / 80 / 92 |
| Histogram point (16 buckets, all n aggregated) | 706 / 404 / 476 | 14 / 9 / 10 |

What this shows:

1. **Batching dominates.** The same event costs 444 bytes alone and 56 in a batch of 50. Encoding and signal choice are small next to that.
2. **Event versus span is not a wire-size decision.** A span is only about 8 bytes bigger raw and 13 gzipped.
3. **Trace ids are the expensive part once compressed**, about 30 of the 56 gzipped bytes, because they are random.
4. **JSON gzipped is only about 10 to 15% above protobuf gzipped** in batches. JSON is a real option where a protobuf library would add bundle size. That bundle trade-off is a later step.
5. **A metric is cheap per measurement only because it discards the individual measurements.** You can never ask about one session afterwards.

Numbers are for synthetic data with a repeated session id and domain, so real compression will be somewhat worse. Treat them as ratios.

## Costs side by side

| | Event (log) | Span | Metric |
|---|---|---|---|
| Sent when | As it happens | **Only after it ends** | On a timer, aggregated |
| Survives tab death | Yes, once flushed | **No, if still open** | Lost since last export |
| Per-occurrence detail | Yes | Yes | No |
| Join to a session later | Yes, via an attribute | Yes, via an attribute | No |
| Parent/child structure | No, pointer only | Yes | No |
| Sampling | Off by default, independent | Head or tail, whole trace | None needed |
| Backend storage grows with | Volume | Volume | **Cardinality**, not volume |
| Cost of a high-cardinality value | Low, if not a label | Low | **Very high** |
| Query strength | Filter, parse, count over time | Find by structure and duration | Fast percentiles and rates over long time |

Storage here is reasoning from the data models. It was not benchmarked in this step.

## Backend mapping

### Loki 3.7.9 (logs; native OTLP endpoint)

Each record becomes a stream entry: **labels** (indexed, must be low cardinality), **structured metadata** (stored with the entry, filterable without parsing, not indexed), and a **line**.

| OTLP | Loki (tested, except the default list which is source) |
|---|---|
| Listed resource attributes | Index labels. 18 defaults, including `service.name` and `service.instance.id` |
| Other resource, scope and record attributes | Structured metadata. Dots become `_`, so `session.id` is `session_id`; nested maps flatten to `n_m_x` |
| `trace_id`, `span_id`, `flags`, `severity_*`, `observed_timestamp` | Structured metadata |
| `body` | Line, always a string. Maps become JSON. **Bytes become base64** |
| `time_unix_nano` | Entry time. Falls back to observed, then to arrival |
| **`EventName` field** | **Not stored on 3.7.x (no mapping); attributes are unaffected.** 4.0 release candidates store it as `event_name` structured metadata (source only) |

Promotion to labels goes through `otlp_config` per tenant. The default label list is a trap for RUM: if the SDK sets `service.instance.id` per tab or device, Loki makes one stream per tab.

Limits: `max_line_size` 256 KB, structured metadata 64 KB and 128 entries, 15 labels per series. Timestamps: rejected if older than 1 week or more than 10 minutes in the future.

What we saw on violations: a +1 hour timestamp and an 8-day-old timestamp were each rejected with `400`, and a +5 minute one was accepted. A 300 KB body and a 70 KB attribute each returned `400` for the request **while other records in the same request were stored**.

So a device whose clock is more than 10 minutes ahead loses all its logs. Nothing retries, because `400` means do not retry.

### Tempo 3.1.1 (traces)

Stores spans in Parquet blocks, and keeps events and links queryable: `event:name`, `event.foo`, `link:traceID`, `trace:duration`, `span:duration` (source docs). Common attributes can get dedicated columns.

Limits are in the [traces entry](../data-models/traces.md). Also, attributes over 2048 bytes are truncated. Tempo can generate metrics from spans, with the 30 s lateness window noted there.

### Mimir 3.2.4 (metrics)

Translates OTLP to Prometheus series (source):

- Attribute names are escaped, with an optional suffix strategy.
- Resource attributes go to `target_info` unless listed in `promote_otel_resource_attributes` (experimental).
- Cumulative is the default model. Delta is rejected unless `otel_native_delta_ingestion` is on (experimental).
- Native histogram ingestion is enabled by default, and OTLP exponential histograms translate to native histograms.
- Exemplars are off by default.

Limits: 150,000 active series, 30 labels, 2048-byte values, 10 minutes into the future, out-of-order window off.

### Where the Victoria stack differs (source; not run)

| | VictoriaLogs 1.53 | VictoriaTraces 0.13 | VictoriaMetrics 1.155 |
|---|---|---|---|
| Model | Stream fields define streams; every other field is stored and searchable | Spans stored as fields using the VictoriaLogs storage library | Prometheus-like |
| Resource attributes | **All are stream fields by default**; override with `VL-Stream-Fields` | Prefixed fields | **All promoted to labels by default** |
| `event_name` | **Kept, as a stream field** | Span events flattened into indexed fields | n/a |
| Limits | 2 MB per record, 2000 fields, 128-byte field names, 64 MiB per request | | |
| Bytes | Base64 | | |
| Delta | n/a | n/a | Stored as-is since 1.132, with caveats |
| Exponential histograms | n/a | n/a | Converted to `vmrange` histograms |
| Query | LogsQL | Jaeger APIs | MetricsQL |

Key differences for us: VictoriaLogs has an 8x larger record limit than Loki and keeps `event_name`. But because all resource attributes are stream fields by default, a per-session resource attribute would be expensive, and `event_name` itself becomes part of stream identity. VictoriaMetrics' promote-all default means a chatty resource hurts metrics quickly.

## Practical rules this step supports

- Put low-cardinality identity on the resource and per-occurrence detail on attributes.
- Do not put a per-tab value in any attribute a backend will promote by default.
- Do not rely on a backend keeping `event_name`, bytes, or nested types until checked.
- Validate timestamps before they reach the backend.
