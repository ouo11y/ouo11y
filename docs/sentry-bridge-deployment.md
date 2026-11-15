# Running the Sentry bridge: one replica

For pilots who point a Sentry SDK at the ouo Sentry bridge (the collector's `ouosentry`
receiver, [ADR-0008](adr-archive/0008-sentry-sdk-bridge.md), [spec](specs/sentry-bridge.md)). Client
side setup is in [sentry-client-setup.md](sentry-client-setup.md).

**Run exactly one bridge process.** The bridge keeps its session state in memory, so it runs
as one replica until that state moves to a shared store (roadmap Phase 11, checklist N4). The
OTLP and replay receivers have no such limit; only the bridge does.

## Putting a production app behind the bridge

The bridge forwards every envelope to Sentry unchanged and returns Sentry's answer, so the app
sees no difference while the bridge runs. The risks are in the cases where it does not run, and
in a project table that does not match. Before switching a production DSN:

1. **Set `passthrough_upstream` to the production Sentry ingest host** (spec section 2a). Without
   it, an envelope whose key or project is not in the table gets `403`, and Sentry SDKs delete an
   envelope on any `4xx` but `429`: a typo or a rotated key loses production data. With it, the
   bridge forwards whatever it does not recognise, untranslated, and Sentry answers.
2. **Put a fallback in front of the bridge.** When the bridge is down (crash, rollout with
   `Recreate`, node drain), a load balancer answers `502` / `503`, and a `5xx` may make the SDK
   drop the envelope; a refused connection makes it cache and retry, but the SDK cache is small
   (sentry-cocoa and sentry-java keep 30 envelopes by default). Route the DSN host through a proxy
   that falls back to Sentry directly when the bridge does not answer. Because the bridge is
   transparent, the fallback changes nothing for Sentry; only the ouo copy misses that window.
   nginx:

   ```nginx
   server {
     listen 443 ssl; server_name sentry-bridge.example.com;   # the DSN host
     client_max_body_size 100m;                                # body is buffered, so it can be sent again
     location /api/ {
       proxy_pass http://ouo-sentry-bridge:4320;
       proxy_connect_timeout 2s;
       proxy_read_timeout 35s;                                 # above the bridge's upstream_timeout
       proxy_set_header X-Forwarded-For $remote_addr;          # replace, never append: the rate-limit key
       error_page 502 503 504 = @sentry;                       # only nginx's own errors: the bridge's
     }                                                         # (Sentry's) 5xx answers pass through
     location @sentry {
       proxy_pass https://o123.ingest.sentry.io;               # the production ingest host
       proxy_ssl_server_name on;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     }
   }
   ```

   The bridge location *replaces* `X-Forwarded-For` with the address nginx saw (behind a load
   balancer, `set_real_ip_from` + `real_ip_header X-Forwarded-For` first): with
   `key_from: x_forwarded_for`, `ouoratelimit` keys on the first hop, and an appended header
   leaves that hop to the device (see "Rate limits behind nginx" under "Hybrid").
   The bridge aborts the connection when Sentry itself is unreachable; nginx then tries Sentry
   directly and, if that fails too, answers `502`, which is what the SDK would get from Sentry's
   own load balancer. A request whose answer timed out after Sentry stored it may reach Sentry
   twice; Sentry drops the duplicate by event id.

   If the DSN host is a name you control (recommended), rollback is a DNS or proxy change, not
   an app release.
3. **DSN.** Keep the public key and project id; change only the host (and drop any path prefix:
   the bridge serves `/api/{id}/...` at its root). Mobile SDKs need a valid TLS certificate for that
   host (iOS ATS refuses plain http). Do not use the SDK `tunnel` option: it posts to an arbitrary
   path the bridge does not serve. `upstream` must be the exact ingest host of the original DSN
   (`oNNN.ingest.sentry.io`, `oNNN.ingest.us.sentry.io`, `oNNN.ingest.de.sentry.io` or your
   self-hosted host): regions differ.
