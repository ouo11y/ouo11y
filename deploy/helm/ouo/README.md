# ouo Helm chart

Installs ouo on Kubernetes: the **ouo collector** (the custom OpenTelemetry Collector
distribution from `collector/`, the only public ingest: project tokens as HTTP Basic
credentials, OTLP/HTTP on 4318, the replay stream on 4319, rate and size limits),
**rum-api** (session API, replay store; ClusterIP only), **Grafana** with the ouo11y RUM app
plugin baked into the image, and either a **bundled** single-binary Loki, Tempo and Mimir
or the customer's **external** LGTM stack. Design: ADR-0007
(`docs/adr/0007-ingest-gateway-project-tokens.md`).

```
browser / mobile SDK --POST /v1/{traces,logs,metrics} + Authorization: Basic id:token--> collector:4318 (Ingress)
browser / mobile SDK --POST /v1/replay/chunks        + Authorization: Basic id:token--> collector:4319 (Ingress, /v1/replay/*)
collector --OTLP--> Loki / Tempo / Mimir (bundled or external)          [ouo.project.id stamped from the credential]
collector --POST /v1/replay/chunks + X-Ouo-Project-Id + Bearer ingest token--> rum-api (ClusterIP) --> replay PVC or S3 bucket
Grafana (Ingress) --plugin route proxy + Bearer read token--> rum-api --> Loki, Tempo, replay store
in-cluster services --OTLP + Basic credential--> collector:4318 (HTTP) / collector-internal:4317 (gRPC)
```

Verified on kind (Phase 8a): `project/agents/helm/summaries/2026-10-10-phase-8a-rev2.md`, `project/kb/helm-kind.md`.
Verified on a one-node kind cluster on 2026-10-23 (checklist N12): S3 on in-cluster MinIO,
Ingress with ingress-nginx and cert-manager, the `x_forwarded_for` client key, two collector
replicas, every `existingSecret`, `lgtm.mode=external` against a separate LGTM release, and
`helm upgrade` from chart 0.1.0. The HA values are rendered, linted and dry-run against the
API server only. Evidence: `project/agents/platform-infra/reports/2026-10-23-8a-vm-upgrade-n12.html`.

## Images

| Component | Image | Built from |
|---|---|---|
| collector | `ghcr.io/ouo11y/collector` (released by `collector-v*` tags) | `collector/Dockerfile` (`docker build -t ouo/collector:<tag> collector`) |
| rum-api | `ghcr.io/ouo11y/rum-api` (released by `rum-api-v*` tags) | `services/rum-api/Dockerfile` (`docker build -t ouo/rum-api:<tag> services/rum-api`) |
| Grafana + plugin | `ghcr.io/ouo11y/grafana` (released by `grafana-v*` tags) | `deploy/images/grafana/Dockerfile`, after `npm run -w plugins/ouo11y-rum-app build`: `docker build -t ouo/grafana:<tag> -f deploy/images/grafana/Dockerfile .` |
| Loki / Tempo / Mimir (bundled) | `grafana/loki:3.7.7`, `grafana/tempo:3.0.3`, `grafana/mimir:3.2.1` | upstream |

Every tag is a value: `--set collector.image.tag=0.5.0 --set rumApi.image.tag=0.6.0 --set grafana.image.tag=0.6.0 --set lgtm.bundled.loki.image.tag=...`.
Use `<component>.image.repository` for a registry (`ghcr.io/ouo11y/collector`,
`.../rum-api`, `.../grafana`) and `imagePullSecrets` for a private one.

### Pull access

The three `ghcr.io/ouo11y/*` images are public: the pods pull them without a pull secret.
`imagePullSecrets` is for a private mirror of them: create a `docker-registry` Secret for that
registry in the release namespace, then add `--set 'imagePullSecrets[0].name=<secret>'` to the
`helm install` / `helm upgrade` commands below (or `imagePullSecrets: [{name: <secret>}]` in
your values file). The chart puts it on every pod it runs, bundled LGTM included.

No route from the cluster to ghcr.io: pull the released images (or build them from source,
table above), push them to a registry the cluster can reach (kind: `kind load docker-image`)
and set `<component>.image.repository` / `.tag`.

