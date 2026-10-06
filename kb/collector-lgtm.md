# collector lgtm

Status: filled in Phase 1 by platform-infra (2026-10-06). Verified with `deploy/scripts/smoke.sh`.

## Question

Which OpenTelemetry Collector + Loki + Tempo + Mimir configuration accepts OTLP straight
from a browser (CORS), stores traces searchable by `session.id`, stores session events in
Loki with `service_name`, `event_name`, `ouo_platform` as the only promoted labels, and
stores metrics in Mimir, all on one laptop with Docker Compose?

## Exact image tags (pinned in deploy/docker/compose.yaml)

| Image | Tag | Notes |
|---|---|---|
| grafana/grafana | 13.2.1 | Alpine based, has `wget` (healthcheck works) |
| grafana/loki | 3.7.7 | distroless |
| grafana/tempo | 3.0.3 | distroless; **config schema changed vs 2.x** |
| grafana/mimir | 3.2.1 | distroless |
| otel/opentelemetry-collector-contrib | 0.160.0 | distroless |

## What was tried

1. Tempo 2.x style config with `ingester:` and `compactor:` blocks and
   `metrics_generator.traces_storage`. Tempo 3.0.3 refuses to start:
   `field ingester not found in type app.Config`, `field compactor not found`,
   `field traces_storage not found in type generator.Config`. 3.0 replaced the ingester /
   compactor with block-builder / live-store; the defaults are fine for local use, so those
   blocks are simply gone.
2. Docker `healthcheck` with `wget` on loki / tempo / mimir / collector: all four images are
   distroless (no `/bin/sh`, no `wget`), the checks fail forever and `depends_on:
   condition: service_healthy` blocks Grafana and the collector. Removed; readiness is
   probed from the host by `deploy/scripts/wait-ready.sh` and the collector's exporters
   retry until the backends answer.
3. Grafana 13 Tempo datasource health: `gRPC streaming call failed ... frame too large,
   note that the frame header looked like an HTTP/1.1 header`. Grafana streams search
   results over gRPC on Tempo's HTTP port; Tempo needs top-level
   `stream_over_http_enabled: true`. With it: "Streaming test succeeded".
4. Grafana provisioning expands `${...}` itself, so a tracesToLogsV2 `query` containing
   `${__span.tags[...]}` was provisioned as `{} | session_id=""`. Escape every `$` as `$$`
   in the YAML.
5. Collector 0.160 warns that exporter ids `otlp` / `otlphttp` are deprecated aliases;
   the config uses `otlp_grpc/tempo`, `otlp_http/loki`, `otlp_http/mimir`.
6. Mimir metric naming: with `limits.otel_metric_suffixes_enabled: false` an OTLP
   monotonic sum named `ouo_smoke_requests` is stored as `ouo_smoke_requests` (no
   `_total`, no unit suffix). Keep that in mind when writing PromQL for SDK metrics.

## What works

### Collector (`deploy/docker/collector/config.yaml`)

- `receivers.otlp.protocols.http` on `0.0.0.0:4318` with
  `cors.allowed_origins: ["http://localhost:*", "http://127.0.0.1:*"]` and
  `allowed_headers: ["*"]`. A preflight `OPTIONS /v1/traces` with
  `Origin: http://localhost:5173` answers `Access-Control-Allow-Origin: http://localhost:5173`
  and `Access-Control-Allow-Headers: Content-Type, Traceparent, Baggage`. Note the
  endpoints must be `0.0.0.0:…`; recent collectors default to `localhost`, which is
  unreachable inside a container.
- Pipelines: traces -> `otlp_grpc/tempo` (`tempo:4317`, insecure), logs ->
  `otlp_http/loki` (`http://loki:3100/otlp`), metrics -> `otlp_http/mimir`
  (`http://mimir:9009/otlp`). Processors `memory_limiter` then `batch`.
- A `transform/events` processor on the logs pipeline copies the OTLP top-level
  `event_name` field (what the OTel JS Logs API sets with `eventName`) into the
  `event.name` log attribute when the attribute is absent, and copies a resource-level
  `ouo.platform` into the log attributes. This keeps the Loki label mapping working
  whichever way an SDK sets them.

### Loki label mapping (the approach that works)

Loki 3.x maps OTLP attributes to labels through its own config, not through collector
hints (`loki.resource.labels` / `loki.attribute.labels` only applied to the removed
`loki` exporter; with the native OTLP endpoint they are ignored). In
`deploy/docker/loki/config.yaml`:

