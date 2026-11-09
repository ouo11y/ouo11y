# OpenTelemetry: what all three signals share

Part of Step 1 (data models). Read this first; the logs, traces and metrics files build on it.

## Versions read

Checked on 2026-11-09. All were the latest release that day.

| Source | Version | Commit |
|---|---|---|
| opentelemetry-specification | v1.62.0 (2026-10-22) | 18c5c17 |
| opentelemetry-proto (also holds the OTLP specification) | v1.11.1 (2026-09-29) | b3f7558 |
| semantic-conventions | v1.45.0 (2026-11-02) | fb30ca1 |
| opentelemetry-collector and -contrib | v0.165.0 (2026-11-06/07) | e883d73, f56f9a3 |
| W3C Trace Context Level 2 | Candidate Recommendation Draft, 2024-03-28 | |
| Loki / Tempo / Mimir | 3.7.9 / 3.1.1 / 3.2.4 | d3b4a2f, 9db7df7, 4380c34 |
| VictoriaLogs / VictoriaTraces / VictoriaMetrics | 1.53.0 / 0.13.0 / 1.155.0 | 915d919, f0295d1, 3fec2f7 |

How each claim in these files was checked:

- **spec** or **proto**: read in the text at the version above.
- **source**: read in the backend's or Collector's code or bundled docs. Not run.
- **tested**: run against a real container. Method in the [agent summary](../../../agents/otel-data-models/summaries/2026-11-09-step1-otel-data-models.md).

## The envelope: Resource, then Scope, then record

Every signal nests the same way. The point of the nesting is that a batch names the sender once.

```
Export<Signal>ServiceRequest
└─ Resource<Signal>[]          who produced this (app, device, browser)
   ├─ resource: Resource
   ├─ schema_url
   └─ Scope<Signal>[]          which library inside it produced this
      ├─ scope: InstrumentationScope
      ├─ schema_url
      └─ records[]             log_records / spans / metrics
```

| Message | Fields (number) | Status |
|---|---|---|
| `Resource` | `attributes` (1), `dropped_attributes_count` (2), `entity_refs` (3) | Stable, except `entity_refs` which is Development |
| `InstrumentationScope` | `name` (1), `version` (2), `attributes` (3), `dropped_attributes_count` (4) | Stable |
| `Resource*` wrapper | `resource` (1), `scope_*` (2), `schema_url` (3) | Stable |
| `Scope*` wrapper | `scope` (1), records (2), `schema_url` (3) | Stable |

**Resource** says what is emitting. It should be the same for every record from that source. A value that changes from one record to the next belongs in record attributes. Resource data is also what backends most readily turn into indexes and labels, so it has a large effect on storage cost (see [backends](../storage-backends/signal-choice-and-backends.md)).

**Instrumentation scope** names the code that produced the data, such as `ouo.web` version `0.3.0`. It is not the application.

**`schema_url`** names the semantic convention version the data follows.

## AnyValue and attributes

`AnyValue` (proto) is a oneof: `string_value` 1, `bool_value` 2, `int_value` 3 (int64), `double_value` 4, `array_value` 5, `kvlist_value` 6, `bytes_value` 7. Field 8, `string_value_strindex`, is Alpha and only for profiling. An `AnyValue` with nothing set is a valid empty value.

- Maps and arrays can nest to any depth.
- Empty values, zero, the empty string and the empty array are all meaningful and MUST be passed on (spec).
- `KeyValue` is a `key` (1) plus a `value` (2). Field 3, `key_strindex`, is profiling only.
- Keys within an attribute collection or map MUST be unique. Receivers can behave unpredictably on duplicates.

Attribute values accept the full `AnyValue` set, including maps and byte arrays, not only primitives (spec common/README). Do not assume a backend preserves those types. See [backends](../storage-backends/signal-choice-and-backends.md).

### Attribute limits

These are SDK defaults (spec, environment variables):

| Limit | Default | Applies to |
|---|---|---|
| `OTEL_ATTRIBUTE_COUNT_LIMIT` | 128 | attribute collections |
| `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` | no limit | string and byte values |
| Per-signal versions (`OTEL_SPAN_...`, `OTEL_LOGRECORD_...`) | same | override the general ones |
| `OTEL_SPAN_EVENT_COUNT_LIMIT`, `OTEL_SPAN_LINK_COUNT_LIMIT` | 128 | spans |
| `OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT`, `OTEL_LINK_ATTRIBUTE_COUNT_LIMIT` | 128 | span events, links |