4. **Client IP.** The bridge appends the device address to `X-Forwarded-For`. Check one event in
   Sentry after the switch: its user IP and geo must be the device's, not the bridge's. If they are
   the bridge's, the proxy in front of the bridge must pass the client address on.
5. **Upstream timeout.** Keep `upstream_timeout` (default 30 s) below the SDK's own request timeout
   so the SDK gets an aborted connection (and retries) rather than timing out itself.
6. **Mirrors** (a second Sentry, spec section 2b) are optional and can never change the answer to
   the SDK. Watch `ouo_sentry_mirror_requests_total{outcome!="sent"}` for what the mirror missed.

What a production cut-over looks like in the collector config:

```yaml
receivers:
  ouosentry:
    endpoint: 0.0.0.0:4320
    upstream_timeout: 30s
    passthrough_upstream: https://o123.ingest.sentry.io        # same host as `upstream`
    mirror: { queue_bytes: 268435456, timeout: 10s }
    projects:
      - sentry_project_id: "4504"
        public_keys: ["<DSN public key>"]
        upstream: https://o123.ingest.sentry.io
        ouo_project_id: mobile-store
        service_name: mobile-store-ios
        mirrors:
          - name: preview
            upstream: https://sentry-preview.example.com
            sentry_project_id: "2"                              # the preview's project
            public_key: "<preview DSN public key>"
```

**Memory.** The bridge holds each request body while it forwards it (store and forward, up to
`max_request_body_size`, default 100 MiB per request), the translation queue (`translate_queue_bytes`,
default 256 MiB) and the mirror queues (`mirror.queue_bytes`, default 256 MiB), plus the session
state. The `memory_limiter` processor protects the pipelines, not the HTTP handler: size the pod
limit above the two queue budgets plus about 256 MiB, and lower `max_request_body_size` to 20 MiB
for a mobile-only project (replay segments and attachments are far below it; Sentry's own limit
for an attachment is 100 MiB, so anything larger is rejected by Sentry anyway).

## Hybrid: production stays on nginx, the bridge gets a mirror

When production must not depend on the collector at all, keep the existing ingest proxy's
`proxy_pass` to production Sentry exactly as it is and add one nginx `mirror` of the envelope
endpoint to a bridge running with `upstream: none` (it answers `200` at once and queues). The
bridge then sends its own copy to a Preview Sentry (`mirrors`, spec section 2b) and translates
for Loki, Tempo and Mimir. Measured on 2026-11-17
([report](../project/agents/sentry-demo/reports/sentry-hybrid-mirror.html)):

