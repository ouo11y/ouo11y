# Run ouo on an existing Loki, Tempo and Mimir

This page is for a team that already runs Grafana's LGTM backends (its own Loki, Tempo and
Mimir, often behind its own OpenTelemetry Collectors) and wants ouo's data in them, not in a
second, bundled stack. ouo then deploys only its collector (the public ingest edge), rum-api
and, if you want it, its Grafana. The page covers what the existing backends need, what changes
for the data already in them, and how each deployment path points at them. If you add the Loki
settings the way shown below, nothing changes for your existing data.

| Deployment | How |
|---|---|
| Helm | `lgtm.mode: external`, `-f deploy/helm/ouo/values-external-lgtm.yaml` (`deploy/helm/ouo/README.md`, Install A) |
| Compose / VM | `-f deploy/compose/compose.external.yaml` after the other compose files (section 7) |

Verified on 2026-11-04 against a "client-shaped" stack (`tests/e2e/existing-lgtm/`, section 9):
- a single-tenant Loki 3.7.7 with Loki's own default OTLP labels, 336h retention and compactor deletion
- Tempo 3.0.3 and Mimir 3.2.1
- an OTel Collector contrib 0.160.0 in front of them

## 1. What stays where

```
browsers, phones, backends ──OTLP + replay──▶ ouo collector (public edge, ADR-0007)
                                                │ OTLP: traces (gRPC), logs + metrics (HTTP)
                                                ▼
                         your OTel collector ──▶ your Loki / Tempo / Mimir   (or directly to them)

                     replay chunks ──▶ rum-api (its own store: disk or S3) ──reads──▶ Loki, Tempo
                                                ▲
                            Grafana + ouo plugin ┘ (reads Loki / Tempo / Mimir through datasources)
```

- The **ouo collector stays the only public ingest** (ADR-0007). Project credentials, CORS,
  rate limits, `ouo.project.id` stamping, the replay receiver and the Sentry bridge all live
  there. Your collectors are a downstream hop. They are not an edge for ouo's SDKs.
- **Replays never reach Loki.** The collector forwards them to rum-api, which keeps them in its
  own replay store (filesystem or S3). Their retention is rum-api's `retention.replays`.
- rum-api and Grafana **read** your Loki and Tempo:
  - rum-api: session list, health, funnels, session logs, trace counts, deletions.
  - Grafana: Explore, trace view, the plugin's links.

## 2. Loki

### 2.1 Required (without these ouo shows no sessions)

| Setting | Why |
|---|---|
| `schema_config` period with `store: tsdb`, `schema: v13` | structured metadata exists only on v13 / tsdb |
| `limits_config.allow_structured_metadata: true` (the 3.x default) | `session.id`, `user.id`, `trace_id`, `service.version` and every other ouo attribute land there |
| OTLP ingestion (`/otlp/v1/logs`, on by default in 3.x) | the ouo collector, or your collector, sends OTLP |
| the **additive** `otlp_config` below | the stream labels rum-api selects on |

ouo's own bundled Loki (`deploy/compose/loki/config.yaml`) uses `ignore_defaults: true` and a
fixed label list. That suits a stack that holds only ouo data and wants as few labels as possible.
**Do not copy that block into a shared Loki.** `ignore_defaults: true` replaces Loki's default
resource-attribute list for every sender. New streams from your own services would lose their
`k8s_namespace_name`, `k8s_pod_name`, `service_instance_id`, `cloud_region` and similar labels,
and your queries and alerts on those labels would stop matching.

Add ouo's attributes instead. When `ignore_defaults` is false, Loki appends `attributes_config`
entries to its defaults:

```yaml
limits_config:
  allow_structured_metadata: true
  otlp_config:
    resource_attributes:
      # ignore_defaults: false (the default): Loki's own list (service.name, service.namespace,
      # service.instance.id, deployment.environment(.name), cloud.*, k8s.*, container.name)
      # keeps working for every sender.
      attributes_config:
        - action: index_label
          attributes:
            - ouo.platform
            - ouo.project.id
    log_attributes:
      - action: index_label
        attributes:
          - event.name
          - ouo.platform
```

Already have an `otlp_config`? Append the two entries to your `attributes_config` and
`log_attributes` lists. On a multi-tenant Loki, you can put the same block into the ouo
tenant's `overrides` in the runtime config, not the global `limits_config`.

