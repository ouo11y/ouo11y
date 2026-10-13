# ouo-collector

`ouo-collector` is a custom OpenTelemetry Collector distribution, built with the
[OpenTelemetry Collector Builder (ocb)](https://github.com/open-telemetry/opentelemetry-collector/tree/main/cmd/builder).
It is the only internet-facing ingest of ouo (ADR-0007): browsers, phones and backends send
OTLP and replay chunks to it with a project credential, and apps that use the Sentry SDKs send
their envelopes to it unchanged (ADR-0008). rum-api, Loki, Tempo and Mimir stay
internal.

## What is in the distribution

`builder.yaml` pins every upstream module to **0.160.0** (stable modules 1.66.0), the same
versions as `otel/opentelemetry-collector-contrib:0.160.0`.

| Kind | Components |
|---|---|
| Extensions | `basicauth`, `health_check` |
| Receivers | `otlp`, **`ouoreplay`**, **`ouosentry`** |
| Processors | `memory_limiter`, `batch`, `attributes`, `resource`, `transform`, **`ouoratelimit`** |
| Exporters | `otlp_grpc`, `otlp_http`, `debug`, **`ouoreplay`** |
| Connectors | `routing` (sends the Sentry bridge's replay chunks to the replay pipeline) |
| Config providers | `env`, `file`, `yaml` |

The components in bold are ours, one Go module each:

```
collector/
  builder.yaml                          ocb manifest (dist name ouo-collector, output ./dist)
  Dockerfile, .dockerignore             image ouo/collector (ghcr.io/ziadmansourm/ouo/collector)
  receiver/ouoreplayreceiver/           POST /v1/replay/chunks -> one log record per chunk
  receiver/ouosentryreceiver/           POST /api/{id}/envelope/ -> forward to Sentry unchanged, then
                                        sessions, errors, spans and video replay chunks (ADR-0008)
  tools/sentrytap/                      records Sentry SDK traffic, fakes Sentry, proves byte-identical forwarding
  exporter/ouoreplayexporter/           log record -> rum-api POST /v1/replay/chunks
  processor/ouoratelimitprocessor/      token buckets per project and per client
```

The reference configuration is `deploy/docker/collector/config.yaml`; the development
project registry is `deploy/docker/collector/projects.htpasswd` (`demo` /
`pt_dev_demo_0000000000000000`, local use only).

## Build

```bash
# Binary (Go 1.26). The builder version must match the pinned components.
go install go.opentelemetry.io/collector/cmd/builder@v0.160.0
cd collector && builder --config builder.yaml          # -> collector/dist/ouo-collector (about 1 minute)
./dist/ouo-collector components                        # lists the components above
./dist/ouo-collector validate --config=../deploy/docker/collector/config.yaml

# Image (from the repository root, collector/ is the build context)
docker build -t ouo/collector:dev collector

# Component tests
for m in receiver/ouoreplayreceiver receiver/ouosentryreceiver exporter/ouoreplayexporter processor/ouoratelimitprocessor tools/sentrytap; do
  (cd collector/$m && go vet ./... && go test -race ./...)
done
```

The image is distroless (`gcr.io/distroless/static-debian12:nonroot`), entrypoint
`/ouo-collector`, default command `--config=/etc/otelcol/config.yaml`, ports 4317 4318
4319 4320 13133. Mount the config and the htpasswd file into `/etc/otelcol/`.

## Adding the components to another distribution

Each component is an ordinary collector module. In your own ocb manifest:

```yaml
receivers:
  - gomod: github.com/ZiadMansourM/ouo/collector/receiver/ouoreplayreceiver v0.0.0
processors:
  - gomod: github.com/ZiadMansourM/ouo/collector/processor/ouoratelimitprocessor v0.0.0
exporters:
  - gomod: github.com/ZiadMansourM/ouo/collector/exporter/ouoreplayexporter v0.0.0
replaces:
  # until the modules are tagged, point at a checkout (paths relative to output_path)
  - github.com/ZiadMansourM/ouo/collector/receiver/ouoreplayreceiver => /path/to/ouo/collector/receiver/ouoreplayreceiver
  - github.com/ZiadMansourM/ouo/collector/processor/ouoratelimitprocessor => /path/to/ouo/collector/processor/ouoratelimitprocessor
  - github.com/ZiadMansourM/ouo/collector/exporter/ouoreplayexporter => /path/to/ouo/collector/exporter/ouoreplayexporter
```

They are built against collector 0.160.0 / 1.66.0; a distribution on another collector
version needs the modules' `go.mod` bumped to the same versions.

## Configuration reference

### `ouoreplay` receiver

```yaml
receivers:
  ouoreplay:
    endpoint: 0.0.0.0:4319              # default 0.0.0.0:4319
    max_request_body_size: 8388608      # default 8 MiB; applies to the body before and after gzip
    max_rrweb_chunk_bytes: 4194304      # default 4 MiB; larger bodies only when kind is "frames"
    include_metadata: true
    auth: { authenticator: basicauth/server }
    cors:
      allowed_origins: [http://localhost:*]
      allowed_headers: [Authorization, Content-Type, Content-Encoding, X-Ouo-Session-Id, X-Ouo-Seq]
    # every other confighttp server key works too: tls, read_timeout, compression_algorithms, ...
```

`POST /v1/replay/chunks`, body gzip (`Content-Encoding: gzip`) or plain JSON. The chunk is
validated with the rules of rum-api (`services/rum-api/internal/replay/parse.go`): rrweb
chunks `{session_id, seq, events, ...}` and `kind: "frames"` chunks
(`docs/specs/mobile-replay.md`). The project id is `client.Info.Auth` attribute `username`
set by `basicauth`.

| Status | When |
|---|---|
| 202 `{"accepted":1, "session_id", "kind", "seq", "events", "frames", "touches", "bytes"}` | queued for the exporter |
| 400 | invalid chunk, bad gzip |
| 401 + `WWW-Authenticate` | no or wrong credential (from `basicauth`; the handler also refuses a request without an authenticated project) |
| 403 | the authenticated project id does not match `^[a-z0-9][a-z0-9._-]{0,63}$` (rum-api would refuse it) |
| 405 | not POST |
| 413 | body above `max_request_body_size`, or an rrweb chunk above `max_rrweb_chunk_bytes` |
| 429 + `Retry-After` | `ouoratelimit` rejected it (gRPC ResourceExhausted with RetryInfo) |
| 503 + `Retry-After: 1` | other retryable pipeline error (memory limiter, full sending queue) |
| 500 | permanent pipeline error |

Each chunk becomes one log record: body = the decompressed chunk JSON as bytes, timestamp =
`started_at`, attributes `ouo.project.id`, `session.id`, `ouo.replay.seq` (int),
`ouo.replay.kind` (`rrweb` or `frames`), `ouo.replay.encoding` (`json`); resource
`service.name=ouo-replay`, `ouo.project.id`. Self-metric `ouo_replay_chunks_total{ouo_project_id,
ouo_replay_kind, outcome=accepted|rejected|throttled|failed, reason}`.

### `ouoreplay` exporter

```yaml
exporters:
  ouoreplay:
    endpoint: http://rum-api:8080       # default; rum-api base URL, /v1/replay/chunks is appended
    ingest_token: ${env:OUO_INGEST_TOKEN}   # optional, sent as Authorization: Bearer
    timeout: 30s                        # default 30s (confighttp client timeout per request)
    compression: gzip                   # default gzip
    sending_queue: { enabled: true, queue_size: 1000 }   # exporterhelper defaults otherwise
    retry_on_failure: { enabled: true, max_elapsed_time: 5m }
```

One `POST` per log record with `Content-Type: application/json`, `X-Ouo-Project-Id`
(record attribute, else resource attribute `ouo.project.id`), `X-Ouo-Session-Id`,
`X-Ouo-Seq`. 2xx is success; 4xx is permanent (dropped, logged); 429 and 503 are retried
honouring `Retry-After`; other 5xx and network errors are retried. In a batch, the records
after a retryable failure are the only ones retried.

### `ouoratelimit` processor

```yaml
processors:
  ouoratelimit:
    project: { rate: 1000, burst: 5000 }    # defaults; per auth.username; rate 0 disables
    client:  { rate: 100, burst: 300, key_from: address }   # defaults; rate 0 disables
    idle_timeout: 10m                       # default; idle buckets are dropped
```

One token per call (= per incoming request when it runs before `batch`). Both buckets must
have a token or none is taken. `key_from: address` keys on `client.Info.Addr` (the TCP
peer); `key_from: x_forwarded_for` keys on the first `X-Forwarded-For` hop and needs
`include_metadata: true` on the receiver; use it only behind a proxy that sets the header
(Caddy in `deploy/vm`), otherwise clients pick their own key. All instances with the same
component id share one set of buckets, so the limits are per request across traces, logs,
metrics and replay. Over the limit it returns gRPC `ResourceExhausted` with `RetryInfo`
(whole seconds, at least 1): the OTLP receiver answers HTTP 429 + `Retry-After` (gRPC
`RESOURCE_EXHAUSTED`), the replay receiver 429 + `Retry-After`. Self-metric
`ouo_ratelimit_rejected_total{key_kind=project|client}`.

Place it after `memory_limiter` and before `batch` (batch drops the client context).

## Sentry SDK bridge (`ouosentry`)

Apps instrumented with the Sentry mobile SDKs change only the host of their DSN:

```
before: https://<public_key>@o123.ingest.sentry.io/4504
after:  https://<public_key>@otel.example.com:4320/4504
```

The receiver serves `POST /api/{project_id}/envelope/`. It authenticates the DSN public key
against its project table (unknown keys are `403` and never forwarded), forwards the raw
request bytes to the project's upstream Sentry, and returns Sentry's status, headers
(`X-Sentry-Rate-Limits`, `Retry-After`) and body unchanged. When Sentry cannot be reached it
aborts the connection, so the SDK keeps the envelope and retries exactly as if Sentry were down.
Envelopes Sentry accepted are translated off the request path into session events, exceptions
and spans (logs and traces pipelines) and `kind: "video"` replay chunks (routed to the replay
pipeline). `upstream: none` answers locally instead (cutover). Mapping:
`docs/specs/sentry-bridge.md`; protocol notes: `kb/sentry-envelope-format.md`.

```yaml
receivers:
  ouosentry:
    endpoint: 0.0.0.0:4320
    max_request_body_size: 104857600   # raw body; Sentry itself accepts large envelopes
    upstream_timeout: 30s
    max_translate_bytes: 20971520      # bigger envelopes are forwarded, not translated
    translate_queue_size: 10000
    state: { max_sessions: 200000, ttl: 4h, replay_hold: 10m }
    projects:
      - sentry_project_id: "4504"
        public_keys: ["<public key>"]
        upstream: https://o123.ingest.sentry.io   # or none
        ouo_project_id: mobile-store
        service_name: mobile-store-ios
```

`compression_algorithms` is ignored on this receiver: it needs the raw bytes to forward them.
Metrics: `ouo_sentry_envelopes_total`, `ouo_sentry_upstream_duration_seconds`,
`ouo_sentry_items_total`, `ouo_sentry_translate_dropped_total`. Run it as a single replica
(or with client-address affinity): session correlation state is in memory.

`tools/sentrytap` checks the "as if the bridge were not there" claim on real traffic:

```bash
go run ./tools/sentrytap -listen 127.0.0.1:4411 -dir caps/B -sink                    # fake Sentry
go run ./tools/sentrytap -listen 127.0.0.1:4410 -dir caps/A -forward http://localhost:4320
# point the app DSN at 127.0.0.1:4410, use the app, then:
go run ./tools/sentrytap compare caps/A caps/B    # exit 0: every request arrived byte-identical
```