## Install A: existing cluster, the customer's LGTM stack (`lgtm.mode=external`)

Nothing LGTM is deployed. The collector, rum-api and Grafana point at the URLs you give.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  -f deploy/helm/ouo/values-external-lgtm.yaml \
  --set lgtm.external.lokiUrl=http://loki-gateway.observability.svc:80 \
  --set lgtm.external.tempoUrl=http://tempo-query-frontend.observability.svc:3200 \
  --set lgtm.external.tempoOtlpGrpcEndpoint=tempo-distributor.observability.svc:4317 \
  --set lgtm.external.mimirUrl=http://mimir-nginx.observability.svc:80 \
  --set projects[0].id=web-store --set projects[0].token=pt_$(openssl rand -hex 16) \
  --set 'collector.allowedOrigins={https://shop.example.com,https://*.preview.example.com}' \
  --set ingestToken=it_$(openssl rand -hex 16) \
  --set readToken=rt_$(openssl rand -hex 16) \
  --set grafana.adminPassword="$(openssl rand -base64 18)" \
  --set collector.ingress.host=otel.example.com --set grafana.ingress.host=grafana.example.com
```

Requirements on the external stack are in
[docs/operations/existing-lgtm.md](../../../docs/operations/existing-lgtm.md). In short:
- Loki: schema v13 / tsdb, `allow_structured_metadata: true`, and ouo's OTLP label promotion
  added to Loki's defaults (`ouo.platform`, `ouo.project.id`, log attributes `event.name`,
  `ouo.platform`). Never `ignore_defaults: true` in a shared Loki: it drops the other senders'
  labels.
- Delete by user: compactor deletion, with `/loki/api/v1/delete` routed to the compactor
  (or `lgtm.external.lokiDeleteUrl`).
- Tempo: `stream_over_http_enabled: true` and an OTLP gRPC receiver.
- Mimir: OTLP ingestion.

Multi-tenant stacks: set `lgtm.external.tenantId`. The collector, rum-api and the Grafana
datasources then send `X-Scope-OrgID`; rum-api needs a release newer than 0.6.0 for that.
Separate read and write paths: `lgtm.external.lokiOtlpUrl`, `mimirOtlpUrl`,
`mimirPrometheusUrl`. Your own OTel collector in front: point `tempoOtlpGrpcEndpoint`,
`lokiOtlpUrl` and `mimirOtlpUrl` at it. Set `retention.logs` and `retention.replays` to
your Loki's retention (`values-external-lgtm.yaml` has 336h).

Verified 2026-10-23 with `values-external-lgtm.yaml` and the four URLs pointed at a second
release of this chart that ran only the bundled Loki, Tempo and Mimir (`collector.enabled=false`,
`grafana.enabled=false`, `rumApi.replicas=0` with `rumApi.persistence.enabled=false`, or the
unbound replay PVC keeps `helm --wait` waiting) in another namespace: `smoke.sh` found the
trace, log and metric in that stack, and the three Grafana datasources answered health 200.

Already running Grafana? `--set grafana.enabled=false`, install the plugin from
`plugins/ouo11y-rum-app/dist` (unsigned: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app`)
and provision the app with `jsonData.rumApiUrl=http://ouo-rum-api.ouo.svc:8080` and
`secureJsonData.readToken=<readToken>` (see `templates/grafana/configmap-plugins.yaml`).

## Install B: bundled LGTM (`lgtm.mode=bundled`, the default)

Single-binary Loki, Tempo and Mimir as StatefulSets with the configs from
`deploy/compose/{loki,tempo,mimir}/config.yaml` on PersistentVolumeClaims. For kind,
development and small installs; not replicated.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  --set projects[0].id=web-store --set projects[0].token=pt_$(openssl rand -hex 16) \
  --set ingestToken=it_$(openssl rand -hex 16) \
  --set readToken=rt_$(openssl rand -hex 16) \
  --set grafana.adminPassword="$(openssl rand -base64 18)"