- **nginx couples the client to the mirror.** The client's answer is not delayed, but nginx does
  not read the next request of a keep-alive connection until the mirror subrequest ends, and
  Sentry SDKs reuse their connection. With nginx's default 60 s timeouts a blackholed bridge
  made every request wait 60 s (p50 60.0 s; 8 of 24 clients timed out, 5 of those 8 envelopes had
  reached production anyway, so the SDK's retry duplicates them, and 3 had not). A 2 s slow bridge
  added 2 s to every request. With the timeouts below, a blackholed bridge costs about the read
  timeout (p50 66–77 ms, p99 103–169 ms on the loaded test host) and a refused one costs nothing.
- **`passthrough_upstream` must stay unset** on a mirror-fed bridge: otherwise every mirrored
  envelope of another project on the same ingest host reaches production a second time
  (spec section 2a).
- **One bridge, not a pool.** Hashing nginx's `upstream` on `$remote_addr` (or the first
  `X-Forwarded-For` hop) keeps a device on one bridge only while its address holds: a phone
  moving between Wi-Fi and cellular splits its session from that envelope on (see "What breaks
  with two replicas" below). Hashing on the DSN key is correct but sends a whole app to one
  instance, which is one bridge again. Sentry SDKs send no device or session header nginx could
  hash on; the ids are inside the body. Scale the one bridge up, and give it a `backup` standby
  for a dead primary (not a flapping one: each failover splits sessions between two instances
  with cold state; failover was not measured).
- **Rate limits behind nginx.** Set `client.key_from: x_forwarded_for` on `ouoratelimit`
  (`OUO_RATELIMIT_CLIENT_KEY`); otherwise every device shares the proxy's one client bucket
  (100/s by default) and translation drops past it. Have nginx *replace* the header with the
  address it saw (`$remote_addr`; behind a load balancer, `set_real_ip_from` +
  `real_ip_header X-Forwarded-For` first): appending (`$proxy_add_x_forwarded_for`) keeps the
  device's own value as the first hop, so a device sending a new value each time gets a new
  bucket each time and can drain the project bucket for everyone.

```nginx
upstream ouo_bridge {
    server 127.0.0.1:4320;                # the bridge next to nginx: a dead one refuses at once
    server ouo-bridge-standby:4320 backup;  # for a dead primary, not a flapping one (unmeasured)
    keepalive 16;
    keepalive_timeout 30s;                # below the bridge's idle timeout (1 min)
}
server {
    # ... the existing listen / ssl / server_name and location / { proxy_pass <production> } ...
    client_body_buffer_size 1m;           # the mirror needs the body; keep it in memory
    location ~ ^/api/[0-9]+/envelope/$ {
        mirror /_ouo_mirror;
        mirror_request_body on;           # the default; keep it on: the bridge needs the body
        # ... the same proxy_pass and headers to production as location / ...
    }
    location = /_ouo_mirror {
        internal;
        proxy_pass http://ouo_bridge$request_uri;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $remote_addr;  # replace, never append: the rate-limit key
        proxy_connect_timeout 50ms;       # each bounds what a dead or slow bridge adds
        proxy_send_timeout 100ms;         # to the device's next request on the connection
        proxy_read_timeout 100ms;
        proxy_next_upstream off;          # a lost copy is fine; a retry costs the device time
    }
}
```

The bridge in `upstream: none` mode answers in a few milliseconds, so 100 ms only loses copies
when the bridge stalls; the copies it loses are counted nowhere on the bridge (watch nginx's
error log for `upstream timed out` on `/_ouo_mirror`, or compare Sentry's accepted count with
`ouo_sentry_envelopes_total{outcome="accepted_local"}`). `mirror_request_body on` makes nginx
read the whole body before it proxies to production, which is nginx's default
(`proxy_request_buffering on`) anyway. The production location keeps whatever
`X-Forwarded-For` handling it has today; only the mirror's header feeds the rate limiter.

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
| Session start and end | Still correct (readers keep the last `session.end`); a duplicate is possible |

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
- it exports straight to the chart's Tempo and Loki Services (the main collector
  wants a Basic project credential, which the bridge does not have), with the bridge's own
  `ouoratelimit` and `resource/project` processors.

The manifests below assume the release `ouo` in namespace `ouo` with the bundled LGTM stack
(Services `ouo-tempo`, `ouo-loki`, `ouo-mimir`); adjust the names with `kubectl get svc -n ouo`.
This standalone bridge has no Muninn exporter, so its replay chunks go to the `debug` exporter.
To keep Sentry replays, set `replay_wire: muninn` and route scope `ouo.replay` to Muninn as
`deploy/compose/collector/config.yaml` does (or use the chart's collector, which does both). Replace the
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
        passthrough_upstream: https://o123.ingest.sentry.io   # never lose an unmatched envelope
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
      debug: { verbosity: basic }
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
          processors: [memory_limiter]
          exporters: [debug]
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
          image: ghcr.io/ouo11y/collector:0.5.0    # same tag as the chart's collector
          args: ["--config=/etc/otelcol/config.yaml"]
          ports:
            - { name: sentry, containerPort: 4320 }
          readinessProbe: { httpGet: { path: /, port: 13133 } }
          livenessProbe: { httpGet: { path: /, port: 13133 } }
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { memory: 1Gi }      # queue budgets (2 x 256 MiB) + state + headroom
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
session, `ouo_sentry_envelopes_total{outcome="forwarded"}` grows in Mimir and the session's
events are in Loki.
