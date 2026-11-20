# ouo Helm chart

Installs ouo on Kubernetes: the **ouo collector** (the custom OpenTelemetry Collector
distribution from `collector/`, the only public ingest: project tokens as HTTP Basic
credentials, OTLP/HTTP on 4318, the Sentry SDK bridge on 4320, rate and size limits),
**Grafana** (stock `grafana/grafana` with the LGTM datasources provisioned), and either a
**bundled** single-binary Loki, Tempo and Mimir or the customer's **external** LGTM stack.
Replay chunks go to **Muninn** (ADR-0019), which this chart does not deploy: set
`muninn.endpoint` to a Muninn you run next to it. Design: ADR-0007
(`docs/adr-archive/0007-ingest-gateway-project-tokens.md`).

```
browser / mobile SDK --POST /v1/{traces,logs,metrics} + Authorization: Basic id:token--> collector:4318 (Ingress)
Sentry SDK           --POST /api/<id>/envelope/ + DSN key-------------------------> collector:4320 (Ingress, /api/*)
collector --OTLP--> Loki / Tempo / Mimir (bundled or external)          [ouo.project.id stamped from the credential]
collector --OTLP logs, scope ouo.replay + Bearer ingest token + X-Scope-OrgID--> Muninn [disk queue, fsync]
in-cluster services --OTLP + Basic credential--> collector:4318 (HTTP) / collector-internal:4317 (gRPC)
```

Verified on kind (Phase 8a): `project/agents/helm/summaries/2026-10-10-phase-8a-rev2.md`, `project/kb-archive/helm-kind.md`.
Verified on a one-node kind cluster on 2026-10-23 (checklist N12): S3 on in-cluster MinIO,
Ingress with ingress-nginx and cert-manager, the `x_forwarded_for` client key, two collector
replicas, every `existingSecret`, `lgtm.mode=external` against a separate LGTM release, and
`helm upgrade` from chart 0.1.0. The HA values are rendered, linted and dry-run against the
API server only. Evidence: `project/agents/platform-infra/reports/2026-10-23-8a-vm-upgrade-n12.html`.

## Images

| Component | Image | Built from |
|---|---|---|
| collector | `ghcr.io/ouo11y/collector` (released by `collector-v*` tags) | `collector/Dockerfile` (`docker build -t ouo/collector:<tag> collector`) |
| Grafana | `grafana/grafana:13.2.5` | upstream |
| Loki / Tempo / Mimir (bundled) | `grafana/loki:3.7.7`, `grafana/tempo:3.0.3`, `grafana/mimir:3.2.1` | upstream |

Every tag is a value: `--set collector.image.tag=0.5.0 --set grafana.image.tag=13.2.5 --set lgtm.bundled.loki.image.tag=...`.
Use `<component>.image.repository` for a registry and `imagePullSecrets` for a private one.

### Pull access

The `ghcr.io/ouo11y/collector` image is public: the pods pull them without a pull secret.
`imagePullSecrets` is for a private mirror of them: create a `docker-registry` Secret for that
registry in the release namespace, then add `--set 'imagePullSecrets[0].name=<secret>'` to the
`helm install` / `helm upgrade` commands below (or `imagePullSecrets: [{name: <secret>}]` in
your values file). The chart puts it on every pod it runs, bundled LGTM included.

No route from the cluster to ghcr.io: pull the released images (or build them from source,
table above), push them to a registry the cluster can reach (kind: `kind load docker-image`)
and set `<component>.image.repository` / `.tag`.

## Install A: existing cluster, the customer's LGTM stack (`lgtm.mode=external`)