```

On kind with locally built images: `values-kind.yaml` (commands at the top of the file; the
development tokens in it are public and only acceptable on a laptop).

The chart refuses to render without at least one `projects` entry or
`collector.existingProjectsSecret` (ADR-0007: there is no auth-off mode) and without a
Grafana admin password.

## After install

`helm install` prints the port-forward commands, the project list, the token reminder, the
SDK snippet and the plugin URL (`templates/NOTES.txt`). Without an Ingress:

```bash
kubectl -n ouo port-forward svc/ouo-collector 4318:4318 &   # OTLP/HTTP
kubectl -n ouo port-forward svc/ouo-collector 4319:4319 &   # replay
kubectl -n ouo port-forward svc/ouo-grafana 3000:3000 &
CRED=$(printf 'web-store:pt_...' | base64)
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'                                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4318/v1/traces -H "Authorization: Basic $CRED" -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'  # 200
curl -s -u admin:<password> localhost:3000/api/plugins/ouo11y-rum-app/settings
open http://localhost:3000/a/ouo11y-rum-app/overview
```

SDK configuration (SDKs 0.2.0):

```ts
initRUM({
  endpoint: "https://otel.example.com",        // collector OTLP/HTTP base
  // replayEndpoint defaults to endpoint (port 4319 when endpoint uses 4318)
  projectId: "web-store",
  projectToken: "pt_...",
  service: { name: "web-store", version: "1.4.2", environment: "production" },
});
```

Any stock OpenTelemetry SDK works too: `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com`
and `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$(printf 'web-store:pt_...' | base64)"`.

### Projects: add one, rotate a token

Projects live in `projects` (list of `{id, token}`). The chart renders them into the Secret
`<release>-collector-projects` as an htpasswd file, one `{SHA}` line per entry (the hash is
computed in the template: `templates/_helpers.tpl`, `ouo.htpasswdSha`; it equals
`htpasswd -nbs <id> <token>`). The collector's `basicauth` extension reads it at
`/etc/otelcol/projects.htpasswd`; the collector Deployment carries a checksum of the Secret,
so every change rolls the pods.

```bash
# add a project
helm upgrade ouo deploy/helm/ouo -n ouo --reuse-values \
  --set projects[1].id=mobile-app --set projects[1].token=pt_$(openssl rand -hex 16)

# rotate a token: replace it in place (edit your values file, then)
helm upgrade ouo deploy/helm/ouo -n ouo -f my-values.yaml
```

**Rotation has no overlap window with the upstream `basicauth` extension.** ADR-0007 section 2
plans two htpasswd lines for the same project during the overlap, but `basicauth` (0.160)
keeps only the last line per username: on kind, with two `demo` entries, the old token got
401 and the new one 200. The chart therefore refuses a duplicate `id`. A rotation is a cut-over:
clients still on the old token get 401 until they ship the new one, which matters for mobile
apps in the field. An overlap needs an authenticator that accepts several tokens per project
(the ouo authenticator extension the ADR lists under consequences).

A values file is easier than `--set` for lists. Bring your own htpasswd instead with
`collector.existingProjectsSecret` (key `projects.htpasswd`; `{SHA}` or apr1 lines, never
bcrypt: the hash runs on every request and the token is a public identifier). Project tokens
are public, the **ingest token** (collector to rum-api) and the **read token** (Grafana to
rum-api) are secret and live in the rum-api Secret (`rumApi.existingSecret` with keys
`ingest-token`, `read-token` and optionally `otlp-headers` to bring your own); Grafana reads `read-token` as an environment
variable that the provisioner expands into `secureJsonData.readToken`.

Nothing secret in a values file (verified 2026-10-23): four pre-created Secrets replace every
inline credential.

```bash
kubectl -n ouo create secret generic ouo-projects --from-literal=projects.htpasswd="web-store:{SHA}$(printf '%s' "$PT" | openssl dgst -binary -sha1 | openssl base64)"
kubectl -n ouo create secret generic ouo-rum-api-tokens --from-literal=ingest-token=it_$(openssl rand -hex 16) --from-literal=read-token=rt_$(openssl rand -hex 16) \
  --from-literal=otlp-headers="Authorization=Basic%20$(printf 'web-store:%s' "$PT" | base64)"
kubectl -n ouo create secret generic ouo-grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -base64 18)"
kubectl -n ouo create secret generic ouo-rum-api-s3 --from-literal=access-key-id=... --from-literal=secret-access-key=...   # s3 store only
```

