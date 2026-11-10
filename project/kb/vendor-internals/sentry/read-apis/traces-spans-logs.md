# Sentry traces, spans and logs read API

> How does Muninn pull the trace, the spans and the logs that belong to a replay?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10. Spans and logs live in the EAP store (ClickHouse `eap_items_*` tables) and are read through the same `/events/` endpoint with an EAP `dataset`.

## Endpoints

| Method and path | Status | Scope | Notes | Source |
|---|---|---|---|---|
| `GET /api/0/organizations/{org}/trace/{trace_id}/` | public | `org:read` | Span tree with errors attached; params `statsPeriod`/`start`/`end`, `project`, `errorId`, `additional_attributes` (repeatable), `include_uptime=1`. No pagination ("offset and limit don't mean anything") | [organization_trace.py#L164-L174](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_trace.py#L164-L174) |
| `GET /api/0/organizations/{org}/trace-meta/{trace_id}/` | public | `org:read` | Counts: `errorsCount, logsCount, metricsCount, performanceIssuesCount, spansCount, spansCountMap, transactionChildCountMap` | [organization_trace_meta.py#L116](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_trace_meta.py#L116) |
| `GET /api/0/organizations/{org}/events-trace/{trace_id}/`, `events-trace-meta/` | **private** (legacy transactions tree) | `org:read` | Still answers on 26.10.0 | [organization_events_trace.py#L1087](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events_trace.py#L1087) |
| `GET /api/0/organizations/{org}/events/?dataset=spans` | public | `org:read` | Span rows; `per_page` up to 9999 | [organization_events.py#L757](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events.py#L757) |
| `GET /api/0/organizations/{org}/events/?dataset=logs` | public | `org:read` | Log rows (`ourlogs` is the deprecated name) | [snuba/utils.py#L40-L56](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/snuba/utils.py#L40-L56) |
| `GET /api/0/organizations/{org}/trace-logs/?traceId=...` (also `replayId`) | **private** | `org:read` | Logs of one or more traces | [organization_trace_logs.py#L64](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_trace_logs.py#L64) |
| `GET /api/0/organizations/{org}/traces/` | experimental | `org:read` | Trace search | [organization_traces.py#L218](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_traces.py#L218) |
| `GET /api/0/organizations/{org}/trace-items/attributes/` | public | `org:read` | Attribute names per item type (`itemType=spans|logs`) | [organization_trace_item_attributes.py#L697](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_trace_item_attributes.py#L697) |
| `GET /api/0/organizations/{org}/events-timeseries/` | public | `org:read` | Time series over any dataset | [organization_events_timeseries.py#L111](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events_timeseries.py#L111) |

Docs (accessed 2026-11-10): [Retrieve a trace](https://docs.sentry.io/api/discover/retrieve-a-trace/), [Retrieve trace metadata](https://docs.sentry.io/api/discover/retrieve-trace-metadata/), [Explore table](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/), [List logs for traces or a replay](https://docs.sentry.io/api/explore/list-logs-for-traces-or-a-replay/). The docs list `trace-logs` under Explore while the 26.10.0 code marks it private: treat it as unstable.

## Shapes (observed)

- `/trace/{id}/` returns a list of root nodes. Each node: `event_id, event_type ("span"), op, name, description, start_timestamp, end_timestamp, duration, is_transaction, transaction, transaction_id, parent_span_id, project_id, project_slug, sdk_name, profile_id, profiler_id, measurements, errors[], occurrences[], children[], additional_attributes` ([trace.json](fixtures/trace.json)). The probe error sat in `errors[]` of the root span.
- Spans: `id, span.op, span.description, trace, parent_span, transaction, span.duration, precise.start_ts, precise.finish_ts, replay.id, is_transaction, user.id` ([events-spans.json](fixtures/events-spans.json)). **`replay.id` is a span attribute**, so `query=replay.id:<id>` (or `has:replay.id` with `field=replay.id&field=count()`) finds every span of a replay without knowing its traces (observed).
- Logs: `timestamp, timestamp_precise (ns), observed_timestamp (ns), message, severity, severity_number, trace, span_id, sentry.release, sentry.environment, project.id`, plus any attribute name as a field ([events-logs.json](fixtures/events-logs.json)).

## Joining to a replay

1. Replay `trace_ids` (from [replays.md](replays.md)) → `/trace/{id}/` for the tree, or one Explore query `dataset=spans&query=trace:[t1,t2,...]`.
2. Or skip the traces: `dataset=spans&query=replay.id:<replay_id>`.
3. Logs: `dataset=logs&query=trace:[...]`. A `replay_id` attribute on logs exists only if the SDK sets it; the probe's logs had only `trace`.

## Consistency delay (observed, 5 runs)

| Read path | Seconds from send to visible |
|---|---|
| `dataset=logs` | 2.5 – 5.0 |
| `/trace/{id}/` (transaction root) | 6.1 – 7.7 |
| `dataset=spans` (both spans) | **14.5 – 18.0** |

Spans pass through the span buffer before EAP, which explains the extra ~10 s ([ingest-latency-runs.json](fixtures/measurements/ingest-latency-runs.json)).

**Muninn can use it for:** network and performance timelines next to the replay (spans), console-like log lines (logs), and the trace tree for one click-through. Fetch them lazily when a user opens a replay, not during ingest sync.