Nothing LGTM is deployed. The collector and Grafana point at the URLs you give.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  -f deploy/helm/ouo/values-external-lgtm.yaml \
  --set lgtm.external.lokiUrl=http://loki-gateway.observability.svc:80 \
  --set lgtm.external.tempoUrl=http://tempo-query-frontend.observability.svc:3200 \
  --set lgtm.external.tempoOtlpGrpcEndpoint=tempo-distributor.observability.svc:4317 \
  --set lgtm.external.mimirUrl=http://mimir-nginx.observability.svc:80 \
  --set projects[0].id=web-store --set projects[0].token=pt_$(openssl rand -hex 16) \
  --set 'collector.allowedOrigins={https://shop.example.com,https://*.preview.example.com}' \
  --set muninn.endpoint=http://muninn.muninn.svc:3400 --set muninn.ingestToken=<Muninn auth.ingest_token> \
  --set grafana.adminPassword="$(openssl rand -base64 18)" \
  --set collector.ingress.host=otel.example.com --set grafana.ingress.host=grafana.example.com
```

Requirements on the external stack are in
[docs/operations/existing-lgtm.md](../../../docs/operations/existing-lgtm.md). In short:
- Loki: schema v13 / tsdb, `allow_structured_metadata: true`, and ouo's OTLP label promotion
  added to Loki's defaults (`ouo.platform`, `ouo.project.id`, log attributes `event.name`,
  `ouo.platform`). Never `ignore_defaults: true` in a shared Loki: it drops the other senders'
  labels.
- Tempo: `stream_over_http_enabled: true` and an OTLP gRPC receiver.
- Mimir: OTLP ingestion.

Multi-tenant stacks: set `lgtm.external.tenantId`. The collector and the Grafana
datasources then send `X-Scope-OrgID`.
Separate read and write paths: `lgtm.external.lokiOtlpUrl`, `mimirOtlpUrl`,
`mimirPrometheusUrl`. Your own OTel collector in front: point `tempoOtlpGrpcEndpoint`,
`lokiOtlpUrl` and `mimirOtlpUrl` at it. Set `retention.logs` to your Loki's retention.

Verified 2026-10-23 with `values-external-lgtm.yaml` and the four URLs pointed at a second
release of this chart that ran only the bundled Loki, Tempo and Mimir (`collector.enabled=false`,
`grafana.enabled=false`; that run predates Muninn) in another namespace: `smoke.sh` found the
trace, log and metric in that stack, and the three Grafana datasources answered health 200.

Already running Grafana? `--set grafana.enabled=false` and add the Loki, Tempo and Mimir
datasources to it.

## Install B: bundled LGTM (`lgtm.mode=bundled`, the default)

Single-binary Loki, Tempo and Mimir as StatefulSets with the configs from
`deploy/compose/{loki,tempo,mimir}/config.yaml` on PersistentVolumeClaims. For kind,
development and small installs; not replicated.

```bash
helm install ouo deploy/helm/ouo -n ouo --create-namespace \
  --set projects[0].id=web-store --set projects[0].token=pt_$(openssl rand -hex 16) \
  --set muninn.endpoint=http://muninn.muninn.svc:3400 --set muninn.ingestToken=<Muninn auth.ingest_token> \
  --set grafana.adminPassword="$(openssl rand -base64 18)"