then `collector.existingProjectsSecret=ouo-projects`, `rumApi.existingSecret=ouo-rum-api-tokens`,
`grafana.existingSecret=ouo-grafana-admin`, `rumApi.storage.s3.existingSecret=ouo-rum-api-s3`.
`otlp-headers` matters: with `existingProjectsSecret` the chart cannot compute rum-api's own
OTLP credential, and without the key rum-api's telemetry is refused with 401.

Browser SDKs also need their origins in `collector.allowedOrigins` (`OUO_ALLOWED_ORIGINS`,
CORS on both public receivers, the union of all projects; wildcards like
`https://*.preview.example.com` work; empty keeps the reference default
`http://localhost:*,http://127.0.0.1:*`). Mobile and server clients send no `Origin` and are
unaffected. Hand-written `curl` preflights must list `Access-Control-Request-Headers`
lowercase and sorted (`authorization,content-type`), as browsers do, or the collector answers
without `Access-Control-Allow-Origin` (`project/kb/collector-components.md`).

Project ids must match `^[a-z0-9][a-z0-9._-]{0,63}$` (the chart refuses others). basicauth
reads the htpasswd once at start; the checksum annotation makes `helm upgrade` roll the
collector so a new project or token takes effect.

### Source maps and dSYMs: upload tokens

rum-api symbolicates web stacks from uploaded source maps (`docs/sourcemaps.md`) and native iOS
crashes from uploaded dSYMs (`docs/symbolication.md`). Uploads (`PUT /v1/sourcemaps`,
`PUT /v1/dsyms`, sent by `ouo-sourcemaps upload` / `upload-dsym`) authenticate with a
per-project **upload token**. Unlike the project token it is a secret, at least 16 characters.
rum-api reads the tokens from `OUO_UPLOAD_TOKENS` (`<project>:<token>,...`). The chart has no
value of its own for it; pass it through `rumApi.extraEnv` from a Secret:

```bash
kubectl -n ouo create secret generic ouo-upload-tokens \
  --from-literal=upload-tokens="web-store:ut_$(openssl rand -hex 16),mobile-app:ut_$(openssl rand -hex 16)"
```

```yaml
rumApi:
  extraEnv:
    - name: OUO_UPLOAD_TOKENS
      valueFrom:
        secretKeyRef:
          name: ouo-upload-tokens
          key: upload-tokens
```

`helm upgrade` rolls rum-api when `extraEnv` changes; after rotating a token in the Secret
alone, run `kubectl -n ouo rollout restart deploy/ouo-rum-api`. Without `OUO_UPLOAD_TOKENS` the
upload endpoints refuse every request and stacks stay raw.

**Network: uploads reach rum-api only from inside the cluster.** rum-api is a ClusterIP Service
with no Ingress (ADR-0007), so `PUT /v1/sourcemaps` and `PUT /v1/dsyms` are not public. A CI job
uploads either through a port-forward from a machine with cluster access

```bash
kubectl -n ouo port-forward svc/ouo-rum-api 8080:8080 & pf=$!
sleep 2   # let the forward listen before the first request
npx ouo-sourcemaps inject dist
npx ouo-sourcemaps upload dist --url http://localhost:8080 --token "$OUO_UPLOAD_TOKEN" \
  --project web-store --release "$APP_VERSION" --delete-after
kill "$pf"
```

(the whole build step, `inject` included, is in `docs/sourcemaps.md`; dSYMs use
`ouo-sourcemaps upload-dsym`, `docs/symbolication.md`)

or from inside the cluster (a Job or an in-cluster CI runner, `--url
http://ouo-rum-api.ouo.svc:8080`). A public upload path through the collector, for CI on hosted
runners, is checklist N41.

### Expose the collector

The collector is the only service SDKs reach. Three ways:

