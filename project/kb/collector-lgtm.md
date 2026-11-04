# collector lgtm

Status: filled in Phase 1 by platform-infra (2026-10-06), verified with `deploy/scripts/smoke.sh`.
Updated in Phase 8a (2026-10-10, ADR-0007 revised): the collector is a custom distribution
(`collector/`) and the only public ingest, with Basic project credentials; see "Exposure
change" at the end. The collector config itself is now owned by the collector agent.

## Question

Which OpenTelemetry Collector + Loki + Tempo + Mimir configuration accepts OTLP (and
replay chunks) from browsers, phones and backends behind a per-project HTTP Basic
credential, stamps `ouo.project.id`, stores traces searchable by `session.id`, stores
session events in Loki with `service_name`, `event_name`, `ouo_platform` as the only
promoted labels, and stores metrics in Mimir, all on one laptop with Docker Compose?

## Exact image tags (pinned in deploy/compose/compose.yaml)

| Image | Tag | Notes |
|---|---|---|
| grafana/grafana | 13.2.5 | Alpine based, has `wget` (healthcheck works) |
| grafana/loki | 3.7.7 | distroless |
| grafana/tempo | 3.0.3 | distroless; **config schema changed vs 2.x** |
| grafana/mimir | 3.2.1 | distroless |
| ouo/collector (built from `collector/`, ocb) | compose `build` | distroless; upstream components pinned in `collector/builder.yaml` (contrib 0.160.0 line). Phases 1 to 8a-rev1 ran `otel/opentelemetry-collector-contrib:0.160.0` |

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

### Collector (`deploy/compose/collector/config.yaml`)

- `receivers.otlp.protocols.http` on `0.0.0.0:4318` with `auth.authenticator:
  basicauth/projects` (htpasswd file), `include_metadata: true` and a `cors:` block
  (`allowed_origins: ["http://localhost:*", "http://127.0.0.1:*"]`, `allowed_headers:
  ["*"]`). Verified against a throwaway stock contrib 0.160.0 with exactly that shape: a
  preflight `OPTIONS /v1/traces` from `Origin: http://localhost:5173` answers `204` with
  `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: authorization,content-type`
  (it echoes the requested headers), `Access-Control-Allow-Credentials: true`; a foreign
  origin gets `204` with no allow headers; `POST` without credential, with a wrong
  password or with an unknown username is `401`; and a `resource` processor with
  `from_context: auth.username` upserts `ouo.project.id=demo` over a client-sent
  `spoofed` (seen in the debug exporter). Note the endpoints must be `0.0.0.0:…`; recent
  collectors default to `localhost`, which is unreachable inside a container. Network
  exposure is decided by the compose port binding, not by the receiver.
- The `{SHA}` htpasswd format is `base64(sha1(token))`: `htpasswd -nbs demo <token>` and
  `printf '%s:{SHA}%s\n' demo "$(printf '%s' <token> | openssl dgst -binary -sha1 | openssl base64)"`
  produce the identical line (`demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=` for the dev token),
  so `install.sh` needs no `apache2-utils`.
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
`deploy/compose/loki/config.yaml`:

```yaml
limits_config:
  allow_structured_metadata: true     # mandatory for OTLP
  otlp_config:
    resource_attributes:
      ignore_defaults: true           # default list includes service.instance.id, k8s.*, cloud.*
      attributes_config:
        - action: index_label
          attributes: [service.name, service.namespace, deployment.environment.name, ouo.platform, ouo.project.id]
    log_attributes:
      - action: index_label
        attributes: [event.name, ouo.platform]
```

