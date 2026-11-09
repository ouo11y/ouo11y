# helm kind

Status: filled in Phase 8a by helm (2026-10-10), extended the same day for the revised
ADR-0007 (the collector is the edge) and re-verified on kind on 2026-10-13 with the
`ouo/collector` image. Verified on this Mac with kind v0.33.0 (node image
kindest/node:v1.37.0), kubectl v1.34.1, helm v4.3.0, Docker Desktop 29.3.1, installed with
Homebrew.

## Question

How do we install `deploy/helm/ouo` on a local kind cluster with locally built images, how
long does it take to come up, and what breaks on the way?

## What works (one command each)

```bash
kind create cluster --name ouo-8a                                   # ~60 s incl. node image pull
docker build -t ouo/collector:dev collector                         # ocb build of the custom distribution
docker build -t ouo/rum-api:dev services/rum-api                    # ~40 s warm cache
npm install && npm run -w plugins/ouo11y-rum-app build                 # dist/ is gitignored, build it first
docker build -t ouo/grafana:dev -f deploy/images/grafana/Dockerfile .
kind load docker-image ouo/collector:dev ouo/rum-api:dev ouo/grafana:dev --name ouo-8a
helm install ouo deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/instance=ouo --timeout=300s
kubectl port-forward svc/ouo-collector 4318:4318 &                  # public OTLP/HTTP (basic auth)
kubectl port-forward svc/ouo-collector 4319:4319 &                  # public replay receiver (basic auth)
kubectl port-forward svc/ouo-grafana 13000:3000 &
kubectl port-forward svc/ouo-rum-api 18080:8080 &                   # debugging only: rum-api is internal
kind delete cluster --name ouo-8a
```

## The collector image (revised ADR-0007)

- The chart runs `ouo/collector`, the custom distribution from `collector/` (ocb manifest,
  `ouoreplay` receiver and exporter, `ouoratelimit` processor), not the upstream contrib
  image: the config references components that do not exist upstream. Build context is
  `collector/` (`docker build -t ouo/collector:dev collector` from the repo root, 62 MB,
  about 2 min cold), then `kind load`. The image is distroless (`ENTRYPOINT /ouo-collector`),
  so `kubectl exec` has no shell; check a rendered config with the binary instead:
  `docker run --rm -e OUO_INGEST_TOKEN=x -v $PWD/col.yaml:/etc/otelcol/config.yaml:ro -v $PWD/projects.htpasswd:/etc/otelcol/projects.htpasswd:ro ouo/collector:dev validate --config=/etc/otelcol/config.yaml`
  (exit 0 for the kind and the external renders).
- The config is the chart ConfigMap (`templates/collector/configmap.yaml`), a mirror of
  `deploy/compose/collector/config.yaml` with the backend URLs, body limits, rate-limit
  numbers, the rum-api sink and (external mode) `X-Scope-OrgID` headers from values. Keep
  the two in sync when the collector agent changes the reference; `collector.configOverride`
  replaces the whole file.
- Environment from the Deployment: `OUO_INGEST_TOKEN` (rum-api Secret key `ingest-token`,
  the same key rum-api reads, so the two sides cannot drift), `OUO_ALLOWED_ORIGINS`
  (`collector.allowedOrigins` joined with commas; unset keeps the reference default
  `http://localhost:*,http://127.0.0.1:*`), `OUO_RATELIMIT_CLIENT_KEY` (`address`, or
  `x_forwarded_for` automatically when `collector.ingress.enabled`).
- gRPC 4317 is authenticated like 4318 and 4319. There is no unauthenticated in-cluster
  receiver: rum-api's own telemetry goes to `ouo-collector:4318` with
  `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64 id:token>` of
  `rumApi.otel.project` (default the first project), rendered into the rum-api Secret key
  `otlp-headers`. Verified: Tempo had `service.name=rum-api` traces minutes after install.
- Services: `ouo-collector` (4318, 4319; type from values, the Ingress target) and
  `ouo-collector-internal` (4317, 8888 self-metrics, 13133 health; always ClusterIP).

## Secret-rendered htpasswd

- `projects` (list of `{id, token}`) is rendered into the Secret `ouo-collector-projects`,
  key `projects.htpasswd`, one line `<id>:{SHA}<base64(sha1(token))>` per entry, by
  `ouo.htpasswdSha` in `_helpers.tpl`. Sprig has `sha1sum` (hex) and `b64enc` but no hex
  decoder, so the helper converts the 40 hex digits to a bit string and regroups it into 27
  base64 sextets plus one `=`. Verified identical to `htpasswd -nbs demo <token>` and to
  `openssl dgst -sha1 -binary | base64` for the dev token
  (`demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=`). `{SHA}` is cheap on purpose (ADR-0007
  section 2); the collector's `basicauth` extension accepts it. Bring your own file with
  `collector.existingProjectsSecret` (same key).