The stream labels ouo uses (Loki writes `.` as `_`):

| Label | From | Used by |
|---|---|---|
| `service_name` | resource `service.name` (Loki default) | every query: `{service_name=~".+", ...}` |
| `deployment_environment_name` | resource `deployment.environment.name` (Loki default) | funnels' environment filter |
| `service_namespace` | resource `service.namespace` (Loki default) | Grafana Explore |
| `event_name` | log attribute `event.name` (the collector copies the OTLP `EventName` field into it) | session list, health, vitals, funnels: `event_name=~...` |
| `ouo_platform` | resource or log attribute `ouo.platform` (web, ios, android, react-native) | platform filters |
| `ouo_project_id` | resource `ouo.project.id`, stamped by the ouo collector from the project credential | funnels' project filter, per-project `retention_stream`, delete by project |

Everything else stays structured metadata, filtered after the selector (`| session_id="..."`,
`| user_id="..."`).

The cost to your Loki is small:
- `ouo_project_id` has one value per ouo project.
- `ouo_platform` has four values.
- `event_name` has the SDKs' fixed event set (about 25) plus your custom event names.

The `event.name` log-attribute rule also applies to your own services' logs. A service that sets
an `event.name` attribute (OTel events) gets an `event_name` label too.

To check, restart Loki, then:
- `GET /config`: under `limits_config.otlp_config.resource_attributes.attributes_config`, Loki's
  default list comes first, followed by the ouo entries.
- `GET /loki/api/v1/series?match[]={service_name="<one of your services>"}` returns the same label
  set as before.

Without the additive block, Loki still accepts ouo's logs, but `event_name`, `ouo_platform`
and `ouo_project_id` are only structured metadata. rum-api's selectors
(`{service_name=~".+", event_name=~".+"}`) then match no stream, so the session list, health
tiles and funnels stay empty. Session logs (`| session_id=`) still work.

### 2.2 Retention and per-project retention

Loki's `retention_period` is your retention for ouo's logs too (one pilot runs 336h). Give rum-api the
same value in `retention.logs` (`LOG_RETENTION`; Helm `retention.logs`; compose
`OUO_RETENTION_LOGS`). It sets how far back delete-by-user looks for the user's sessions.
- Shorter than Loki's retention: deletion misses older sessions.
- Longer: costs only a few more empty queries.

To give one ouo project a shorter or longer retention, add a `retention_stream` on its label in
your Loki's limits or runtime overrides. It matches only ouo's streams, because only they carry
`ouo_project_id`:

```yaml
retention_stream:
  - selector: '{ouo_project_id="web-store"}'
    priority: 1
    period: 168h
```

### 2.3 Only for delete by user / project

rum-api's `DELETE /v1/admin/users/<id>` and `/v1/admin/projects/<id>` (data-lifecycle.md,
section 3) submit a Loki delete request. Your Loki needs:

```yaml
compactor:
  retention_enabled: true            # deletes are applied by the retention pass
  delete_request_store: filesystem   # or your object store (s3, gcs, azure); Loki refuses to start without one
  # delete_request_cancel_period: 24h  (default; requests can be cancelled during it)
limits_config:
  deletion_mode: filter-and-delete   # hide the lines at query time, then rewrite the chunks
```

The delete endpoint must also be reachable at rum-api's Loki URL. The compactor serves
`POST /loki/api/v1/delete`: the `backend` target in simple-scalable mode, `compactor` in
microservices mode. The grafana/loki chart's gateway routes it. If your own gateway or ingress
forwards only queries, either:
- route `/loki/api/v1/delete` to the compactor as well, or
- point rum-api's `loki.delete_url` straight at the compactor (`LOKI_DELETE_URL`; Helm
  `lgtm.external.lokiDeleteUrl`; compose `OUO_EXTERNAL_LOKI_DELETE_URL`).

On a multi-tenant Loki, rum-api sends its tenant on deletes too.

`GET /loki/api/v1/delete` lists the requests and their status. A request stays `received`
during `delete_request_cancel_period`, then becomes `processed` at the next compaction. Queries
stop returning the lines a minute or two after that, once the queriers refresh their cached
list of delete requests.

The delete query is always scoped to ouo's lines:
`{service_name=~".+"} | ouo_project_id="<project>" | user_id="<user>"`, or `| ouo_project_id!=""`
when no project is given. Your own services' logs never match, even when they carry a `user_id`.