1. **Ingress** (`collector.ingress`): one host, `/v1/replay` (Prefix) to port 4319 and `/`
   to port 4318, optional `className`, TLS Secret and free-form annotations. cert-manager:
   `cert-manager.io/cluster-issuer: letsencrypt` plus `tls.enabled=true` and the Secret name
   the issuer should fill. Without public DNS (a lab, kind): a `selfSigned` ClusterIssuer
   alone issues a leaf certificate with an empty subject that clients cannot verify against
   anything; bootstrap a CA with it instead (a `Certificate` with `isCA: true` from the
   self-signed issuer, then a `ca` ClusterIssuer on that Secret) and trust that one root.
   Verified so with ingress-nginx 4.15.1 and cert-manager v1.21.2: both certificates Ready,
   `curl --cacert root.crt` verifies, OTLP 401 / 200, replay 202, CORS preflight 204 from the
   allowed origin, Grafana and the plugin proxy through the Grafana Ingress. Raise the controller's body limit to at least 16 MiB for replay
   chunks (`nginx.ingress.kubernetes.io/proxy-body-size: 16m`). The SDK `endpoint` is then
   `https://otel.example.com` and `replayEndpoint` can stay unset (same host, path routed).
2. **LoadBalancer** (`collector.service.type=LoadBalancer`): the Service exposes 4318 and
   4319 on the address the cloud hands out; set `replayEndpoint: "http://<addr>:4319"` or
   rely on the SDK default (endpoint on 4318 implies replay on 4319). No TLS unless the
   load balancer terminates it.
3. **Port-forward** for a laptop or CI (`values-kind.yaml`).

The gRPC receiver (4317, Basic auth like the public ports), the health port (13133) and the
self-metrics port (8888) are only in the ClusterIP Service `<release>-collector-internal`
and never behind the Ingress. Every OTLP client needs a project credential, in-cluster ones
included: rum-api's own telemetry goes to `<release>-collector:4318` with the credential of
`rumApi.otel.project` (default: the first project), rendered into the rum-api Secret key
`otlp-headers` (`OTEL_EXPORTER_OTLP_HEADERS`).

Behind the Ingress the collector sees the controller as the TCP peer, so the per-client
rate-limit bucket keys on the first `X-Forwarded-For` hop (`OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for`,
automatic when `collector.ingress.enabled=true`; override with
`collector.rateLimit.client.keyFrom`). Make sure the controller overwrites that header
rather than appending a client-supplied one. ingress-nginx does by default
(`use-forwarded-headers: false`); measured 2026-10-23 with a client limit of 1/s burst 5 and
40 requests per run: one client through the Ingress 12 accepted, the same client sending 40
different `X-Forwarded-For` values 14 (the spoof is replaced), while straight to a collector
pod 40 different values all pass (each is its own bucket), so never use `x_forwarded_for`
without such a proxy in front.

**Buckets are per collector pod.** With `collector.replicas: N` the effective limits per
project and per client are N times the configured ones, as each pod refills its own buckets
(same run: one pod 7 accepted, two pods behind the Service 12). Size
`collector.rateLimit.*` for one pod's share, or accept the N-fold limit. Rejections are
`ouo_ratelimit_rejected_total{key_kind}` on each pod's `:8888/metrics`. A test burst must
carry data: empty OTLP requests (`{"resourceSpans":[]}`) bypass the processor (checklist N13). rum-api has no Ingress and no Service type option at all:
`<release>-rum-api` is always ClusterIP.

## Upgrade

```bash
helm upgrade ouo deploy/helm/ouo -n ouo -f my-values.yaml --rollback-on-failure --timeout 10m   # Helm 3: --atomic
```

Upgrade with your values file rather than `--reuse-values`, which keeps the previous
release's values and so the previous chart's image tags. Rehearsed 2026-10-23 from chart
0.1.0 (images `ghcr.io/ziadmansourm/ouo/*:0.2.0`) to 0.1.1 (`ghcr.io/ouo11y/*:0.3.0`) on kind
with replays and sessions in place: every replay read back byte-identical, sessions and health
unchanged, the plugin moved from `ouo-rum-app` to `ouo11y-rum-app` 0.7.0 through the init
container (`docs/operations/upgrade.md` section 8).

- Deployments carry checksums of their ConfigMaps and Secrets, so a config, project or token
  change rolls the pods.
