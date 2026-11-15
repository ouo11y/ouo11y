# ouo-collector

`ouo-collector` is a custom OpenTelemetry Collector distribution, built with the
[OpenTelemetry Collector Builder (ocb)](https://github.com/open-telemetry/opentelemetry-collector/tree/main/cmd/builder).
It is the only internet-facing ingest of ouo (ADR-0007): browsers, phones and backends send
OTLP (replay chunks included, ADR-0019) to it with a project credential, and apps that use the Sentry SDKs send
their envelopes to it unchanged (ADR-0008). Muninn, Loki, Tempo and Mimir stay
internal.

## What is in the distribution

`builder.yaml` pins every upstream module to **0.160.0** (stable modules 1.66.0), the same
versions as `otel/opentelemetry-collector-contrib:0.160.0`.

| Kind | Components |
|---|---|
| Extensions | `basicauth`, `health_check`, **`ouoauth`**, **`ouoratelimit`** |
| Receivers | `otlp`, **`ouosentry`** |
| Processors | `memory_limiter`, `batch`, `attributes`, `resource`, `transform`, **`ouoratelimit`** |
| Exporters | `otlp_grpc`, `otlp_http`, `debug` |
| Connectors | `routing` (sends replay chunks to Muninn and drops the Sentry bridge's video chunks) |
| Config providers | `env`, `file`, `yaml` |

The components in bold are ours, one Go module each:

```
collector/
  builder.yaml                          ocb manifest (dist name ouo-collector, output ./dist)
  Dockerfile, .dockerignore             image ouo/collector (ghcr.io/ouo11y/collector)
  receiver/ouosentryreceiver/           POST /api/{id}/envelope/ -> forward to Sentry unchanged, then
                                        sessions, errors, spans, logs, replay breadcrumbs and video
                                        replay chunks (ADR-0008)
  tools/sentrytap/                      records Sentry SDK traffic, fakes Sentry, proves byte-identical forwarding
  processor/ouoratelimitprocessor/      token buckets per project and per client; its
    ouoratelimitextension/              sub-package is the receiver middleware sharing them
  extension/ouoauthextension/           wraps basicauth, counts rejected requests
```

The reference configuration is `deploy/compose/collector/config.yaml`; the development
project registry is `deploy/compose/collector/projects.htpasswd` (`demo` /
`pt_dev_demo_0000000000000000` for apps, `internal` / `pt_dev_internal_00000000000000` for
Muninn's and the demo backend's own telemetry; local use only).

## Build

```bash
# Binary (Go 1.26). The builder version must match the pinned components.
go install go.opentelemetry.io/collector/cmd/builder@v0.160.0
cd collector && builder --config builder.yaml          # -> collector/dist/ouo-collector (about 1 minute)
./dist/ouo-collector components                        # lists the components above
./dist/ouo-collector validate --config=../deploy/compose/collector/config.yaml

# Image (from the repository root, collector/ is the build context)
docker build -t ouo/collector:dev collector

# Component tests
for m in receiver/ouosentryreceiver processor/ouoratelimitprocessor extension/ouoauthextension tools/sentrytap; do
  (cd collector/$m && go vet ./... && go test -race ./...)
done
```

The image is distroless (`gcr.io/distroless/static-debian12:nonroot`), entrypoint
`/ouo-collector`, default command `--config=/etc/otelcol/config.yaml`, ports 4317 4318
4320 13133. Mount the config and the htpasswd file into `/etc/otelcol/`.

## Adding the components to another distribution

Each component is an ordinary collector module. In your own ocb manifest:

```yaml
receivers:
  - gomod: github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver v0.0.0
processors:
  - gomod: github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor v0.0.0
replaces:
  # until the modules are tagged, point at a checkout (paths relative to output_path)
  - github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver => /path/to/ouo/collector/receiver/ouosentryreceiver
  - github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor => /path/to/ouo/collector/processor/ouoratelimitprocessor
```

They are built against collector 0.160.0 / 1.66.0; a distribution on another collector
version needs the modules' `go.mod` bumped to the same versions.

### Why `v0.0.0` and `replaces`, not module tags

ocb itself builds from tagged modules without `replaces` (verified 2026-10-23 with local
tags `collector/<kind>/<name>/v0.4.0` and `GOPROXY=direct`, see
`project/kb-archive/collector-components.md`). This repository's own build keeps `v0.0.0` + `replaces`
on purpose:

- A commit must build from its own component sources. With tags, `builder.yaml` names a
  version that only exists after the release is tagged, so a pull request that changes a
  component would build and test the previous release instead, and the release commit
  itself could not build before its own tag.
- The repository is private: `proxy.golang.org` cannot fetch it, so a tag-based build needs
  `GOPRIVATE` and a GitHub token inside the image build.

Module tags only help other distributions that import our components. Once the repository is
public (checklist N20), the release can push `collector/<kind>/<name>/vX.Y.Z` tags next to
`collector-vX.Y.Z` at the same commit, and the manifest above can drop its `replaces`.

## Configuration reference

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
metrics and logs. Over the limit it returns gRPC `ResourceExhausted` with `RetryInfo`
(whole seconds, at least 1): the OTLP receiver answers HTTP 429 + `Retry-After` (gRPC
`RESOURCE_EXHAUSTED`). Self-metric
`ouo_ratelimit_rejected_total{key_kind=project|client}`.

Place it after `memory_limiter` and before `batch` (batch drops the client context).

The OTLP receiver answers an export with no spans, records or data points `200` without
calling the pipeline, so the processor never sees empty requests. The `ouoratelimit`
**extension** closes that gap: it is a receiver middleware (confighttp / configgrpc
`middlewares`, which run after authentication) that takes the request's tokens from the
processor's buckets before the receiver decodes it, answers 429 + `Retry-After` (OTLP
`Status` body in the request's encoding; gRPC `RESOURCE_EXHAUSTED` + `RetryInfo`), and marks
the request so the processor does not charge it again. Receivers without the middleware
(`ouosentry`) are still charged by the processor.

```yaml
extensions:
  ouoratelimit:
    processor: ouoratelimit       # default: the processor whose buckets it shares
receivers:
  otlp:
    protocols:
      http: { middlewares: [{ id: ouoratelimit }], ... }
      grpc: { middlewares: [{ id: ouoratelimit }], ... }
service:
  extensions: [..., ouoratelimit]
```

### `ouoauth` extension

basicauth rejects a bad credential with 401 before any receiver code runs, so no collector
metric counted it. `ouoauth` is a server authenticator that delegates to another one and
counts what it rejects:

```yaml
extensions:
  basicauth/server: { htpasswd: { file: /etc/otelcol/projects.htpasswd } }
  ouoauth:
    authenticator: basicauth/server
receivers:
  otlp: { protocols: { http: { auth: { authenticator: ouoauth } } } }   # same for grpc
service:
  extensions: [basicauth/server, ouoauth, ...]
```

Self-metric `ouo_auth_failures_total{reason, authenticator}`, `reason` one of `missing`
(no `Authorization`), `malformed` (not `Basic`, or not `id:token`), `invalid_credentials`
(wrong token or unknown project), `other`. No project label: on a failure the username is
whatever the client sent. There is no self-observability dashboard folder yet; query it in
Grafana Explore on the Mimir datasource:

```promql
sum by (reason) (rate(ouo_auth_failures_total[5m]))           # 401s per second, by reason
sum by (key_kind) (rate(ouo_ratelimit_rejected_total[5m]))    # 429s per second, by bucket
```

The `ouosentry` receiver authenticates DSN keys itself (403 for unknown keys) and counts
them in `ouo_sentry_envelopes_total`, not here.

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
and spans (logs and traces pipelines) and `kind: "video"` replay chunks; with `replay_wire: muninn` (set in the reference config) they are Muninn chunks that the scope router sends to Muninn. `upstream: none` answers locally instead (cutover). Mapping:
`docs/specs/sentry-bridge.md`; protocol notes: `project/kb-archive/sentry-envelope-format.md`.

```yaml
receivers:
  ouosentry:
    endpoint: 0.0.0.0:4320
    max_request_body_size: 104857600   # raw body; Sentry itself accepts large envelopes
    upstream_timeout: 30s
    max_translate_bytes: 20971520      # bigger envelopes are forwarded, not translated
    translate_queue_size: 10000
    state: { max_sessions: 200000, ttl: 4h, replay_hold: 10m, log_hold: 1m }
    projects:
      - sentry_project_id: "4504"
        public_keys: ["<public key>"]
        upstream: https://o123.ingest.sentry.io   # or none
        ouo_project_id: mobile-store
        service_name: mobile-store-ios
```

`compression_algorithms` is ignored on this receiver: it needs the raw bytes to forward them.
Metrics: `ouo_sentry_envelopes_total`, `ouo_sentry_upstream_duration_seconds`,
`ouo_sentry_items_total`, `ouo_sentry_translate_dropped_total`. **Run it as exactly one
replica**: session correlation state is in memory, and a second replica loses sessions,
replay segments and error counts in ouo (Sentry itself still gets everything). Client-address
affinity does not hold for phones that change networks. What breaks, restarts, and a
one-replica Kubernetes Deployment next to the Helm chart: `docs/sentry-bridge-deployment.md`.

`tools/sentrytap` checks the "as if the bridge were not there" claim on real traffic:

```bash
go run ./tools/sentrytap -listen 127.0.0.1:4411 -dir caps/B -sink                    # fake Sentry
go run ./tools/sentrytap -listen 127.0.0.1:4410 -dir caps/A -forward http://localhost:4320
# point the app DSN at 127.0.0.1:4410, use the app, then:
go run ./tools/sentrytap compare caps/A caps/B    # exit 0: every request arrived byte-identical
```
