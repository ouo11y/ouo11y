# ouo Helm chart

Installs ouo on Kubernetes: **rum-api** (ingest gateway with project tokens, session API,
replay store), an **OpenTelemetry Collector** (ClusterIP only), **Grafana** with the ouo RUM
app plugin baked into the image, and either a **bundled** single-binary Loki, Tempo and Mimir
or the customer's **external** LGTM stack. Design: ADR-0007 (`docs/adr/0007-ingest-gateway-project-tokens.md`).

```
browser / mobile SDK --POST /ingest/otlp/v1/*, /v1/replay/chunks + X-Ouo-Project-Token--> rum-api (Ingress)
rum-api --OTLP protobuf--> <release>-collector:4318 --> Loki / Tempo / Mimir (bundled or external)
Grafana (Ingress) --plugin route proxy + Bearer read token--> rum-api --> Loki, Tempo, replay PVC
```

Verified on kind (Phase 8a): `agents/helm/summaries/2026-10-10-phase-8a.md`, `kb/helm-kind.md`.

## Images

| Component | Image | Built from |
|---|---|---|
| rum-api | `ouo/rum-api` | `services/rum-api/Dockerfile` (`docker build -t ouo/rum-api:<tag> services/rum-api`) |
| Grafana + plugin | `ouo/grafana` | `deploy/images/grafana/Dockerfile`, after `npm run -w plugins/ouo-rum-app build`: `docker build -t ouo/grafana:<tag> -f deploy/images/grafana/Dockerfile .` |
| Collector | `otel/opentelemetry-collector-contrib:0.160.0` | upstream |
| Loki / Tempo / Mimir (bundled) | `grafana/loki:3.7.7`, `grafana/tempo:3.0.3`, `grafana/mimir:3.2.1` | upstream |

Every tag is a value: `--set rumApi.image.tag=0.2.0 --set grafana.image.tag=0.2.0 --set collector.image.tag=... --set lgtm.bundled.loki.image.tag=...`.
Use `rumApi.image.repository` / `grafana.image.repository` for a registry (for example
`ghcr.io/ziadmansourm/ouo/rum-api`) and `imagePullSecrets` for a private one.

## Install A: existing cluster, the customer's LGTM stack (`lgtm.mode=external`)

Nothing LGTM is deployed. rum-api, the collector and Grafana point at the URLs you give.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  -f deploy/helm/ouo/values-external-lgtm.yaml \
  --set lgtm.external.lokiUrl=http://loki-gateway.observability.svc:80 \
  --set lgtm.external.tempoUrl=http://tempo-query-frontend.observability.svc:3200 \
  --set lgtm.external.tempoOtlpGrpcEndpoint=tempo-distributor.observability.svc:4317 \
  --set lgtm.external.mimirUrl=http://mimir-nginx.observability.svc:80 \
  --set project.id=web-store \
  --set project.token=pt_$(openssl rand -hex 16) \
  --set 'project.allowedOrigins=https://shop.example.com\,https://*.preview.example.com' \
  --set readToken=rt_$(openssl rand -hex 16) \
  --set grafana.adminPassword="$(openssl rand -base64 18)" \
  --set rumApi.ingress.host=rum.example.com --set grafana.ingress.host=grafana.example.com
```

Requirements on the external stack: Loki with `allow_structured_metadata: true` and the ouo
OTLP label promotion (`kb/collector-lgtm.md`), Tempo with `stream_over_http_enabled: true`
and an OTLP gRPC receiver, Mimir with OTLP ingestion. Multi-tenant stacks: set
`lgtm.external.tenantId`; the collector and the Grafana datasources then send
`X-Scope-OrgID`. Separate read and write paths: `lgtm.external.lokiOtlpUrl`,
`mimirOtlpUrl`, `mimirPrometheusUrl`.

Already running Grafana? `--set grafana.enabled=false`, install the plugin from
`plugins/ouo-rum-app/dist` (unsigned: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app`)
and provision the app with `jsonData.rumApiUrl=http://ouo-rum-api.ouo.svc:8080` and
`secureJsonData.readToken=<readToken>` (see `templates/grafana/configmap-plugins.yaml`).

## Install B: bundled LGTM (`lgtm.mode=bundled`, the default)

Single-binary Loki, Tempo and Mimir as StatefulSets with the configs from
`deploy/docker/{loki,tempo,mimir}/config.yaml` on PersistentVolumeClaims. For kind,
development and small installs; not replicated.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  --set project.token=pt_$(openssl rand -hex 16) \
  --set readToken=rt_$(openssl rand -hex 16) \
  --set grafana.adminPassword="$(openssl rand -base64 18)"