- rum-api on the filesystem store and Grafana use the `Recreate` strategy (ReadWriteOnce
  volumes): a few seconds of downtime per upgrade with one replica. rum-api on the s3 store
  rolls with a RollingUpdate (no volume). Replay chunks are gzip files under
  `/data/replays` (or `[<prefix>/]replays/` in the bucket) and are read by any rum-api
  version with the same schema (ADR-0003).
- rum-api is started with `-config.file=/etc/rum-api/config.yaml -config.expand-env=true`
  from the `<release>-rum-api-config` ConfigMap, so the chart needs a rum-api image that
  knows those flags: 0.2.0, the first rum-api release (docs/releasing.md), or later. A build
  from before the config file exits with "flag provided but not defined". The collector rolls
  with a RollingUpdate; its replay exporter retries chunks while rum-api restarts.
- The Grafana init container re-copies the plugin from the image onto the data volume on
  every start, so a new `grafana.image.tag` upgrades the plugin.
- Bundled LGTM StatefulSets roll one pod each. A StatefulSet whose pod is crash-looping does
  **not** roll to a new revision on its own; delete the pod (`kubectl delete pod ouo-mimir-0`)
  after the upgrade (`project/kb/helm-kind.md`).

## Uninstall and data retention

```bash
helm uninstall ouo -n ouo
kubectl -n ouo get pvc          # everything is still here
```

Data survives an uninstall on purpose:

| Data | Claim | Why it stays |
|---|---|---|
| replay chunks (filesystem store) | `ouo-rum-api-replays` | `helm.sh/resource-policy: keep` (with the s3 store they live in the bucket, which the chart never touches) |
| Grafana database (users, dashboards) | `ouo-grafana` | `helm.sh/resource-policy: keep` |
| Loki / Tempo / Mimir blocks | `data-ouo-loki-0`, `data-ouo-tempo-0`, `data-ouo-mimir-0` | StatefulSet volumeClaimTemplates are never deleted by Helm |

Reinstalling with the same release name reattaches all of them. To wipe:
`kubectl -n ouo delete pvc -l app.kubernetes.io/instance=ouo` (the LGTM claims carry the
labels through the StatefulSet template; check with `get pvc` first). Retention per signal
(TTLs) is Phase 8b.

## High availability

`values-ha-example.yaml` documents the path (example only, not installed; rendered, linted and
dry-run against a cluster's API server on 2026-10-23: two collector and two rum-api replicas
with pod anti-affinity, no replay PVC, both Ingresses with TLS): the LGTM backends
from the upstream `grafana/loki`, `grafana/tempo-distributed` and `grafana/mimir-distributed`
charts in replicated mode on object storage, this chart in `lgtm.mode=external` with two
collectors behind one Ingress, two rum-api replicas on an S3 bucket
(`rumApi.storage.backend=s3`), and Grafana on an external database. The collector's
rate-limit buckets are per pod until shared state lands. To check a change to it:

```bash
S="--set collector.existingProjectsSecret=ouo-projects --set rumApi.existingSecret=ouo-rum-api-tokens --set grafana.existingSecret=ouo-grafana-admin"
helm lint --strict deploy/helm/ouo -f deploy/helm/ouo/values-ha-example.yaml $S
helm template ouo deploy/helm/ouo -n ouo -f deploy/helm/ouo/values-ha-example.yaml $S | kubectl apply -n ouo --dry-run=server -f -
```

`helm lint` passes even without the three Secrets; `helm template` does not (the chart refuses
to render without a project source), so always render with them.

### rum-api replay store on S3 / MinIO

```bash
kubectl -n ouo create secret generic ouo-rum-api-s3 \
  --from-literal=access-key-id=... --from-literal=secret-access-key=...
helm upgrade --install ouo deploy/helm/ouo -n ouo --reuse-values \
  --set rumApi.storage.backend=s3 --set rumApi.storage.s3.bucket=ouo-replays \
  --set rumApi.storage.s3.endpoint=minio.storage.svc:9000 --set rumApi.storage.s3.forcePathStyle=true \
  --set rumApi.storage.s3.insecure=true --set rumApi.storage.s3.existingSecret=ouo-rum-api-s3
```

