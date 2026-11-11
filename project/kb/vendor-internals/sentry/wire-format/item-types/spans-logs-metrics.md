# Spans, logs and trace metrics: span, log, trace_metric, metric_buckets, integration

Versions: Relay 26.10.0, Sentry 26.10.0, Snuba 26.10.0. Researched 2026-11-10. These are the "EAP" signals: in self-hosted 26.10.0 they all end in ClickHouse `eap_items_1_local` (see [../../self-hosted-storage/clickhouse-schema.md](../../self-hosted-storage/clickhouse-schema.md)). Develop docs: <https://develop.sentry.dev/sdk/telemetry/spans/>, <https://develop.sentry.dev/sdk/telemetry/logs/>, <https://develop.sentry.dev/sdk/telemetry/metrics/> (accessed 2026-11-10).

## Container format

`log`, `trace_metric` and span v2 items are **item containers** ([`envelope/container.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/container.rs)):

```
{"type":"log","item_count":2,"content_type":"application/vnd.sentry.items.log+json","length":N}
{"items":[{...},{...}]}
```

- `item_count` is required and must equal `items.length`. Observed: `item_count: 5` with 2 logs → 200, then all **5** counted as `invalid_json` outcomes and nothing stored.
- Limits: one container per type per envelope; whole container ≤ 12 MiB (`max_container_size`); each log ≤ 2 MiB, each metric ≤ 1 MiB, each span ≤ 10 MiB.

## Typed attributes

All three use the same attribute map ([`relay-event-schema/src/protocol/attributes.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/attributes.rs)):

```json
"attributes": {"route": {"type": "string", "value": "/step6"}, "n": {"type": "integer", "value": 7}}
```

Types: `boolean`, `integer`, `double`, `string`, `array`. Unknown types are kept as invalid. Keys starting with `sentry.` are Sentry's own (`sentry.release`, `sentry.environment`, `sentry.sdk.name`, `sentry.replay_id`, `sentry.message.template`, `sentry.message.parameter.N`, `sentry.origin`, `sentry.segment.id`, ...).

## `span`

Two forms, decided by the content type (`processing/spans/mod.rs`):

| Form | Header | Payload |
|---|---|---|
| Span v2 container | `content_type: application/vnd.sentry.items.span.v2+json`, `item_count` | `{"items":[SpanV2...]}` |
| Legacy v1 span | no content type | one span JSON per item, max 25 per envelope |

SpanV2 fields ([`protocol/span_v2/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/span_v2/mod.rs)): `trace_id`, `span_id`, `parent_span_id`, `name`, `status` (`ok`/`error`), `is_segment`, `start_timestamp`, `end_timestamp` (float seconds), `links[] {trace_id, span_id, sampled, attributes}`, `attributes`. The op goes in attribute `sentry.op`.

Legacy v1 fields: `trace_id`, `span_id`, `parent_span_id`, `segment_id`, `is_segment`, `op`, `description`, `start_timestamp`, `timestamp`, `status`, `tags`, `data`, `measurements`, `exclusive_time`. Relay converts v1 to v2 (`relay-spans/src/v1_to_v2.rs`). Observed: our legacy span `op: ui.render, description: "step6 legacy span"` was stored with `sentry.name = "Component render"`, `sentry.raw_description = "step6 legacy span"` (name inference in `relay-spans/src/name.rs`).

Path: Relay → Kafka `ingest-spans` (`SpanKafkaMessage`, JSON) → Sentry `process-spans` consumer (buffers spans per segment in Redis, then flushes the segment; `buffered-segments` topic) → `snuba-items` (protobuf `TraceItem`) → `snuba-eap-items-consumer` → `eap_items_1_local` with `item_type = 1`. Categories `span`, `span_indexed`.

## `log`

`OurLog` ([`protocol/ourlog/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/ourlog/mod.rs)): `timestamp` (float s), `trace_id`, `span_id`, `level` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`), `body`, `attributes`. Relay adds `sentry.observed_timestamp_nanos`, `sentry.body` copy, browser/OS info, and a byte size. Kafka: directly `snuba-items` as a `TraceItem` (`KafkaMessage::Item`), `item_type = 3`. Categories `log_item`, `log_byte`. Requires org feature `organizations:ourlogs-ingestion`.

Observed: 2 logs from our container were stored; attributes `step6.k`, `sentry.span_id` visible in `attributes_string_*`. Note our `ouosentryreceiver` already decodes this format (see [../ouo-receiver-gaps.md](../ouo-receiver-gaps.md)).

Other sources of logs: OTLP `/v1/logs`, `/nel/` (browser Network Error Logging), browser Integrity Policy reports, Vercel log drains. All become the same EAP log rows.

## `trace_metric`

`TraceMetric` ([`protocol/trace_metric/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/trace_metric/mod.rs)): `timestamp`, `trace_id`, `span_id`, `name`, `type` (`counter`, `gauge`, `distribution`), `unit`, `value`, `attributes`. Content type `application/vnd.sentry.items.trace-metric+json`. Kafka `snuba-items`, `item_type = 8`. Categories `trace_metric`, `trace_metric_byte`. Requires `organizations:tracemetrics-ingestion` (default on in self-hosted). Observed: our counter `step6.clicks` was stored as one EAP row (`sentry.metric_type = counter`). Sentry also derives trace metrics from spans (observed: a `distribution` row with `sentry.metric.source = span`).

## `metric_buckets`

Pre-aggregated metric buckets, used between Relays. In 26.10.0 Relay forwards only the `sessions` namespace to Kafka (`ingest-metrics`); span and transaction metric namespaces are dropped ("no longer ingested", `send_metric_message` in [`services/store.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/store.rs)). The old `statsd` and `metric_meta` item types are gone. SDK custom metrics (the 2024 beta) do not exist any more; `trace_metric` replaces them.

## `integration`

Internal only. Created by the OTLP, NEL, Integrity and Vercel endpoints with a content type like `application/vnd.sentry.integration.otel.spans+protobuf`. An envelope from outside that contains it gets 400 `envelope contains internal items` (observed). See [../otlp-ingest.md](../otlp-ingest.md).
