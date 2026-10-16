# ADR-0007 The collector is the edge: project tokens, replay receiver, rum-api stays internal

Status: accepted (2026-10-10; revised the same day after review: the first draft put the ingest gateway in rum-api, the founder asked that as much as possible go through the OpenTelemetry Collector and that rum-api stay hidden like every other service)

## Context

In the MVP the browser and mobile SDKs post OTLP straight to a stock OpenTelemetry Collector published with wildcard CORS, and replay chunks to rum-api without any credential. Anyone can push telemetry into the customer's Loki and Tempo, projects cannot be told apart, nothing is rate limited. Vision section 17 asks for an internet-facing ingress that treats every client as untrusted and uses a **public project identifier**, because browser code is readable.

The product principle is OTel-native: the collector is the ingress, every other service is internal. Replay chunks are not observability events (ADR-0003), but they can still travel through the collector as a dedicated stream with their own receiver, pipeline and exporter.

## Decision

1. **A custom collector distribution, `ouo-collector`, is the only internet-facing ingest.** It is built with the OpenTelemetry Collector Builder (ocb) from `collector/builder.yaml`: the upstream OTLP receiver, `basicauth`, `attributes`, `resource`, `transform`, `batch`, `memory_limiter`, the OTLP exporters, `health_check`, plus three components of ours in `collector/`:

   | Component | Kind | Job |
   |---|---|---|
   | `ouoreplay` | receiver | HTTP endpoint `POST /v1/replay/chunks` (own port, default `4319`) built on `confighttp` so it gets the same authenticator, CORS, body limit and TLS options as the OTLP receiver. Validates a chunk (ADR-0003, ADR-0006), stamps `ouo.project.id` from the authenticated username, and emits one log record per chunk (body = chunk bytes, attributes `session.id`, `ouo.replay.seq`, `ouo.replay.kind`, `ouo.replay.encoding`) into a dedicated pipeline. |
   | `ouoreplay` | exporter | Posts each chunk to rum-api's internal `POST /v1/replay/chunks` with `X-Ouo-Project-Id` and an optional shared secret `Authorization: Bearer <OUO_INGEST_TOKEN>`. Retries with the standard exporter helper queue. |
   | `ouoratelimit` | processor | Token-bucket rate limit keyed by the authenticated project (`auth.username`) and by `client.address`, configurable rates and bursts, rejecting over-limit requests with a retryable error so the receiver answers with a retry status. |

   rum-api, Loki, Tempo, Mimir and the demo backend are never exposed. Grafana and the collector are the only public services.

2. **Project token = HTTP Basic credentials.** Every ingest request (OTLP and replay) carries `Authorization: Basic base64("<project id>:<project token>")`. The `basicauth` server authenticator validates it against an htpasswd file (`deploy/docker/collector/projects.htpasswd` locally, a Secret in Kubernetes). The username is the project id, the password is the public token. The hash must be cheap (`{SHA}` or apr1, never bcrypt) because it runs on every request and the token is public by design. A missing or wrong credential is `401`. Rotation is a cut-over in this phase: the upstream `basicauth` extension keeps only the last htpasswd line per username, so two tokens for one project cannot be valid at the same time (found on kind, 2026-10-13). Replace the line, restart the collector, ship the new token to the SDKs; clients still on the old token get `401` until they update. Overlapping rotation needs an ouo authenticator extension that accepts several tokens per project, planned together with per-project origins in a later phase.

   A stock OpenTelemetry SDK works without any ouo code: `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com` and `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>`.

3. **Project stamping in the collector.** With `include_metadata: true` on the receivers, a `resource` processor (or `attributes` where the resource processor cannot read context) inserts `ouo.project.id` from `auth.username` on traces, logs and metrics, overwriting any client-supplied value. The replay receiver stamps it directly from the auth context. Downstream isolation keys on this attribute.

4. **Limits at the collector.** `max_request_body_size` on both receivers (OTLP default 4 MiB, replay default 8 MiB), `ouoratelimit` per project (default 1000 requests per second, burst 5000) and per client address (default 100 per second, burst 300), `memory_limiter` as backpressure. Origin control is CORS on both receivers with a global allowed-origins list (the union of all projects' origins); per-project origin rules are not enforced at the collector in this phase.

5. **rum-api is internal.** It keeps `POST /v1/replay/chunks` as the sink for the replay exporter only: it requires `X-Ouo-Project-Id` (recorded in the chunk `meta.json`) and, when `OUO_INGEST_TOKEN` is set, the matching bearer. The read API keeps `OUO_READ_TOKEN` (Grafana's plugin proxy injects it from `secureJsonData`, the browser never sees it). rum-api has no OTLP endpoints, no project registry and no CORS for untrusted origins.

6. **SDK configuration (breaking, SDKs 0.2.0).**

   ```ts
   initRUM({
     endpoint: "https://otel.example.com",      // collector OTLP/HTTP base: /v1/traces, /v1/logs
     replayEndpoint: "https://otel.example.com", // optional; defaults to endpoint with port 4319 when endpoint uses port 4318, else endpoint itself
     projectId: "web-store",
     projectToken: "pt_live_9f3c...",
     service: { name: "web-store", version: "1.4.2", environment: "production" },
   });
   ```

   Replay chunks go to `${replayEndpoint}/v1/replay/chunks`. Both SDKs and the Swift `OuoReplay` uploader send the Basic credential on every request.

7. **Exposure.** Docker Compose publishes the collector's `4318` (OTLP/HTTP) and `4319` (replay) on all interfaces and nothing else from the data plane; `4317` gRPC stays on loopback for local backend development. The VM path puts Caddy in front: `otel.<domain>` routes `/v1/replay/*` to 4319 and everything else to 4318. Kubernetes: a Service with both ports and an Ingress for the collector; rum-api is ClusterIP only.

8. **Telemetry.** The collector's own metrics (`otelcol_receiver_accepted_*`, `otelcol_receiver_refused_*`, `otelcol_exporter_*`, plus `ouo_ratelimit_rejected_total` and `ouo_replay_chunks_total` from our components) are scraped into Mimir. rum-api keeps `ouo.replay.chunks` and `ouo.replay.bytes`.

## Consequences

- One ingress to secure, scale and document, and it is the standard one. Customers with an existing collector fleet can run `ouo-collector` next to it or add our three components to their own distribution.
- Building a custom distribution means we own a Docker image and an ocb manifest; the CI builds it per release. Versions of upstream components are pinned in the manifest.
- Basic auth on every request costs one cheap hash; bcrypt would not be acceptable at ingest rates.
- Per-project origin allowlists and per-project quotas move to a later phase (a small authenticator extension of ours can replace `basicauth` when needed). CORS stays global.
- Every SDK consumer updates three lines (`endpoint`, `projectId`, `projectToken`). The demo apps, the fast-tracked guides, smoke and e2e change accordingly.
- The first draft's rum-api gateway (`/ingest/otlp/*`, project registry, rum-api rate limiter) is removed in the same PR; nothing of it was released.