```

On kind with locally built images: `values-kind.yaml` (commands at the top of the file; the
development tokens in it are public and only acceptable on a laptop).

The chart refuses to render without at least one `projects` entry or
`collector.existingProjectsSecret` (ADR-0007: there is no auth-off mode), without
`muninn.endpoint` and a Muninn ingest token, and without a Grafana admin password.

## After install

`helm install` prints the port-forward commands, the project list, the token reminder and the
SDK snippet (`templates/NOTES.txt`). Without an Ingress:

```bash
kubectl -n ouo port-forward svc/ouo-collector 4318:4318 &   # OTLP/HTTP
kubectl -n ouo port-forward svc/ouo-collector 4320:4320 &   # Sentry bridge
kubectl -n ouo port-forward svc/ouo-grafana 3000:3000 &
CRED=$(printf 'web-store:pt_...' | base64)
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'                                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4318/v1/traces -H "Authorization: Basic $CRED" -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'  # 200
open http://localhost:3000
```

SDK configuration (SDKs 0.2.0):

```ts
initRUM({
  endpoint: "https://otel.example.com",        // collector OTLP/HTTP base
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
are public; the **Muninn ingest token** (collector to Muninn) is secret and lives in the
Secret `<release>-collector-muninn` (or `muninn.existingSecret`, key `ingest-token`).

Nothing secret in a values file: three pre-created Secrets replace every
inline credential.

```bash
kubectl -n ouo create secret generic ouo-projects --from-literal=projects.htpasswd="web-store:{SHA}$(printf '%s' "$PT" | openssl dgst -binary -sha1 | openssl base64)"
kubectl -n ouo create secret generic ouo-muninn-ingest --from-literal=ingest-token=<Muninn auth.ingest_token>
kubectl -n ouo create secret generic ouo-grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -base64 18)"
```

then `collector.existingProjectsSecret=ouo-projects`, `muninn.existingSecret=ouo-muninn-ingest`,
`grafana.existingSecret=ouo-grafana-admin`.

Browser SDKs also need their origins in `collector.allowedOrigins` (`OUO_ALLOWED_ORIGINS`,
CORS on the OTLP/HTTP receiver, the union of all projects; wildcards like
`https://*.preview.example.com` work; empty keeps the reference default
`http://localhost:*,http://127.0.0.1:*`). Mobile and server clients send no `Origin` and are
unaffected. Hand-written `curl` preflights must list `Access-Control-Request-Headers`
lowercase and sorted (`authorization,content-type`), as browsers do, or the collector answers
without `Access-Control-Allow-Origin` (`project/kb-archive/collector-components.md`).

Project ids must match `^[a-z0-9][a-z0-9._-]{0,63}$` (the chart refuses others). basicauth
reads the htpasswd once at start; the checksum annotation makes `helm upgrade` roll the
collector so a new project or token takes effect.

### Source maps and dSYMs

`ouo-sourcemaps upload` / `upload-dsym` (`@ouo11y/sourcemaps` from its next release) upload to
**Muninn's** public upload route, `PUT /api/v1/projects/{p}/debug-files/{kind}/{id}`, with a
per-project upload token from Muninn's `debug_files.upload_tokens`, and stacks are resolved on
read by `libs/ouo-go/symbolicate` in your plugin backend (ADR-0026, `docs/sourcemaps.md`,
`docs/symbolication.md`). This chart does not deploy Muninn, so it has no upload route: run
Muninn next to the chart and publish only that route through your Ingress.

### Expose the collector

The collector is the only service SDKs reach. Three ways:

1. **Ingress** (`collector.ingress`): one host, `/api` (Prefix, Sentry envelopes) to port
   4320 and `/` to port 4318, optional `className`, TLS Secret and free-form annotations. cert-manager:
   `cert-manager.io/cluster-issuer: letsencrypt` plus `tls.enabled=true` and the Secret name
   the issuer should fill. Without public DNS (a lab, kind): a `selfSigned` ClusterIssuer
   alone issues a leaf certificate with an empty subject that clients cannot verify against
   anything; bootstrap a CA with it instead (a `Certificate` with `isCA: true` from the
   self-signed issuer, then a `ca` ClusterIssuer on that Secret) and trust that one root.
   Verified so with ingress-nginx 4.15.1 and cert-manager v1.21.2: both certificates Ready,
   `curl --cacert root.crt` verifies, OTLP 401 / 200, CORS preflight 204 from the
   allowed origin, Grafana through the Grafana Ingress. Raise the controller's body limit
   above `collector.limits.otlpMaxBodyBytes` (`nginx.ingress.kubernetes.io/proxy-body-size: 16m`).
   The SDK `endpoint` is then `https://otel.example.com`; replay chunks use the same OTLP path.
2. **LoadBalancer** (`collector.service.type=LoadBalancer`): the Service exposes 4318 and
   4320 on the address the cloud hands out. No TLS unless the load balancer terminates it.
3. **Port-forward** for a laptop or CI (`values-kind.yaml`).

The gRPC receiver (4317, Basic auth like the public ports), the health port (13133) and the
self-metrics port (8888) are only in the ClusterIP Service `<release>-collector-internal`
and never behind the Ingress. Every OTLP client needs a project credential, in-cluster ones
included.

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
carry data: empty OTLP requests (`{"resourceSpans":[]}`) bypass the processor (checklist N13).

### Replay to Muninn

Replay chunks are OTLP log records (scope `ouo.replay`) on the ordinary `/v1/logs`. The
collector routes them to `otlp_http/muninn` (`<muninn.endpoint>/otlp/v1/logs`, bearer
`muninn.ingestToken`, `X-Scope-OrgID: <muninn.tenant>`) through a `file_storage` queue
fsynced on every enqueue, and sends Loki a reference copy without the bytes
(`ouo.replay.ref`). The queue is bounded by `collector.replayQueue.sizeBytes` (full: 503 to
the SDK) and lives in an emptyDir unless `collector.replayQueue.persistence.enabled`; an
emptyDir loses queued chunks when the pod goes. The Sentry bridge's video replay chunks
have no store yet and go to the debug exporter. The pipeline mirrors
`deploy/compose/collector/config.yaml`.

## Upgrade

```bash
helm upgrade ouo deploy/helm/ouo -n ouo -f my-values.yaml --rollback-on-failure --timeout 10m   # Helm 3: --atomic
```

Upgrade with your values file rather than `--reuse-values`, which keeps the previous
release's values and so the previous chart's image tags. Rehearsed 2026-10-23 from chart
0.1.0 (images `ghcr.io/ziadmansourm/ouo/*:0.2.0`) to 0.1.1 (`ghcr.io/ouo11y/*:0.3.0`) on kind
(`docs/operations/upgrade.md` section 8; that chart predates Muninn).

- Deployments carry checksums of their ConfigMaps and Secrets, so a config, project or token
  change rolls the pods.
- Grafana uses the `Recreate` strategy (ReadWriteOnce volume): a few seconds of downtime
  per upgrade with one replica. The collector rolls with a RollingUpdate; its Muninn exporter
  retries queued chunks.
- Bundled LGTM StatefulSets roll one pod each. A StatefulSet whose pod is crash-looping does
  **not** roll to a new revision on its own; delete the pod (`kubectl delete pod ouo-mimir-0`)
  after the upgrade (`project/kb-archive/helm-kind.md`).

## Uninstall and data retention

```bash
helm uninstall ouo -n ouo
kubectl -n ouo get pvc          # everything is still here
```

Data survives an uninstall on purpose:

| Data | Claim | Why it stays |
|---|---|---|
| collector replay queue (when persisted) | `ouo-collector-replay-queue` | `helm.sh/resource-policy: keep` |
| Grafana database (users, dashboards) | `ouo-grafana` | `helm.sh/resource-policy: keep` |
| Loki / Tempo / Mimir blocks | `data-ouo-loki-0`, `data-ouo-tempo-0`, `data-ouo-mimir-0` | StatefulSet volumeClaimTemplates are never deleted by Helm |

Reinstalling with the same release name reattaches all of them. To wipe:
`kubectl -n ouo delete pvc -l app.kubernetes.io/instance=ouo` (the LGTM claims carry the
labels through the StatefulSet template; check with `get pvc` first). Retention per signal
(TTLs) is Phase 8b.

## High availability

`values-ha-example.yaml` documents the path (example only, not installed; rendered, linted and
dry-run against a cluster's API server on 2026-10-23: before Muninn: two collector replicas with pod anti-affinity, both Ingresses with TLS): the LGTM backends
from the upstream `grafana/loki`, `grafana/tempo-distributed` and `grafana/mimir-distributed`
charts in replicated mode on object storage, this chart in `lgtm.mode=external` with two
collectors behind one Ingress, Muninn deployed separately, and Grafana on an external database. The collector's
rate-limit buckets are per pod until shared state lands. To check a change to it:

```bash
S="--set collector.existingProjectsSecret=ouo-projects --set muninn.existingSecret=ouo-muninn-ingest --set grafana.existingSecret=ouo-grafana-admin"
helm lint --strict deploy/helm/ouo -f deploy/helm/ouo/values-ha-example.yaml $S
helm template ouo deploy/helm/ouo -n ouo -f deploy/helm/ouo/values-ha-example.yaml $S | kubectl apply -n ouo --dry-run=server -f -
```

`helm lint` passes even without the three Secrets; `helm template` does not (the chart refuses
to render without a project source), so always render with them.

## Values reference

| Key | Default | Meaning |
|---|---|---|
| `projects` | `[]` | list of `{id, token}` rendered to the collector htpasswd Secret; required unless `collector.existingProjectsSecret` |
| `muninn.endpoint` | `""` | Muninn base URL; required while the collector is enabled (the chart does not deploy Muninn) |
| `muninn.ingestToken` / `muninn.existingSecret` | `""` / `""` | Muninn's `auth.ingest_token` (`MUNINN_INGEST_TOKEN`), or a Secret with key `ingest-token` |
| `muninn.tenant` | `anonymous` | `X-Scope-OrgID` sent to Muninn |
| `collector.enabled` | `true` | |
| `collector.image.{repository,tag,pullPolicy}` | `ghcr.io/ouo11y/collector`, `0.5.0` | the custom distribution |
| `collector.replicas` | `1` | rate-limit buckets are per pod: N replicas allow N times `collector.rateLimit.*` |
| `collector.existingProjectsSecret` | `""` | Secret with key `projects.htpasswd` |
| `collector.allowedOrigins` | `[]` | CORS origins on 4318 (browser SDKs) |
| `collector.limits.otlpMaxBodyBytes` | `4194304` | `max_request_body_size` of the OTLP/HTTP receiver |
| `collector.replayQueue.sizeBytes` | `2147483648` | Muninn exporter disk queue bound |
| `collector.replayQueue.persistence.{enabled,size,storageClass,accessModes,existingClaim}` | `false`, `4Gi` | PVC for the queue (emptyDir when disabled) |
| `collector.sentry.{projectId,publicKey,upstream,ouoProjectId,serviceName}` | `1`, dev key, `none`, `demo`, `sentry-demo` | the bridged Sentry DSN (ADR-0008) |
| `collector.rateLimit.project.{requestsPerSecond,burst}` | `1000`, `5000` | `ouoratelimit` per authenticated project |
| `collector.rateLimit.client.{requestsPerSecond,burst,keyFrom}` | `100`, `300`, auto | `ouoratelimit` per client; `keyFrom` `address` or `x_forwarded_for` (auto: XFF with the Ingress) |
| `collector.memoryLimiter.{limitMib,spikeLimitMib}`, `collector.batch.*` | `512`/`128`, `1s`/`512`/`1024` | processors |
| `collector.configOverride` | `""` | full collector config, replaces the generated one |
| `collector.service.{type,annotations}` | `ClusterIP` | public Service (4318, 4320) |
| `collector.ingress.{enabled,className,annotations,host,pathType,tls.enabled,tls.secretName}` | disabled | `/api` to 4320, `/` to 4318 |
| `collector.{resources,podSecurityContext,containerSecurityContext,nodeSelector,tolerations,affinity,podAnnotations,podLabels}` | see values.yaml | scheduling and hardening |
| `grafana.enabled` | `true` | `false` when the customer runs Grafana |
| `grafana.image.*` | `grafana/grafana`, `13.2.5` | stock image |
| `grafana.adminUser` / `grafana.adminPassword` / `grafana.existingSecret` | `admin` / `""` / `""` | password required unless the Secret is given |
| `grafana.rootUrl` | derived from the Ingress | `GF_SERVER_ROOT_URL` |
| `grafana.defaultTheme`, `grafana.anonymousEnabled` | `dark`, `false` | |
| `grafana.env` (map) / `grafana.extraEnv` (list) | `{}` / `[]` | any `GF_*` setting (SSO, external database, SMTP) |
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