Without compactor deletion, Loki answers `Retention is not enabled` or 404. In that case set
`loki.delete_api: false` in rum-api (`LOKI_DELETE_API=false`; Helm
`rumApi.structuredConfig.loki.delete_api: false`; compose `OUO_LOKI_DELETE_API=false`).
- Off: a deletion removes the replays, lists the trace ids, and records `loki: skipped` in the
  audit entry. The user's log lines stay until your retention removes them.
- Left on: the deletion still removes the replays, but answers 502 with `loki: failed` and the
  Loki error in the audit entry.

## 3. Tempo

| Setting | Why |
|---|---|
| OTLP gRPC receiver on the distributor (`distributor.receivers.otlp.protocols.grpc`) | the ouo collector exports traces over OTLP gRPC (`tempoOtlpGrpcEndpoint` / `OUO_EXTERNAL_OTLP_TRACES`); your collector's OTLP gRPC port works the same |
| `stream_over_http_enabled: true` | Grafana 11+ streams search and trace results over the HTTP port |
| TraceQL search on span attributes (default) | rum-api finds a session's traces with `{ span.session.id = "..." }` |

Retention is your `block_retention` (Tempo 3.0: under `backend_scheduler.provider.compaction.compaction`
and `backend_worker.compaction`). Tempo has no delete API. Delete-by-user lists the user's trace
ids in the audit entry; either age them out with the retention, or redact them with
`tempo-cli redact --tenant=<tenant> --trace-id=<id>...` against your backend scheduler
(without auth the tenant is `single-tenant`; data-lifecycle.md, section 3).

## 4. Mimir

Mimir receives, over OTLP/HTTP at `<mimir>/otlp`:
- the collector's self-metrics (`otelcol_*`, `ouo_ratelimit_rejected_total`, `ouo_replay_chunks_total`)
- rum-api's metrics
- your SDKs' metrics

Beyond OTLP ingestion (on by default), Mimir needs nothing for ouo. The plugin and rum-api do
not query Mimir. Grafana's `mimir` datasource does (Tempo's service map, the collector dashboards).

## 5. Your own OTel collectors in front

Point the three writes at your collector, and keep the read URLs on Loki, Tempo and Mimir:

| Signal | Helm | Compose |
|---|---|---|
| traces, OTLP gRPC `host:port` | `lgtm.external.tempoOtlpGrpcEndpoint` | `OUO_EXTERNAL_OTLP_TRACES` |
| logs, OTLP/HTTP base (`/v1/logs` is appended) | `lgtm.external.lokiOtlpUrl` | `OUO_EXTERNAL_OTLP_LOGS` |
| metrics, OTLP/HTTP base (`/v1/metrics` is appended) | `lgtm.external.mimirOtlpUrl` | `OUO_EXTERNAL_OTLP_METRICS` |

Your collector needs an `otlp` receiver (gRPC and HTTP) and three pipelines:
- logs to Loki's OTLP endpoint (`otlp_http` to `http://<loki>/otlp`)
- traces to Tempo
- metrics to Mimir

These must pass through that hop unchanged:

- **Resource attributes**: `ouo.project.id` (the collector stamped it from the credential; do not
  overwrite or drop it), `ouo.platform`, `service.name`, `service.version`,
  `deployment.environment.name`.
- **Log records**: the `event.name` attribute (and the OTLP `EventName` field), `session.id`,
  `user.id`, `ouo.platform`, every `ouo.*` attribute, the body, the trace and span ids.
- **Spans**: `session.id`, and the parent link between the browser or app span and your backend's
  span. rum-api counts a session's traces through that link.

Processors to check:
- `attributes`, `resource` or `transform` rules that delete unknown attributes or rewrite
  `service.*` or `deployment.environment.*`.
- A `filter` that drops logs without a known severity.
- `tail_sampling` or `probabilistic_sampler` on traces: rum-api's trace counts and links then
  cover only the sampled traces.
- `k8sattributes`: it tags ouo's data with the ouo collector pod's `k8s.*` attributes, and Loki's
  defaults turn those into labels on ouo's streams. That is harmless (a handful of values), but
  ouo's streams then split per collector pod.

Batch and memory-limiter processors are fine.