```

On kind with locally built images: `values-kind.yaml` (commands at the top of the file; the
development tokens in it are public and only acceptable on a laptop).

The chart refuses to render without `project.token`, `projects` or `rumApi.existingSecret`
(ADR-0007: there is no auth-off mode) and without a Grafana admin password.

## After install

`helm install` prints the port-forward commands, the token reminder and the plugin URL
(`templates/NOTES.txt`). Without an Ingress:

```bash
kubectl -n ouo port-forward svc/ouo-rum-api 8080:8080 &
kubectl -n ouo port-forward svc/ouo-grafana 3000:3000 &
curl -s localhost:8080/readyz                              # {"ready":true,...}
curl -s -u admin:<password> localhost:3000/api/plugins/ouo-rum-app/settings
open http://localhost:3000/a/ouo-rum-app/overview
```

SDK configuration: `initRUM({ endpoint: "https://rum.example.com", projectToken: "pt_...", ... })`.
Any stock OpenTelemetry SDK works too with `OTEL_EXPORTER_OTLP_ENDPOINT=https://rum.example.com/ingest/otlp`
and `OTEL_EXPORTER_OTLP_HEADERS=X-Ouo-Project-Token=pt_...`.

Several projects or token rotation: set `projects` (list of ADR-0007 project objects); it is
rendered to a ConfigMap and mounted as `OUO_PROJECTS_FILE`. Project tokens are public
identifiers (they ship in browser bundles), the **read token is secret** and lives in the
rum-api Secret, from which Grafana reads it as an environment variable that the provisioner
expands into `secureJsonData.readToken`.

Bring your own Secrets: `rumApi.existingSecret` (keys `project-token`, `read-token`) and
`grafana.existingSecret` (keys `admin-user`, `admin-password`).

## TLS and Ingress

`rumApi.ingress` and `grafana.ingress` render `networking.k8s.io/v1` Ingresses with a host,
optional `className`, TLS secret and free-form annotations (cert-manager example in
`values-external-lgtm.yaml`). Behind an Ingress set `rumApi.config.trustProxy=true` so the
per-IP rate limit sees the client address, and raise the controller's body limit to at least
16 MiB for replay chunks. The collector has no Ingress by design.

## Upgrade

```bash
helm upgrade ouo deploy/helm/ouo -n ouo --reuse-values --set rumApi.image.tag=0.3.0 --set grafana.image.tag=0.3.0
```

- Deployments carry checksums of their ConfigMaps and Secrets, so a config change rolls the pods.
- rum-api and Grafana use the `Recreate` strategy (ReadWriteOnce volumes): a few seconds of
  downtime per upgrade with one replica. Replay chunks are gzip files under `/data/replays`
  and are read by any rum-api version with the same schema (ADR-0003).
- The Grafana init container re-copies the plugin from the image onto the data volume on
  every start, so a new `grafana.image.tag` upgrades the plugin.
- Bundled LGTM StatefulSets roll one pod each. A StatefulSet whose pod is crash-looping does
  **not** roll to a new revision on its own; delete the pod (`kubectl delete pod ouo-mimir-0`)
  after the upgrade (`kb/helm-kind.md`).

## Uninstall and data retention

```bash
helm uninstall ouo -n ouo
kubectl -n ouo get pvc          # everything is still here
```

Data survives an uninstall on purpose:

| Data | Claim | Why it stays |
|---|---|---|
| replay chunks | `ouo-rum-api-replays` | `helm.sh/resource-policy: keep` |
| Grafana database (users, dashboards) | `ouo-grafana` | `helm.sh/resource-policy: keep` |
| Loki / Tempo / Mimir blocks | `data-ouo-loki-0`, `data-ouo-tempo-0`, `data-ouo-mimir-0` | StatefulSet volumeClaimTemplates are never deleted by Helm |

Reinstalling with the same release name reattaches all of them. To wipe:
`kubectl -n ouo delete pvc -l app.kubernetes.io/instance=ouo` (the LGTM claims carry the
labels through the StatefulSet template; check with `get pvc` first). Retention per signal
(TTLs) is Phase 8b.

## High availability

`values-ha-example.yaml` documents the path (example only, not verified): the LGTM backends
from the upstream `grafana/loki`, `grafana/tempo-distributed` and `grafana/mimir-distributed`
charts in replicated mode on object storage, this chart in `lgtm.mode=external` with two
rum-api replicas on a ReadWriteMany replay volume, two collectors, and Grafana on an external
database. rum-api's replay store is a filesystem until the object-storage store lands, which
is why replicas > 1 need RWX.

## Values reference