- The Secret and the ConfigMap are mounted together through one `projected` volume at
  `/etc/otelcol` (`config.yaml`, `projects.htpasswd`), so no `subPath` and both update in
  place; the Deployment still carries `checksum/config`, `checksum/projects` and
  `checksum/tokens` annotations, so `helm upgrade` with a new project rolls the pods
  (basicauth reads the file at start).
- The chart refuses to render with no project and no existing Secret, with an empty `id`
  or `token`, with an id outside `^[a-z0-9][a-z0-9._-]{0,63}$` (rum-api's and the replay
  receiver's rule; also excludes the `:` htpasswd separator), or with a **duplicate id**.
- **Rotation by two lines does not work.** ADR-0007 section 2 plans two htpasswd lines for
  the same project during a rotation overlap. On kind (revision 2: `demo` old token, then
  `demo` rotated token) the old token got **401** and the rotated one 200: upstream
  `basicauth` 0.160 keeps only the last line per username. Hence the duplicate-id refusal; a
  rotation is a cut-over until an authenticator with several tokens per project exists.
- Adding a project (`helm upgrade --set projects[1]...`) changed the Secret checksum, rolled
  the collector (new ReplicaSet, about 10 s) and the new credential answered 200; a project
  with another project's token answered 401.

## Ingress path routing for the collector

- One Ingress, one host (`collector.ingress.host`), two paths: `/v1/replay` (Prefix) to the
  Service port `replay` (4319) and `/` (Prefix) to `otlp-http` (4318).
  `networking.k8s.io/v1` controllers pick the longest matching prefix, so
  `/v1/replay/chunks` lands on 4319 and `/v1/traces`, `/v1/logs`, `/v1/metrics` on 4318,
  which is what the SDK default (`replayEndpoint` = `endpoint`) expects behind a domain.
- Behind the controller the TCP peer is the controller pod, so the per-client bucket keys on
  the first `X-Forwarded-For` hop (`OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for`, set by the
  chart when the Ingress is enabled). Through `kubectl port-forward` every request arrives
  from `127.0.0.1` (seen in the 429 message), so on kind the client bucket is per laptop.
- Annotations are free-form: `cert-manager.io/cluster-issuer` plus `tls.enabled=true` and
  the `tls.secretName` the issuer should fill; raise the controller's body limit
  (`nginx.ingress.kubernetes.io/proxy-body-size: 16m`) for 8 MiB replay chunks. The
  collector handles CORS and basic auth itself, the controller only terminates TLS.
- The internal ports (4317, 4320, 13133) are only on `ouo-collector-internal` (always
  ClusterIP) and are never part of the Ingress; rum-api has no Ingress and no Service type
  option at all. No ingress controller on kind: the Ingress renders and passes
  `kubectl apply --dry-run=server` (17/17 objects for both `values-external-lgtm.yaml` and
  `values-ha-example.yaml`, in a fresh namespace), path routing is verified on kind through
  port-forwards to the two Service ports instead.

## Image loading

- `kind load docker-image` copies the image into the node's containerd; `imagePullPolicy:
  IfNotPresent` with a tag like `dev` then uses it (`values-kind.yaml`). Never `Always`.
- Loading a new build under the same tag works, but running pods keep the old image until
  they are recreated: `kubectl rollout restart deploy/ouo-rum-api` (or `ouo-grafana`).
  Check what the node has with `docker exec ouo-8a-control-plane crictl images | grep ouo`.
- The Grafana image build context is the repository root (`-f deploy/images/grafana/Dockerfile .`);
  `deploy/images/grafana/Dockerfile.dockerignore` (BuildKit's per-Dockerfile ignore file)
  keeps `node_modules`, `.git` and everything else out, so the context is only the plugin
  dist. Build the plugin **right before** the image: an image built from a stale `dist/`
  silently ships the old `plugin.json` (this happened once in Phase 8a: the image lacked the
  `Authorization` route header the grafana-plugin agent had just added, and every plugin
  proxy call got 401 from rum-api until the image was rebuilt).
- The plugin inside the image sits at `/var/lib/grafana/plugins/ouo11y-rum-app`, which the data
  PVC mounted at `/var/lib/grafana` would hide. The chart's `install-plugin` init container
  copies it from the image onto the volume on every start (`cp -a`), so an image upgrade
  upgrades the plugin and user-installed plugins keep persisting.

## How long readiness takes (cold cluster, images pulled from Docker Hub)

| Pod | Ready after | Notes |
|---|---|---|
| grafana | 7 s | image already on the node |
| collector | 59 s | mostly the image pull |
| loki | ~2 min | pull + ingester "waiting 15 s after being ready" |
| tempo | ~2 min | pull + metrics-generator WAL replay (30 s) |
| mimir | 31 s | once the config below is right |
| rum-api | 6 s after start, but `/readyz` is 503 until Loki **and** Tempo answer | readiness probe `failureThreshold: 12` covers it |

Warm (images present): everything Ready in about one minute. A `helm upgrade` that only
touches rum-api rolls it in about 6 s (`Recreate` strategy, one replica on a RWO volume).

## Pitfalls hit on kind

1. **Mimir crash-loops under a non-root securityContext.** The compose container runs as
   root (`docker inspect ouo-mimir-1` shows `User=0`, workdir `/`), so Mimir's relative
   defaults work there. With `runAsUser: 10001` the image's `/` is read-only and Mimir dies
   on `open ./metrics-activity.log: permission denied`, then on
   `ruler: failed to access directory ./data-ruler/`. Fix in the chart's Mimir config:
   `activity_tracker.filepath: /data/metrics-activity.log`, `ruler.rule_path: /data/ruler`,
   `alertmanager.data_dir: /data/alertmanager`. Loki and Tempo already run as 10001 in
   compose and need nothing.
2. **A StatefulSet does not roll past a crash-looping pod.** After `helm upgrade` changed
   the Mimir ConfigMap, `ouo-mimir` kept `currentRevision != updateRevision` and the pod
   stayed on the old template (the kubelet did refresh the mounted ConfigMap in place, which
   is why the error message changed between restarts). `kubectl delete pod ouo-mimir-0`
   lets the controller create the pod from the new revision; Ready 31 s later.
3. **Helm renders big integers as floats.** `{{ .Values.x | quote }}` with `x: 4194304`
   produced `"4.194304e+06"` and rum-api failed with `OUO_MAX_INGEST_BYTES: strconv.Atoi`.
   Pipe through `int64` first (`{{ .Values.x | int64 | quote }}`); the chart does this for
   every numeric env var.
4. **`kubectl port-forward svc/...` binds to one pod** and dies with "lost connection to
   pod" when that pod is replaced (rollout restart, upgrade). Restart the port-forward after
   every rollout; `pkill -f "port-forward svc/ouo-"` then start again.
5. **`kubectl wait --for=condition=Ready` on the whole release times out** while images
   are pulling on a cold cluster (five minutes was not enough with Mimir broken; with the
   fix, three minutes cold is typical). Prefer `kubectl get pods -w` and look at
   `kubectl get events --sort-by=.lastTimestamp` for `Unhealthy` lines.
6. **Grafana app provisioning does expand `${ENV}`**: `secureJsonData.readToken: ${OUO_READ_TOKEN}`
   in the provisioning ConfigMap plus `OUO_READ_TOKEN` injected from the rum-api Secret
   gives `secureJsonFields: {readToken: true}` and a working `Authorization: Bearer`
   on the plugin route proxy (verified: `/api/plugin-proxy/ouo11y-rum-app/rum/v1/stats/health`
   200 with the provisioned value, 401 without the route header).
7. **Distroless images have no shell**: `kubectl exec` into rum-api, Loki, Tempo, Mimir or
   the collector fails; use `kubectl logs`, the Grafana pod (Alpine, has `sh`, `wget`) or a
   port-forward to poke at them. `kubectl exec deploy/ouo-grafana -- wget -qO- http://ouo-rum-api:8080/readyz`
   is the in-cluster probe.
8. kind's default StorageClass `standard` (rancher local-path, `WaitForFirstConsumer`) creates
   world-writable host directories, so `fsGroup` is not strictly needed there; the chart sets
   it anyway for real clusters.
9. `helm lint` does not run `fail` in templates the way `helm template` does: linting the
   chart without a project token passes, rendering it fails with the intended message. Lint
   **and** template in CI.

10. **zsh does not word-split `$var`.** `set -- $pair` and `helm lint ... $EXTRA` in zsh pass
    one argument (`TYPE/NAME and list of ports are required`, `unknown flag: --set a=b --set ...`).
    Use `${=EXTRA}` or a bash script. Port-forwards started with `&` inside a one-shot tool
    shell die with it; run them from a script that `wait`s, and one `kubectl port-forward
    svc/ouo-collector 4318:4318 4319:4319` covers both public ports.
11. **An empty OTLP request never reaches the rate limiter.** `{"resourceSpans":[]}` returned
    200 forty times against a 5/s burst 10 bucket; the same test with one real span gave
    10 x 200 and 30 x 429 (`Retry-After: 1`, gRPC status JSON with `RetryInfo`). Test limits
    with non-empty payloads.
12. **CORS preflights must list headers lowercase and sorted** (rs/cors, `project/kb-archive/collector-components.md`):
    `authorization,content-type` got `Access-Control-Allow-Origin`, `content-type,authorization`
    got a bare 204, exactly like a disallowed origin.
13. **`kubectl apply --dry-run=server` into the namespace of a live release** tries to resize
    its PVCs and is refused (`only dynamically provisioned pvc can be resized`); dry-run
    other values files into a scratch namespace.

## Verification that passed (2026-10-13, revised ADR-0007)

Install revision 1 at 14:54:33Z, all six pods 1/1 Running with zero restarts at 14:56:34Z
(about 2 min, cold node). Through `port-forward svc/ouo-collector 4318 4319`:
OTLP/JSON trace without credentials 401, wrong token 401, `Basic base64(demo:pt_dev_demo_...)`
200 `{"partialSuccess":{}}`; Tempo found it by `{ span.session.id = ... }` after 33 s with
`ouo.project.id=demo` overwriting the client's `spoofed`; replay chunk to 4319 without
credentials 401, with them 202 `{"accepted":1,...}`; rum-api (private port-forward) served
the replay meta with `project_id=demo` with the read token (401 without), and so did the
Grafana plugin proxy with the provisioned token (`secureJsonFields.readToken=true`, plugin
0.3.0); `ouo_replay_chunks_total` reached Mimir; preflights as in pitfall 12; no Ingress
objects, every Service ClusterIP (`ouo-rum-api` 8080 only). Revision 2 (project added, duplicate
id, client bucket 5/s burst 10): see rotation and rate-limit notes above; replay also gave
10 x 202 and 10 x 429. Revision 3 restored `values-kind.yaml`. Details in
`project/agents/helm/summaries/2026-10-10-phase-8a-rev2.md`.

## Verification that passed (2026-10-10, first draft: rum-api gateway, superseded)

`GET /readyz` -> `{"checks":{"loki":"ok","tempo":"ok"},"ready":true}`; Grafana `/api/health`
13.2.1 ok; `/api/plugins/ouo11y-rum-app/settings` enabled, `rumApiUrl=http://ouo-rum-api:8080`,
`secureJsonFields.readToken=true`; `POST /ingest/otlp/v1/traces` 401 without token, 403 with
`Origin: https://evil.example`, 200 `{"partialSuccess":{}}` with the token; the trace found in
Tempo by `{ span.session.id = "<id>" }` after 31 s with resource attribute
`ouo.project.id=demo` overwriting the spoofed value the client sent; `POST /v1/replay/chunks`
202 and `GET /v1/sessions/<id>/replay` 200 with the bearer token (401 without). Details in
`project/agents/helm/summaries/2026-10-10-phase-8a.md`.

## N12 paths (2026-10-23, platform-infra)

kind v0.33 node v1.37.0, helm v4.3.0, ingress-nginx chart 4.15.1, cert-manager v1.21.2,
MinIO `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`. Results are in `deploy/helm/ouo/README.md`;
what was not obvious:

- `kind load docker-image` fails on multi-arch images from Docker Desktop's containerd store;
  pipe `docker save --platform linux/arm64` into `ctr -n k8s.io images import` on the node.
- A `selfSigned` ClusterIssuer issues an empty-subject leaf that curl cannot verify
  (`ssl_verify_result=1`); bootstrap a CA from it and use a `ca` issuer. Right after the
  certificates turn Ready, ingress-nginx serves its fake certificate for a few seconds while it
  reloads (`ssl_verify_result=20`).
- ingress-nginx (default `use-forwarded-headers: false`) replaces a client's
  `X-Forwarded-For`, so `key_from: x_forwarded_for` behind it is not spoofable; straight to a
  pod it is.
- With `collector.existingProjectsSecret` the rum-api Secret needs `otlp-headers`, or rum-api's
  own telemetry is refused.
- An LGTM-only release of this chart is a cheap "external" stack for `lgtm.mode=external`.