Result (`GET /loki/api/v1/labels`): `deployment_environment_name, event_name, ouo_platform,
ouo_project_id, service_name` (`service_namespace` when a resource sets it). `ouo_project_id`
(added in roadmap 8b) is what funnels' project filter, per-project `retention_stream` and
delete-by-project select on. This block is for ouo's **own** Loki: in a Loki shared with other
senders, `ignore_defaults: true` would drop their `k8s_*` / `service_instance_id` labels; add
the ouo attributes to the defaults instead (`docs/operations/existing-lgtm.md`,
`project/kb/existing-lgtm.md`). Everything else (`session_id`, `user_id`, `service_version`, `trace_id`,
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

### Grafana provisioning (`deploy/compose/grafana/provisioning/datasources/datasources.yaml`)

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
  `${OUO_*_PORT:-default}` so a `deploy/compose/.env` can move them. Container-side ports
  and in-network hostnames never change.
- A compose port of the form `127.0.0.1:${VAR:-4318}:4318` interpolates fine
  (`host_ip: 127.0.0.1` in `docker compose config`). Docker binds IPv4 loopback only, so
  scripts that probe the collector should use `127.0.0.1` rather than `localhost` on
  hosts where `localhost` resolves to `::1` first (curl falls back, `nc`/`wget` may not).
- Compose override files can *replace* a list instead of appending with the `!override`
  YAML tag (`ports: !override [...]`), which is how `deploy/vm/compose.tls.yaml` re-binds
  the LGTM ports to loopback. Relative paths in an override resolve against the first
  `-f` file's directory, so the override references `../vm/Caddyfile`.
- The Grafana provisioner expands `${VAR}` in every provisioning file (which is why the
  datasource file escapes `$$`); the plugin file uses that on purpose for
  `secureJsonData.readToken: ${OUO_READ_TOKEN}`, and compose passes the variable into
  the Grafana container's environment.
- Loki rejects samples older than `reject_old_samples_max_age` (168h); send current
  timestamps when replaying fixtures.
- Tempo 3.x single binary logs `error calling scheduler ... no jobs found` continuously;
  cosmetic.
- Loki's `ouo_platform` label works whether the SDK sets `ouo.platform` on the resource or
  on each log record, because it is listed in both `resource_attributes` and
  `log_attributes` and the collector copies it down from the resource.

## Exposure change (Phase 8a, ADR-0007 revised)

Until Phase 7 the browser SDK posted OTLP straight to `localhost:4318` and the collector
published that port on `0.0.0.0` with wildcard-ish CORS. Fine on a laptop, unacceptable
anywhere else: anyone who can reach the port can write arbitrary telemetry into Loki,
Tempo and Mimir, projects cannot be told apart, nothing is rate- or size-limited.

The first 8a draft moved the browser path into rum-api (`/ingest/otlp/*`, project token
header, collector on loopback). The founder's review reversed it: the OpenTelemetry
Collector is the product's ingress, so it has to be the *only* edge, and rum-api is as
internal as Loki. What `deploy/` looks like after the revision:

- `compose.yaml` builds `ouo/collector` from `../../collector` (ocb distribution with
  `basicauth`, the `ouoreplay` receiver + exporter and the `ouoratelimit` processor) and
  publishes `${OUO_OTLP_HTTP_PORT:-4318}:4318` and `${OUO_REPLAY_PORT:-4319}:4319` on all
  interfaces. `4317` (gRPC) and `13133` (health) stay on `127.0.0.1`. Config and
  `projects.htpasswd` are bind-mounted from `deploy/compose/collector/` (collector agent's
  files). The collector gets `OUO_INGEST_TOKEN`, the bearer its replay exporter presents
  to rum-api.
- Every ingest request carries `Authorization: Basic base64("<project id>:<project
  token>")`. The username becomes `ouo.project.id` (a `resource` processor reading
  `auth.username`), so the client-sent value is overwritten. Hash is `{SHA}`: cheap, the
  token is public anyway.
- rum-api lost the gateway, the project registry (`projects.example.yaml` is gone) and
  all `OUO_PROJECT_*` / `OUO_ALLOWED_ORIGINS` / `OUO_COLLECTOR_*` variables. It keeps
  `POST /v1/replay/chunks` as the sink for the collector (requires `X-Ouo-Project-Id` and
  `Bearer <OUO_INGEST_TOKEN>`) and `OUO_READ_TOKEN` for `GET/DELETE /v1/*`. Its host port
  stays published on the laptop for curl; the VM override binds it to loopback and the
  Helm chart gives it a ClusterIP Service.
- In-network services are clients like everybody else: the `backend` and `rum-api`
  services carry `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>` (variable
  `OUO_BACKEND_OTLP_HEADERS`, default demo). `%20` is the OTLP env-var encoding of the
  space; the Go exporters `url.PathUnescape` header values (checked in
  `otlptracehttp@v1.47.0/internal/envconfig`).
- `smoke.sh` posts to the collector and proves: CORS allow headers on both public ports
  for `http://localhost:5173`; `401` without credential, wrong token, unknown project,
  replay chunk without credential; `401` on rum-api's sink without the ingest token;
  the stamp (`{ resource.ouo.project.id = "demo" }`, trace by id, Loki
  `ouo_project_id="demo"`); and that a chunk posted to `:4319` is readable from rum-api
  with the read token. `wait-ready.sh` probes the collector health on loopback and expects
  any HTTP answer (401) from the two public ports. `e2e.sh` exports `OUO_OTLP_URL`
  (`:4318`), `OUO_REPLAY_URL` (`:4319`), `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`,
  `OUO_PROJECT_BASIC`, `OUO_RUM_API_URL`, `OUO_READ_TOKEN` and the Grafana variables.
- Server install: `deploy/vm/compose.tls.yaml` adds Caddy (`caddy:2.11.7`); the Caddyfile
  routes `otel.<domain>` with `@replay path /v1/replay/*` to `otel-collector:4319` and a
  bare `handle` to `otel-collector:4318`, `<domain>` to Grafana, `tls {$OUO_TLS:internal}`.
  Every other port, the collector's included, is re-bound to loopback with `ports:
  !override`, and `volumes: !override` swaps the dev `projects.htpasswd` for the
  server-side `deploy/compose/projects.htpasswd` (gitignored) that `install.sh` writes.
  Verified with `caddy validate` (internal, ACME email, unset) and a throwaway Caddy with
  fake `grafana` / `otel-collector` upstreams: `/v1/traces` and `/v1/logs` hit 4318,
  `/v1/replay/chunks` hit 4319 (`202` passed through), Grafana host served, unknown SNI
  refused, `X-Forwarded-For` appended.
- Caveat for the collector agent: behind Caddy the collector's TCP peer is always Caddy,
  so an `ouoratelimit` per-`client.address` bucket would throttle the whole site. It
  needs to read `X-Forwarded-For` from the request metadata (`include_metadata: true`
  makes headers available) or the per-client limit must be disabled in the VM config.

Why the collector keeps `0.0.0.0` inside the container: a receiver bound to `localhost`
is unreachable from rum-api and the demo backend on the compose network. Network
exposure is a compose (or Kubernetes Service) concern, not a receiver concern.
