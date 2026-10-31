# Running the Sentry bridge: one replica

For pilots who point a Sentry SDK at the ouo Sentry bridge (the collector's `ouosentry`
receiver, [ADR-0008](adr/0008-sentry-sdk-bridge.md), [spec](specs/sentry-bridge.md)). Client
side setup is in [sentry-client-setup.md](sentry-client-setup.md).

**Run exactly one bridge process.** The bridge keeps its session state in memory, so it runs
as one replica until that state moves to a shared store (roadmap Phase 11, checklist N4). The
OTLP and replay receivers have no such limit; only the bridge does.

## What the bridge keeps in memory

Sentry SDKs do not put a session id on most items. The bridge learns which session an item
belongs to from earlier envelopes of the same device and remembers it (spec section 8):

- the session table: Sentry `sid` -> ouo session, with its start, last update, device id
  (`did`), whether `session.start` / `session.end` were already emitted, how many exceptions
  were emitted for it, and the previous session of the device;
- `replay_id` -> session, trace id -> session (up to 512 per session), network origin ->
  recent sessions (for startup logs), replay masking options of each replay;
- replay segments and log entries that could not be matched yet, held up to `replay_hold`
  (10 min) and `log_hold` (1 min) while the session they belong to may still arrive.

All of it is bounded (`state.max_sessions`, default 200 000 sessions, 4 h TTL after the last
update) and none of it is written to disk.

## What breaks with two replicas

Forwarding to Sentry is stateless: **Sentry still receives every envelope unchanged** with any
number of replicas. What degrades is the ouo copy, because a load balancer sends one device's
envelopes to both replicas and each replica sees only part of every session:

| Data in ouo | With two replicas behind a round-robin balancer |
|---|---|
| Transactions, logs and errors sent without a `session` item in the same envelope | Matched only on the replica that saw the session; on the other one they get no `session.id` (`ouo.sentry.session_match = none`): they are missing from the session's timeline and its traces |
| Replay | Segments arriving at the replica that does not know the `replay_id` are held 10 minutes and then dropped (`ouo_sentry_translate_dropped_total{reason="replay_unresolved"}`): the replay has gaps. Masking of later segments falls back to the SDK default |
| Error counts | Each replica counts the exceptions it emitted for a session; when the other replica's error event is missing from its count, it adds a synthetic `sentry.unsampled_error`, so errored sessions show too many errors |
| `session.previous_id`, startup console logs | Lost when the previous session or the session start was seen by the other replica |
| Session start and end | Still correct (rum-api keeps the last `session.end`); a duplicate is possible |

Client-address affinity (sticky routing on the client IP) helps only while a device keeps its
address. Phones move between Wi-Fi and cellular and sit behind carrier NAT, so do not rely on
it: run one replica.

**Restarts** lose the state too. After a restart the bridge rebuilds it from the next
envelopes: sessions already running are picked up mid-way (no backfilled errors), held replay
segments are lost, and a duplicate `session.start` or `session.end` is possible (harmless).
Restart during quiet hours if you can.

**Sizing.** One replica handles the translation off the request path with a bounded queue
(`translate_queue_size`, default 10 000 envelopes). Watch
`ouo_sentry_translate_dropped_total{reason="queue_full"}` in Mimir: it counts envelopes that
were forwarded to Sentry but not translated. Give the pod more CPU before thinking of more
replicas.

## Docker Compose and the VM install

Nothing to do: `deploy/compose` and `deploy/vm` run one collector container, and the bridge
is its `ouosentry` receiver on port 4320. Do not `docker compose up --scale otel-collector=2`.

## Kubernetes (Helm)

The `ouo` chart does not deploy the bridge yet. Run it as its **own Deployment with one
replica** next to the chart, so the main collector (OTLP and replay) can still scale:

- `replicas: 1` and `strategy: Recreate`, so a rollout never runs the old and the new pod at
  the same time (a `RollingUpdate` would, for as long as both are up);
- no HorizontalPodAutoscaler and no `kubectl scale`;
- the same image as the chart's collector (`ghcr.io/ouo11y/collector`, the bridge is built in);
- it exports straight to the chart's Tempo, Loki and rum-api Services (the main collector
  wants a Basic project credential, which the bridge does not have), with the bridge's own
  `ouoratelimit` and `resource/project` processors.

The manifests below assume the release `ouo` in namespace `ouo` with the bundled LGTM stack
(Services `ouo-tempo`, `ouo-loki`, `ouo-mimir`, `ouo-rum-api`) and the rum-api Secret `ouo-rum-api`
(key `ingest-token`); adjust the names with `kubectl get svc,secret -n ouo`. Replace the
project table with your Sentry project id, DSN public key, upstream and ouo project.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ouo-sentry-bridge
  namespace: ouo