Tenants: by default your collector does not forward the ouo collector's `X-Scope-OrgID`. It
needs `include_metadata: true` on the receiver plus the `headers_setter` extension. In front of
a multi-tenant stack, it is usually your collector's own exporters that set the tenant.

Compose without `OUO_LGTM_TENANT_ID` sends that header with an **empty** value. A collector
whose `headers_setter` copies it `from_context` can pass the empty value on, and a multi-tenant
backend then refuses the data (no org id). Set `OUO_LGTM_TENANT_ID` in that setup, or have
your collector set the tenant itself.

## 6. Tenant, headers and authentication

| | collector | rum-api | Grafana |
|---|---|---|---|
| `X-Scope-OrgID` | Helm `lgtm.external.tenantId`; compose `OUO_LGTM_TENANT_ID` | same values; `loki.tenant_id` / `tempo.tenant_id` (`LOKI_TENANT_ID`, `TEMPO_TENANT_ID`) | same values (datasource custom header) |
| other headers, basic auth | Helm `collector.configOverride` | `loki.headers`, `loki.basic_auth.{username,password}` (`LOKI_BASIC_AUTH_*`), same for `tempo` (`services/rum-api/README.md`) | your datasources |

A single-tenant stack needs none of this: `auth_enabled: false` on Loki, multitenancy off on
Tempo and Mimir.

rum-api's `tenant_id`, `headers`, `basic_auth` and `delete_url` keys need a rum-api release newer
than 0.6.0 (`docs/compatibility.md`). rum-api 0.6.0 rejects unknown config keys and would not
start. The chart refuses to render `lgtm.external.tenantId` or `lokiDeleteUrl` while
`rumApi.image.tag` is a release <= 0.6.0.

Keep the basic-auth password and any credential header out of committed files.

**Helm.** The rum-api ConfigMap is not a Secret, so never put a password in
`rumApi.structuredConfig`. Put it in a Secret of your own and pass it with `rumApi.extraEnv`:

```yaml
rumApi:
  extraEnv:
    - name: LOKI_BASIC_AUTH_USERNAME
      value: ouo
    - name: LOKI_BASIC_AUTH_PASSWORD
      valueFrom:
        secretKeyRef: { name: ouo-lgtm-auth, key: loki-password }
    # TEMPO_BASIC_AUTH_USERNAME / TEMPO_BASIC_AUTH_PASSWORD likewise
```

A credential header (an API key): give rum-api the secret as an environment variable the same
way, for example `LOKI_API_KEY` from `secretKeyRef`. Then reference it from the config:
`rumApi.structuredConfig.loki.headers: {X-Api-Key: "${LOKI_API_KEY}"}`. rum-api runs with
`-config.expand-env=true`, so the ConfigMap holds only the reference.

**Compose.** `compose.external.yaml` passes `OUO_EXTERNAL_LOKI_BASIC_AUTH_USERNAME`,
`_PASSWORD` and the `TEMPO` pair from `deploy/compose/.env` to rum-api. Empty means no basic
auth. A credential header needs two changes:
- a `headers` entry with a `${VAR}` reference in `deploy/compose/rum-api/config.yaml`;
- an override file of your own that passes `VAR` to the `rum-api` service.

**Collector.** Basic auth or extra headers on the collector's exporters: Helm
`collector.configOverride`; compose, the exporters in `deploy/compose/external/collector.yaml`.

## 7. Compose and VM

```bash
# deploy/compose/.env (see .env.example, section "Existing LGTM")
OUO_EXTERNAL_LOKI_URL=http://loki.example.internal:3100
OUO_EXTERNAL_TEMPO_URL=http://tempo.example.internal:3200
OUO_EXTERNAL_MIMIR_URL=http://mimir.example.internal:9009/prometheus
OUO_EXTERNAL_OTLP_TRACES=otelcol.example.internal:4317
OUO_EXTERNAL_OTLP_LOGS=http://otelcol.example.internal:4318
OUO_EXTERNAL_OTLP_METRICS=http://otelcol.example.internal:4318
OUO_RETENTION_LOGS=336h
OUO_RETENTION_REPLAYS=336h
```

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml \
  -f deploy/compose/compose.external.yaml up -d