```yaml
limits_config:
  allow_structured_metadata: true     # mandatory for OTLP
  otlp_config:
    resource_attributes:
      ignore_defaults: true           # default list includes service.instance.id, k8s.*, cloud.*
      attributes_config:
        - action: index_label
          attributes: [service.name, service.namespace, deployment.environment.name, ouo.platform]
    log_attributes:
      - action: index_label
        attributes: [event.name, ouo.platform]
```

Result (`GET /loki/api/v1/labels`): `deployment_environment_name, event_name, ouo_platform,
service_name`. Everything else (`session_id`, `user_id`, `service_version`, `trace_id`,
`span_id`, `severity_text`, `ouo_session_started_at`, …) is structured metadata and is
filtered with `| session_id="…"` after the stream selector. Loki rewrites `.` to `_` in
both label and metadata names. Schema must be `v13` + `tsdb` for structured metadata.

Working LogQL: `{service_name="smoke", event_name="session.start", ouo_platform="web"} | session_id="smoke-session"`.

### Tempo

- `stream_over_http_enabled: true`, `distributor.receivers.otlp` (grpc 4317 / http 4318),
  `storage.trace.backend: local` (`/var/tempo/wal`, `/var/tempo/blocks`),
  `metrics_generator` with `remote_write` to `http://mimir:9009/api/v1/push` and
  `overrides.defaults.metrics_generator.processors: [service-graphs, span-metrics]`.
  Span metrics and service graph series show up in Mimir
  (`traces_spanmetrics_calls_total`, `traces_service_graph_request_total`).
- Search by session: `GET /api/search?q={ span.session.id = "smoke-session" }` (TraceQL,
  `span.` scope because SDKs set `session.id` as a span attribute). Backend spans:
  `{ resource.service.name = "demo-backend" && span.session.id = "…" }`.
  `GET /api/v2/search/tag/span.session.id/values` lists known session ids.
- Trace by id: `GET /api/traces/<hex id>`; a trace found in the first seconds via search may
  take a few seconds longer to be served by id (smoke script retries).

### Mimir

Monolithic (`target: all`, `multitenancy_enabled: false`), `common.storage.backend:
filesystem`, memberlist rings bound to `127.0.0.1`. OTLP push is
`POST /otlp/v1/metrics` (the collector's `otlp_http` exporter appends `/v1/metrics` to
`http://mimir:9009/otlp`). Query through `/prometheus/api/v1/query`. Resource attribute
`service.name` becomes the `job` label; other resource attributes are kept in
`target_info`, data point attributes become labels (`ouo_platform`, `run_id`).

### Grafana provisioning (`deploy/docker/grafana/provisioning/datasources/datasources.yaml`)

- uids `loki`, `tempo`, `mimir` (type `prometheus`, url `http://mimir:9009/prometheus`).
- Loki `derivedFields`: `matcherType: label`, `matcherRegex: trace_id` -> Tempo
  (`trace_id` is structured metadata, which Grafana exposes as a label field).
- Tempo `tracesToLogsV2` custom query (verified: Grafana's `${__span.tags[...]}` resolves
  span **and** resource attributes, the field path is parsed by lodash `property`, so a
  bracketed key with dots works, and `/api/ds/query` shows `service.name` in
  `serviceTags`):
  `{service_name="${__span.tags["service.name"]}"} | session_id="${__span.tags["session.id"]}"`
  with `spanStartTimeShift: -30m` / `spanEndTimeShift: 30m` (a session is long-lived; a
  span's own window would hide its `session.start`).
- `serviceMap.datasourceUid: mimir`, `tracesToMetrics.datasourceUid: mimir`,
  `lokiSearch.datasourceUid: loki`, `streamingEnabled.search: true`.

## Gotchas

- Bind-mounting a directory that does not exist makes `docker compose up` fail, so the
  Phase 4 plugin volume is a commented line, not an optional mount.
- Host ports 3000/3100/3200/4317/4318 are popular; compose exposes them as
  `${OUO_*_PORT:-default}` so a `deploy/docker/.env` can move them. Container-side ports
  and in-network hostnames never change.
- Loki rejects samples older than `reject_old_samples_max_age` (168h); send current
  timestamps when replaying fixtures.
- Tempo 3.x single binary logs `error calling scheduler ... no jobs found` continuously;
  cosmetic.
- Loki's `ouo_platform` label works whether the SDK sets `ouo.platform` on the resource or
  on each log record, because it is listed in both `resource_attributes` and
  `log_attributes` and the collector copies it down from the resource.
