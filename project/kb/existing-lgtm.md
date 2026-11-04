# ouo on an existing Loki / Tempo / Mimir (shared, single tenant)

Learned while making the "customer's own LGTM" path a supported one (R4, JUHI, 2026-11-04).
Operator guide: `docs/operations/existing-lgtm.md`. Reproduce: `tests/e2e/existing-lgtm/run.sh
[--multitenant]` (Loki 3.7.7, Tempo 3.0.3, Mimir 3.2.1, otelcol-contrib 0.160.0, ouo collector
0.5.0+ and rum-api from the tree).

## Loki

- `otlp_config.resource_attributes.attributes_config` with `ignore_defaults: false` (the default)
  is **appended** to Loki's default list: `GET /config` shows the 18 defaults
  (`service.name` ... `k8s.job.name`) as the first entry, then ours. That is how ouo adds
  `ouo.platform` / `ouo.project.id` without touching anyone else's labels. A customer's stream
  `{service_name, service_namespace, service_instance_id, deployment_environment_name, k8s_*}`
  kept exactly that label set (same single series) after the change.
- `ignore_defaults: true` (ouo's bundled config) would drop `service_instance_id`, `k8s_*`,
  `cloud_*` labels from every other sender's new streams: never in a shared Loki.
- `log_attributes` has no defaults; the `event.name` rule applies to every sender's logs.
- `GET /loki/api/v1/delete` lists the requests per tenant; with `auth_enabled: false` the tenant
  is `fake`. A request is `received` for `delete_request_cancel_period`, then `processed` on the
  next compaction run (1m / 1m: 210 s end to end).
- Loki rejects a delete whose `end` is after its own clock: 400 `deletes in the future are not
  allowed`. rum-api used to send `to.Unix()+1` with `to = now`, so a deletion failed whenever its
  session lookup finished within the same second (fast with few sessions). Fixed: end is clamped
  to the current second (`internal/loki/delete.go`).
- Delete-by-user without `?project=` used to send `{service_name=~".+"} | user_id="u"`, which in
  a shared Loki also matches the customer's own lines with a `user_id`. It is now
  `| ouo_project_id!=""` (only lines stamped by the ouo collector).
- `auth_enabled: true`: every API answers 401 `no org id` without `X-Scope-OrgID`, `/ready`
  does not need one (so rum-api's `/readyz` says nothing about the tenant).

## OTel Collector

- `--config` twice merges the files: maps merge key by key, lists are replaced (the
  `service.telemetry.metrics.readers` list must be repeated whole). `compose.external.yaml` uses
  this to swap only the exporters.
- An `${env:X}` that is empty in `headers: {X-Scope-OrgID: ${env:X}}` sends the header with an
  empty value; single-tenant Loki / Tempo / Mimir ignore it (verified: e2e green). Same for a
  Grafana datasource `httpHeaderValue1` that expands to empty.
- A customer collector in front does not forward the ouo collector's `X-Scope-OrgID` (needs
  `include_metadata` + `headers_setter`); with one in front, the tenant is the customer
  collector's business.
- The otlp_http exporter appends `/v1/logs` / `/v1/metrics` to its `endpoint`, so the same base
  works for Loki (`http://loki:3100/otlp`) and a collector (`http://otelcol:4318`).

## Compose

- `depends_on` on a service whose profile is inactive fails the project; `required: false` on
  those entries (merged by the override) drops them and keeps the others. `depends_on: !reset []`
  also removed compose.images.yaml's `grafana-plugin` dependency, so Grafana could start before
  the plugin was copied.
- compose.images.yaml sets `volumes: !override` on grafana: an override that adds a mount must
  come after it on the command line.
- A file bind mount inside a read-only directory bind mount works (Grafana datasources file over
  `./grafana/provisioning`).