On AWS leave `endpoint` empty, set `region`, and either use the Secret or pod identity
(`rumApi.serviceAccountName` with an IRSA role, no keys). The bucket must exist. The
pod's `/readyz` reports `storage` next to `loki` and `tempo`. Verified 2026-10-23 with an
in-cluster MinIO (`pgsty/minio`), prefix `kind-n12` and two rum-api replicas: a chunk posted
through the Ingress landed as `kind-n12/replays/<session>/000000.json.gz` and `meta.json`,
the replay played through the plugin proxy, no replay PVC was created, and rum-api after
0.3.0 also writes its schema marker `kind-n12/replays/schema.json`
(`docs/operations/upgrade.md` section 4). Moving existing replays off
the PVC: `mc mirror <pod>:/data/replays <alias>/<bucket>/[<prefix>/]replays` (same layout,
deploy/README.md).

## Values reference

| Key | Default | Meaning |
|---|---|---|
| `projects` | `[]` | list of `{id, token}` rendered to the collector htpasswd Secret; required unless `collector.existingProjectsSecret` |
| `ingestToken` | `""` | `OUO_INGEST_TOKEN` on the collector (bearer on replay forwards) and rum-api (check) |
| `readToken` | `""` | `OUO_READ_TOKEN` for `GET`/`DELETE /v1/*`; also provisioned into the Grafana plugin |
| `collector.enabled` | `true` | `false` only with another collector reachable at `rumApi.otel.endpoint` |
| `collector.image.{repository,tag,pullPolicy}` | `ghcr.io/ouo11y/collector`, `0.5.0` | the custom distribution |
| `collector.replicas` | `1` | rate-limit buckets are per pod: N replicas allow N times `collector.rateLimit.*` |
| `collector.existingProjectsSecret` | `""` | Secret with key `projects.htpasswd` |
| `collector.allowedOrigins` | `[]` | CORS origins on 4318 and 4319 (browser SDKs) |
| `collector.limits.{otlpMaxBodyBytes,replayMaxBodyBytes}` | `4194304`, `8388608` | `max_request_body_size` per receiver |
| `collector.rateLimit.project.{requestsPerSecond,burst}` | `1000`, `5000` | `ouoratelimit` per authenticated project |
| `collector.rateLimit.client.{requestsPerSecond,burst,keyFrom}` | `100`, `300`, auto | `ouoratelimit` per client; `keyFrom` `address` or `x_forwarded_for` (auto: XFF with the Ingress) |
| `collector.memoryLimiter.{limitMib,spikeLimitMib}`, `collector.batch.*` | `512`/`128`, `1s`/`512`/`1024` | processors |
| `collector.configOverride` | `""` | full collector config, replaces the generated one |
| `collector.service.{type,annotations}` | `ClusterIP` | public Service (4318, 4319) |
| `collector.ingress.{enabled,className,annotations,host,pathType,tls.enabled,tls.secretName}` | disabled | `/v1/replay` to 4319, `/` to 4318 |
| `collector.{resources,podSecurityContext,containerSecurityContext,nodeSelector,tolerations,affinity,podAnnotations,podLabels}` | see values.yaml | scheduling and hardening |
| `rumApi.image.{repository,tag,pullPolicy}` | `ghcr.io/ouo11y/rum-api`, `0.6.0` | rum-api image |
| `rumApi.replicas` | `1` | > 1 needs `rumApi.storage.backend=s3` (or a ReadWriteMany replay volume) |
| `rumApi.existingSecret` | `""` | Secret with `ingest-token`, `read-token` and optionally `otlp-headers` |
| `rumApi.config.grafanaUrl` | derived | browser-facing Grafana URL in trace deep links (`GRAFANA_URL`) |
| `rumApi.config.{tempoDatasourceUid,lokiDatasourceUid,sessionInactivity,sessionMaxDuration}` | `tempo`, `loki`, `30m`, `4h` | deep links, session end inference |
| `rumApi.structuredConfig` | `{}` | merged over the rendered rum-api `config.yaml` (any key of `services/rum-api/config.example.yaml`) |
| `rumApi.storage.backend` | `filesystem` | `filesystem` (PVC at `/data`) or `s3` |
| `rumApi.storage.s3.{endpoint,bucket,region,prefix}` | `""`, `""`, `us-east-1`, `""` | bucket (required for s3); empty endpoint is AWS `s3.<region>.amazonaws.com` |
| `rumApi.storage.s3.{insecure,insecureSkipVerify,forcePathStyle}` | `false` | plain HTTP, TLS without verification, path-style (MinIO) |
| `rumApi.storage.s3.{accessKeyId,secretAccessKey}` | `""` | static keys rendered into the rum-api Secret; empty plus no `existingSecret` = AWS credential chain / pod identity |
| `rumApi.storage.s3.existingSecret` | `""` | Secret with `access-key-id` and `secret-access-key` |
| `rumApi.serviceAccountName` | `""` | pod ServiceAccount (IRSA / workload identity) |
| `rumApi.otel.{enabled,environment,project,endpoint}` | `true`, `production`, first project, `<release>-collector:4318` | rum-api's own telemetry with that project's Basic credential |
| `rumApi.extraEnv` | `[]` | extra `EnvVar`s; they override the config file (for example `MAX_FRAME_CHUNK_BYTES`) |
| `rumApi.persistence.{enabled,size,storageClass,accessModes,existingClaim}` | `true`, `20Gi` | replay PVC |
| `rumApi.service.{port,annotations}` | `8080` | always ClusterIP, no Ingress |
| `rumApi.{resources,podSecurityContext,containerSecurityContext,nodeSelector,tolerations,affinity,priorityClassName,livenessProbe,readinessProbe,podAnnotations,podLabels}` | see values.yaml | scheduling and hardening |
| `grafana.enabled` | `true` | `false` when the customer runs Grafana |
| `grafana.image.*` | `ghcr.io/ouo11y/grafana`, `0.6.0` | image with the plugin |
| `grafana.adminUser` / `grafana.adminPassword` / `grafana.existingSecret` | `admin` / `""` / `""` | password required unless the Secret is given |
| `grafana.rootUrl` | derived from the Ingress | `GF_SERVER_ROOT_URL` |
| `grafana.defaultTheme`, `grafana.anonymousEnabled` | `dark`, `false` | |
| `grafana.env` (map) / `grafana.extraEnv` (list) | `{}` / `[]` | any `GF_*` setting (SSO, external database, SMTP) |
| `grafana.plugin.rumApiUrl` | in-cluster rum-api | what the plugin route proxy calls |
| `grafana.datasources.enabled` | `true` | provision Loki, Tempo, Mimir (uids `loki`, `tempo`, `mimir`) |
| `grafana.persistence.*`, `grafana.service.*`, `grafana.ingress.*`, `grafana.resources`, ... | `5Gi`, `3000`, disabled | |
| `lgtm.mode` | `bundled` | `bundled` or `external` |
| `lgtm.external.{lokiUrl,tempoUrl,tempoOtlpGrpcEndpoint,mimirUrl}` | upstream chart Service names | required in external mode |
| `lgtm.external.{lokiOtlpUrl,mimirOtlpUrl,mimirPrometheusUrl}` | derived (`<url>/otlp`, `<url>/prometheus`) | split read / write paths |
| `lgtm.external.tenantId` | `""` | `X-Scope-OrgID` on the collector exporters and the datasources |
| `lgtm.bundled.{loki,tempo,mimir}.image.*` | `3.7.7`, `3.0.3`, `3.2.1` | |
| `lgtm.bundled.<x>.configOverride` | `""` | full config, replaces the one mirrored from `deploy/compose` |
| `lgtm.bundled.<x>.persistence.{enabled,size,storageClass,accessModes}` | `true`, `20Gi` | StatefulSet volumeClaimTemplates |
| `lgtm.bundled.<x>.{resources,podSecurityContext,podAnnotations,nodeSelector,tolerations,affinity}` | uid 10001, small requests | |
| `nameOverride`, `fullnameOverride`, `imagePullSecrets`, `commonLabels` | | naming and registry access; `imagePullSecrets` only for a private mirror ("Pull access") |

Lint and render without a cluster: `helm lint deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml`,
`helm template ouo deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml`.
