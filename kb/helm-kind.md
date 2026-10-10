# helm kind

Status: filled in Phase 8a by helm (2026-10-10). Verified on this Mac with kind v0.33.0
(node image kindest/node:v1.37.0), kubectl v1.34.1, helm v4.3.0, Docker Desktop 29.3.1,
installed with Homebrew.

## Question

How do we install `deploy/helm/ouo` on a local kind cluster with locally built images, how
long does it take to come up, and what breaks on the way?

## What works (one command each)

```bash
kind create cluster --name ouo-8a                                   # ~60 s incl. node image pull
docker build -t ouo/rum-api:dev services/rum-api                    # ~40 s warm cache
npm install && npm run -w plugins/ouo-rum-app build                 # dist/ is gitignored, build it first
docker build -t ouo/grafana:dev -f deploy/images/grafana/Dockerfile .
kind load docker-image ouo/rum-api:dev ouo/grafana:dev --name ouo-8a
helm install ouo deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/instance=ouo --timeout=300s
kubectl port-forward svc/ouo-rum-api 18080:8080 &
kubectl port-forward svc/ouo-grafana 13000:3000 &
kind delete cluster --name ouo-8a
```

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
- The plugin inside the image sits at `/var/lib/grafana/plugins/ouo-rum-app`, which the data
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
   on the plugin route proxy (verified: `/api/plugin-proxy/ouo-rum-app/rum/v1/stats/health`
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

## Verification that passed (2026-10-10)

`GET /readyz` -> `{"checks":{"loki":"ok","tempo":"ok"},"ready":true}`; Grafana `/api/health`
13.2.1 ok; `/api/plugins/ouo-rum-app/settings` enabled, `rumApiUrl=http://ouo-rum-api:8080`,
`secureJsonFields.readToken=true`; `POST /ingest/otlp/v1/traces` 401 without token, 403 with
`Origin: https://evil.example`, 200 `{"partialSuccess":{}}` with the token; the trace found in
Tempo by `{ span.session.id = "<id>" }` after 31 s with resource attribute
`ouo.project.id=demo` overwriting the spoofed value the client sent; `POST /v1/replay/chunks`
202 and `GET /v1/sessions/<id>/replay` 200 with the bearer token (401 without). Details in
`agents/helm/summaries/2026-10-10-phase-8a.md`.