data:
  config.yaml: |
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
    receivers:
      ouosentry:
        endpoint: 0.0.0.0:4320
        upstream_timeout: 30s
        projects:
          - sentry_project_id: "4504"
            public_keys: ["<DSN public key>"]
            upstream: https://o123.ingest.sentry.io   # your Sentry ingest host, or none
            ouo_project_id: mobile-store
            service_name: mobile-store-ios
    connectors:
      routing/sentry:
        default_pipelines: [logs]
        table:
          - context: log
            condition: log.attributes["ouo.replay.chunk"] == true
            pipelines: [logs/replay]
    processors:
      memory_limiter: { check_interval: 1s, limit_mib: 512, spike_limit_mib: 128 }
      ouoratelimit:
        project: { rate: 1000, burst: 5000 }
        client: { rate: 100, burst: 300, key_from: address }
      resource/project:
        attributes:
          - { key: ouo.project.id, action: delete }
          - { key: ouo.project.id, from_context: auth.username, action: upsert }
      transform/events:
        error_mode: ignore
        log_statements:
          - context: log
            statements:
              - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
              - set(log.attributes["ouo.platform"], resource.attributes["ouo.platform"]) where log.attributes["ouo.platform"] == nil and resource.attributes["ouo.platform"] != nil
      batch: { timeout: 1s, send_batch_size: 512, send_batch_max_size: 1024 }
    exporters:
      otlp_grpc/tempo: { endpoint: "ouo-tempo:4317", tls: { insecure: true } }
      otlp_http/loki: { endpoint: "http://ouo-loki:3100/otlp", tls: { insecure: true } }
      ouoreplay:
        endpoint: http://ouo-rum-api:8080
        ingest_token: ${env:OUO_INGEST_TOKEN}
        sending_queue: { enabled: true, queue_size: 1000 }
        retry_on_failure: { enabled: true, max_elapsed_time: 5m }
    service:
      extensions: [health_check]
      telemetry:
        metrics:
          level: normal
          readers:
            - periodic:
                interval: 15000
                exporter:
                  otlp: { protocol: http/protobuf, endpoint: "http://ouo-mimir:9009/otlp/v1/metrics" }
      pipelines:
        traces:
          receivers: [ouosentry]
          processors: [memory_limiter, ouoratelimit, resource/project, batch]
          exporters: [otlp_grpc/tempo]
        logs/sentry:
          receivers: [ouosentry]
          processors: [memory_limiter]
          exporters: [routing/sentry]
        logs:
          receivers: [routing/sentry]
          processors: [memory_limiter, ouoratelimit, resource/project, transform/events, batch]
          exporters: [otlp_http/loki]
        logs/replay:
          receivers: [routing/sentry]
          processors: [memory_limiter, ouoratelimit]
          exporters: [ouoreplay]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ouo-sentry-bridge
  namespace: ouo
spec:
  replicas: 1                 # never more: the session state is in memory
  strategy:
    type: Recreate            # no overlap of old and new pod during a rollout
  selector:
    matchLabels: { app.kubernetes.io/name: ouo-sentry-bridge }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ouo-sentry-bridge }
    spec:
      containers:
        - name: bridge
          image: ghcr.io/ouo11y/collector:0.3.0    # same tag as the chart's collector
          args: ["--config=/etc/otelcol/config.yaml"]
          env:
            - name: OUO_INGEST_TOKEN
              valueFrom: { secretKeyRef: { name: ouo-rum-api, key: ingest-token } }
          ports:
            - { name: sentry, containerPort: 4320 }
          readinessProbe: { httpGet: { path: /, port: 13133 } }
          livenessProbe: { httpGet: { path: /, port: 13133 } }
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { memory: 768Mi }
          volumeMounts:
            - { name: config, mountPath: /etc/otelcol }
      volumes:
        - name: config
          configMap: { name: ouo-sentry-bridge }
---
apiVersion: v1
kind: Service
metadata:
  name: ouo-sentry-bridge
  namespace: ouo
spec:
  selector: { app.kubernetes.io/name: ouo-sentry-bridge }
  ports:
    - { name: sentry, port: 4320, targetPort: sentry }
```

Expose the Service on its own host (`sentry-bridge.example.com`) with your ingress controller
and TLS, as you expose the chart's collector; the DSN host becomes that name (no port with
TLS on 443). The image is public; add the chart's `imagePullSecrets` only when you pull it from a private mirror.
Upgrade the bridge image together with the chart's collector.

Check it: `kubectl -n ouo get deploy ouo-sentry-bridge` shows `1/1`, and after the app sent a
session, `ouo_sentry_envelopes_total{outcome="forwarded"}` grows in Mimir and the session
appears in the ouo plugin.