- Going over the length limit **truncates**. Strings count characters and byte arrays count bytes.
- Going over the count limit **discards** the new attribute and adds to `dropped_attributes_count`.
- These limits cover attributes only. The log `body` has no SDK limit in the spec, so a large body is limited only by the transport and backend.
- The count limit covers top-level attributes only, not keys nested in maps.

## Identity and correlation

| Item | Shape | Meaning |
|---|---|---|
| `trace_id` | 16 bytes | All spans in one trace share it. All zero or wrong length is invalid. |
| `span_id` | 8 bytes | One span. Same validity rule. |
| `parent_span_id` | 8 bytes | Empty means a root span. |
| Trace flags | 8 bits | Bit 0 `sampled`. Bit 1 `random` (Level 2): the right-most 7 bytes of the trace id are random. |
| `trace_state` | string | Vendor key/value list. OTel uses the `ot` key, at most 256 characters (Development). |

### `traceparent`

The W3C header that carries this across HTTP:

```
traceparent: 00-5b8efff798038103d269b633813fc60c-eee19b7ec3c1b174-01
             │  │ 32 hex: trace-id                │ 16 hex        │ flags
             └ version                            └ parent-id     └ 01 = sampled
```

In the header, `parent-id` is the sender's own span id. It becomes `parent_span_id` on the receiver's span. Level 2 of the W3C spec, which adds the random flag, is still a Candidate Recommendation Draft, though the OTel spec already follows it.

`traceparent` is not a CORS-safelisted header. A browser can only send it cross-origin if the API server allows it.

### How signals tie together

- A **log record** carries its own `trace_id`, `span_id` and `flags` fields. That is the whole link, with no containment.
- A **span** has parent and links.
- A **metric** has no trace identity on the data point. Only its optional **exemplars** carry a `trace_id` and `span_id`.

## Time

All timestamps are unsigned 64-bit nanoseconds since the Unix epoch, sent as `fixed64` (always 8 bytes on the wire). In OTLP/JSON they are decimal strings.

| Signal | Timestamps | Clock |
|---|---|---|
| Log | `time_unix_nano` (occurred), `observed_time_unix_nano` (seen by OTel) | Source, and whoever observed |
| Span | `start_time_unix_nano`, `end_time_unix_nano`; each event has `time_unix_nano` | Source |
| Metric point | `start_time_unix_nano` (window start), `time_unix_nano` (window end) | Source |

### Client clock skew

Neither the spec nor the protocol has any concept of skew; the word does not appear in the trace, logs, metrics or common spec folders. Every timestamp is whatever the device clock said. A phone or laptop can be minutes or hours off, and clocks can jump.

Only logs have a second timestamp, and for SDK-emitted logs it is normally set from the same clock at the same moment, so it does not help unless something later overwrites it. Spans and metrics have no second time at all.

Backends do enforce windows, and the result is **lost data**, not a skewed chart (tested on Loki, see [backends](../storage-backends/signal-choice-and-backends.md)). Any correction has to be designed by us: for example, have the SDK or the edge compare the device clock with server time and adjust. That is a Step 3 question.

## Stability, short version

| Part | Status |
|---|---|
| OTLP for traces, metrics, logs; common and resource protos | Stable |
| Profiles signal | Development |
| Log data model, including `EventName` | Stable |
| Trace API and data | Stable, except marked parts |
| Metrics data model | Mixed: core is Stable; Resets and Gaps, Overlap, Stream Manipulations are Development |
| Resource entities (`entity_refs`) | Development |
| Trace state handling, ProbabilitySampler, CompositeSampler | Development |
| **Semantic conventions for events, browser, session** | **Development** |

The wire format is safe to build on. The names we would use for browser telemetry are not stable yet, and that is the core issue for Step 2.

## Related

[otlp.md](../wire-protocol/otlp.md), [logs.md](logs.md), [traces.md](traces.md), [metrics.md](metrics.md)