```

What `compose.external.yaml` does:
- Moves the bundled `loki`, `tempo` and `mimir` services to the profile `bundled-lgtm`, so they
  do not start.
- Starts the collector with a second config file, `deploy/compose/external/collector.yaml`,
  merged over `collector/config.yaml`. Only the three exporters and the self-metrics push change.
- Points rum-api at your Loki and Tempo.
- Mounts `deploy/compose/external/datasources.yaml` into Grafana, with the same uids `loki`,
  `tempo` and `mimir`.

Put it after `compose.images.yaml`: that file's `volumes: !override` on Grafana would otherwise
drop the datasources mount.

`deploy/scripts/wait-ready.sh` and `e2e.sh` probe the backends from the host. Set
`OUO_LOKI_URL`, `OUO_TEMPO_URL` and `OUO_MIMIR_URL` in the same `.env`.

On a VM install (`deploy/vm`), add the file to the `docker compose` line of `ouo.service`.

## 8. Your own Grafana

1. Leave out ouo's Grafana: `grafana.enabled=false` (Helm), or drop the `grafana` service (compose).
2. Install the plugin from `plugins/ouo11y-rum-app/dist`, or use the `ghcr.io/ouo11y/grafana` image.
3. Provision the app with `jsonData.rumApiUrl` and `secureJsonData.readToken` (`deploy/helm/ouo/README.md`).
4. Give rum-api your datasource uids and Grafana URL for its deep links: `GRAFANA_LOKI_DATASOURCE_UID`,
   `GRAFANA_TEMPO_DATASOURCE_UID`, `GRAFANA_URL` (Helm `rumApi.config.lokiDatasourceUid`,
   `tempoDatasourceUid`, `grafanaUrl`).
5. Add a derived field `trace_id` to your Tempo datasource on your Loki datasource, for the
   log-to-trace links (example: `deploy/compose/grafana/provisioning/datasources/datasources.yaml`).

## 9. Verification (2026-11-04)

`tests/e2e/existing-lgtm/` holds the client-shaped stack (`compose.yaml`, `loki.client.yaml`,
`loki.client-plus-ouo.yaml`, `otelcol.yaml`, `client-logs.mjs`) and `run.sh`, which runs every
step below. Setup: separate compose projects, ouo built from this tree, `compose.external.yaml`
on top of `compose.images.yaml`.

1. **Client Loki with only its defaults.** The client's own service logs go through the client
   collector and land in one stream `{deployment_environment_name, k8s_cluster_name,
   k8s_namespace_name, k8s_pod_name, service_instance_id, service_name, service_namespace}`.
2. **Loki restarted with `loki.client-plus-ouo.yaml`** (the section 2.1 block; nothing else
   differs). `GET /config` lists Loki's 18 default resource attributes, then `ouo.platform` and
   `ouo.project.id`.
3. **ouo pointed at it.** Traces, logs and metrics go through the client collector (OTLP gRPC /
   HTTP); reads go to Loki, Tempo and Mimir. Result:
   - `deploy/scripts/e2e.sh`: `E2E OK: 40 sessions` (health per version, session details, trace
     counts, Grafana trace lookups, replay through the collector, project stamping).
   - Grafana datasource health is 200 for all three datasources.
   - Mimir has `job="ouo-collector"` and `job="rum-api"` series.
4. **The client's logs sent again.** They land in the same single series, with the same label set
   as in step 1. ouo's streams carry `{deployment_environment_name, event_name, ouo_platform,
   ouo_project_id, service_name}`.
5. **Delete by user** (`qa-user-w-0`, project `demo`):
   - 6 sessions found, 1 replay deleted.
   - Loki request over `now - 336h` (rum-api `retention.logs`), `processed` about 165 s later
     (the fixture's cancel period is 1m), hidden from queries about 45 s after that.
   - That user's lines went from 16 to 0. Another user's 16 lines and the client's 6 lines were kept.
6. **Multi-tenant variant** (Loki `auth_enabled: true`, `OUO_LGTM_TENANT_ID=pilot`, logs straight
   to Loki's OTLP):
   - Loki answers 401 without a tenant.
   - `E2E OK` again. All 106 log records of the run are in tenant `pilot`, none in `fake`.
   - A delete by user lands in tenant `pilot` and is processed there: that user's lines go
     from 12 to 0, and another user's are kept.

Step 6 also found a bug, now fixed: a deletion answered 502 `deletes in the future are not
allowed` whenever rum-api's session lookup took less than a second, because the request's end
was `now + 1 s`. rum-api now clamps the end to the current second.
