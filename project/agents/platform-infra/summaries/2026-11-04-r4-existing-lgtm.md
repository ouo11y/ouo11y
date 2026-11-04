# R4: ouo on an existing Loki / Tempo / Mimir (2026-11-04)

Client JUHI already runs its own Loki, Tempo and Mimir: 336h retention, a single tenant, and
its own OTel collectors in front. R4 makes "point ouo at it" a supported, documented and
verified path.

## Done

- **Operator guide** `docs/operations/existing-lgtm.md`, linked from `docs/index.md`,
  `docs/operations/index.md`, `deploy/README.md` and the Helm README. It covers:
  - Loki: required settings, with the label promotion written **additively**; the stream labels
    ouo uses; what happens without them; retention and per-project `retention_stream`;
    delete-by-user needs and what happens without them.
  - Tempo and Mimir needs.
  - The customer's collector in front, and the attributes that must survive that hop.
  - Tenant, headers and auth; compose and VM; the customer's own Grafana.
  - Verification.
- **rum-api** (`services/rum-api`):
  - `loki` and `tempo` take `tenant_id` (`LOKI_TENANT_ID` / `TEMPO_TENANT_ID`, sent as
    `X-Scope-OrgID`), `headers` (map) and `basic_auth` (`*_BASIC_AUTH_USERNAME` / `_PASSWORD`).
  - `loki.delete_url` (`LOKI_DELETE_URL`) is the compactor base when the gateway does not route
    `/loki/api/v1/delete`.
  - New package `internal/upstream`: a RoundTripper that sets the headers on a cloned request,
    one http.Client per backend.
  - Validation: header names, no line breaks, no `headers.Authorization` together with
    `basic_auth`, no password without a username, `delete_url` must be http(s).
  - `-config.verify` redacts passwords and every header value.
  - README table and `config.example.yaml` updated.
- **Two delete fixes found by the verification:**
  1. Loki delete `end` was `to.Unix()+1` with `to = now`. Loki answers 400 "deletes in the future
     are not allowed" whenever the session lookup finishes within the same second, so every
     deletion was flaky on a fast lookup. The end is now clamped to the current second.
  2. Delete-by-user without `?project=` sent `{service_name=~".+"} | user_id="u"`. In a shared
     Loki that also deletes the customer's own lines carrying `user_id`. The query is now
     `| ouo_project_id!=""`. `data-lifecycle.md` section 3 says so.
- **Helm:**
  - `lgtm.external.tenantId` now also reaches rum-api (`loki.tenant_id`, `tempo.tenant_id`).
  - New `lgtm.external.lokiDeleteUrl` → rum-api `loki.delete_url`.
  - `values-external-lgtm.yaml`:
    - The stale `0.3.0` image pins are gone; images follow the chart defaults.
    - Retention `logs` / `replays` set to 336h.
    - Commented values for a customer collector in front, and for `lokiDeleteUrl`.
- **Compose:** `deploy/compose/compose.external.yaml`:
  - Bundled `loki` / `tempo` / `mimir` move to profile `bundled-lgtm`; dependencies on them are
    `required: false`.
  - The collector gets a second `--config` (`deploy/compose/external/collector.yaml`: exporters
    and the self-metrics push only).
  - rum-api env points at the external Loki and Tempo.
  - Grafana datasources come from `deploy/compose/external/datasources.yaml` (same uids, env
    URLs, tenant header).
  - New "Existing LGTM" section in `.env.example`.
- **kb:**
  - `project/kb/collector-lgtm.md`: the label list now includes `ouo.project.id`, with a warning
    for shared Lokis.
  - New `project/kb/existing-lgtm.md`.
- **Test fixture** `tests/e2e/existing-lgtm/`: a client-shaped stack plus `run.sh [--multitenant] [--keep]`.

## Verified, and how

`go test ./...` and `go vet ./...` pass in `services/rum-api`.

Helm:
- `helm template` with `values-external-lgtm.yaml` plus `tenantId=juhi` and `lokiDeleteUrl`:
  rum-api's config has `tenant_id` and `delete_url`; images are collector 0.5.0, rum-api 0.6.0,
  grafana 0.6.0 (the chart defaults).
- Bundled mode renders no tenant.
- `helm lint` passes.

`tests/e2e/existing-lgtm/run.sh --multitenant` (the method), on Docker Desktop. Two compose
projects: `r4lgtm-client` on 20810-20814 and `r4lgtm-ouo` on 20820-20827. ouo's collector and
rum-api are built from the tree; Grafana 0.6.0 comes from `compose.images.yaml`, with
`compose.external.yaml` last. Steps:

1. The client's Loki starts with its defaults only. The client's own logs go through the client
   collector and form one stream: `deployment_environment_name, k8s_cluster_name,
   k8s_namespace_name, k8s_pod_name, service_instance_id, service_name, service_namespace`.
2. Loki is restarted with the additive block; the script diffs the two files outside the block.
   `/config` shows the 18 defaults, then `ouo.platform` and `ouo.project.id`.
3. `deploy/scripts/e2e.sh` reports `E2E OK: 40 sessions`. Traces, logs and metrics went through
   the client collector. All three Grafana datasources are healthy, and Mimir holds
   `job=ouo-collector` and `job=rum-api` series.
4. The client's logs, sent again, form the same single series with the same labels. ouo's
   streams carry `event_name`, `ouo_platform` and `ouo_project_id`.
5. Delete-by-user (`qa-user-w-0`, project `demo`): 6 sessions, 1 replay deleted, Loki request
   from `now - 336h`. It was `processed` after about 210 s. That user's lines went 16 → 0; another
   user's 16 lines and the client's 6 lines were kept.
6. Multi-tenant (`auth_enabled: true`, `OUO_LGTM_TENANT_ID=juhi`, logs direct to Loki's OTLP):
   - Loki answers 401 without a tenant.
   - E2E OK again: 106 records in `juhi`, 0 in `fake`.
   - Delete requests are listed and processed under `juhi`.

The first manual pass of steps 1-6 ran before `run.sh` existed. Its step 6 is where fix 1 showed
up: the delete answered 502 until the clamp went in. The final `run.sh --multitenant` result is
in the PR description. Both projects were torn down (`down -v`).

## Dependencies

None added. The fixture uses public images that were already in use (Loki, Tempo, Mimir, and
otelcol-contrib 0.160.0, the collector line ouo builds on).

## Left / for the next agent

- rum-api's new keys need the next rum-api release (more than 0.6.0). 0.6.0 rejects unknown
  config keys, so leave Helm `tenantId` / `lokiDeleteUrl` empty with that image (documented).
  `docs/compatibility.md` gets its row at release time.
- The collector's extra headers and basic auth to an authenticating gateway are only possible
  through `collector.configOverride` (Helm) or editing `external/collector.yaml`. rum-api has
  first-class keys for them.
- Not verified on Kubernetes against the upstream `grafana/loki` distributed chart's gateway
  routing of `/loki/api/v1/delete`. The doc says to check it, and `lokiDeleteUrl` is the way out.
- Per-project `retention_stream` in the customer's Loki is documented, not exercised in this run
  (it was verified on ouo's own Loki in 8b).