| Key | Default | Meaning |
|---|---|---|
| `project.id` / `project.token` / `project.allowedOrigins` | `default` / `""` / `""` | single-project fallback (`OUO_PROJECT_*`); token required unless `projects` or `rumApi.existingSecret` |
| `projects` | `[]` | project registry rendered to `OUO_PROJECTS_FILE` (overrides `project.*`) |
| `readToken` | `""` | `OUO_READ_TOKEN` for `GET`/`DELETE /v1/*`; also provisioned into the Grafana plugin |
| `rumApi.image.{repository,tag,pullPolicy}` | `ouo/rum-api`, `0.2.0` | rum-api image |
| `rumApi.replicas` | `1` | > 1 needs a ReadWriteMany replay volume |
| `rumApi.existingSecret` | `""` | Secret with `project-token` and `read-token` |
| `rumApi.config.grafanaUrl` | derived | browser-facing Grafana URL in trace deep links (`GRAFANA_URL`) |
| `rumApi.config.{sessionInactivity,sessionMaxDuration}` | `30m`, `4h` | session end inference |
| `rumApi.config.maxIngestBytes` | `4194304` | `OUO_MAX_INGEST_BYTES` |
| `rumApi.config.rateLimit.{requestsPerSecond,burst}` | `1000`, `5000` | per-project token bucket |
| `rumApi.config.ipRateLimit.{requestsPerSecond,burst}` | `100`, `300` | per-client-IP token bucket |
| `rumApi.config.trustProxy` | `false` | read the client IP from `X-Forwarded-For` |
| `rumApi.config.corsAllowedOrigins` | `""` | extra exact origins (`CORS_ALLOWED_ORIGINS`) |
| `rumApi.otel.{enabled,environment}` | `true`, `production` | rum-api's own telemetry through the collector |
| `rumApi.extraEnv` | `[]` | extra `EnvVar`s (for example `MAX_FRAME_CHUNK_BYTES`) |
| `rumApi.persistence.{enabled,size,storageClass,accessModes,existingClaim}` | `true`, `20Gi` | replay PVC |
| `rumApi.service.{type,port}` | `ClusterIP`, `8080` | |
| `rumApi.ingress.{enabled,className,annotations,host,path,pathType,tls.enabled,tls.secretName}` | disabled | SDK-facing Ingress |
| `rumApi.{resources,podSecurityContext,containerSecurityContext,nodeSelector,tolerations,affinity,priorityClassName,livenessProbe,readinessProbe,podAnnotations,podLabels}` | see values.yaml | scheduling and hardening |
| `collector.enabled` | `true` | set `false` only if another in-cluster collector is reachable at `OUO_COLLECTOR_OTLP_ENDPOINT` (via `rumApi.extraEnv`) |
| `collector.image.*`, `collector.replicas` | contrib `0.160.0`, `1` | |
| `collector.memoryLimiter.{limitMib,spikeLimitMib}`, `collector.batch.*` | `512`/`128`, `1s`/`512`/`1024` | processors |
| `collector.configOverride` | `""` | full collector config, replaces the generated one |
| `grafana.enabled` | `true` | `false` when the customer runs Grafana |
| `grafana.image.*` | `ouo/grafana`, `0.2.0` | image with the plugin |
| `grafana.adminUser` / `grafana.adminPassword` / `grafana.existingSecret` | `admin` / `""` / `""` | password required unless the Secret is given |
| `grafana.rootUrl` | derived from the Ingress | `GF_SERVER_ROOT_URL` |
| `grafana.defaultTheme`, `grafana.anonymousEnabled` | `dark`, `false` | |
| `grafana.env` (map) / `grafana.extraEnv` (list) | `{}` / `[]` | any `GF_*` setting (SSO, external database, SMTP) |
| `grafana.plugin.rumApiUrl` | in-cluster rum-api | what the plugin route proxy calls |
| `grafana.datasources.enabled` | `true` | provision Loki, Tempo, Mimir (uids `loki`, `tempo`, `mimir`) |
| `grafana.persistence.*`, `grafana.service.*`, `grafana.ingress.*`, `grafana.resources`, ... | `5Gi`, `3000`, disabled | as for rum-api |
| `lgtm.mode` | `bundled` | `bundled` or `external` |
| `lgtm.external.{lokiUrl,tempoUrl,tempoOtlpGrpcEndpoint,mimirUrl}` | upstream chart Service names | required in external mode |
| `lgtm.external.{lokiOtlpUrl,mimirOtlpUrl,mimirPrometheusUrl}` | derived (`<url>/otlp`, `<url>/prometheus`) | split read / write paths |
| `lgtm.external.tenantId` | `""` | `X-Scope-OrgID` on the collector exporters and the datasources |
| `lgtm.bundled.{loki,tempo,mimir}.image.*` | `3.7.7`, `3.0.3`, `3.2.1` | |
| `lgtm.bundled.<x>.configOverride` | `""` | full config, replaces the one mirrored from `deploy/docker` |
| `lgtm.bundled.<x>.persistence.{enabled,size,storageClass,accessModes}` | `true`, `20Gi` | StatefulSet volumeClaimTemplates |
| `lgtm.bundled.<x>.{resources,podSecurityContext,podAnnotations,nodeSelector,tolerations,affinity}` | uid 10001, small requests | |
| `nameOverride`, `fullnameOverride`, `imagePullSecrets`, `commonLabels` | | naming and registry access |

Lint and render without a cluster: `helm lint deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml`,
`helm template ouo deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml`.
