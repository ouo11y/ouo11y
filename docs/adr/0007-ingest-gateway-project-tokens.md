# ADR-0007 Ingest gateway and project tokens

Status: accepted (2026-10-10), Phase 8a

## Context

In the MVP the browser and mobile SDKs post OTLP straight to the OpenTelemetry Collector, which is published on the host with wildcard CORS, and replay chunks to rum-api without any credential. That is fine on a laptop and unacceptable in front of real users: anyone can push arbitrary telemetry into the customer's Loki and Tempo, there is no way to tell projects apart, no rate limiting, and no size accounting. Vision section 17 asks for an internet-facing gateway that treats every client as untrusted and uses a **public project identifier**, not a secret, because browser code is readable by anyone.

## Decision

1. **rum-api is the only endpoint untrusted clients talk to.** It gains OTLP/HTTP ingest routes and forwards validated payloads to the collector. The collector is reachable only from inside the deployment (trusted backend services keep sending to it directly).

   | Route | Body | Notes |
   |---|---|---|
   | `POST /ingest/otlp/v1/traces` | OTLP `ExportTraceServiceRequest` | protobuf (`application/x-protobuf`) or JSON (`application/json`); `Content-Encoding: gzip` accepted |
   | `POST /ingest/otlp/v1/logs` | OTLP `ExportLogsServiceRequest` | same |
   | `POST /ingest/otlp/v1/metrics` | OTLP `ExportMetricsServiceRequest` | same |
   | `POST /v1/replay/chunks` | replay chunk (ADR-0003, ADR-0006) | unchanged body, now authenticated |

   The base path `/ingest/otlp` is deliberate: a stock OpenTelemetry SDK configured with `OTEL_EXPORTER_OTLP_ENDPOINT=https://rum.example.com/ingest/otlp` and `OTEL_EXPORTER_OTLP_HEADERS=X-Ouo-Project-Token=<token>` works without any ouo code.

2. **Project token.** Every ingest request carries `X-Ouo-Project-Token: <token>`. The token identifies a project; it is public by nature and grants nothing but the right to write telemetry into that project under the limits below. Missing or unknown token: `401`. Tokens are opaque strings; rotation is supported by listing several tokens per project.

3. **Project registry.** Phase 8a reads projects from a YAML file (`OUO_PROJECTS_FILE`), with a single-project fallback from environment variables for simple installs. Postgres replaces the file in Phase 11 behind the same interface.

   ```yaml
   projects:
     - id: web-store            # becomes resource attribute ouo.project.id
       name: Web store
       tokens: [pt_live_9f3c..., pt_prev_...]
       allowed_origins: ["https://shop.example.com", "https://*.preview.example.com", "http://localhost:*"]
       rate_limit: { requests_per_second: 500, burst: 2000 }   # per project, optional
       max_body_bytes: 4194304                                   # optional
   ```

   Environment fallback when the file is absent: `OUO_PROJECT_ID` (default `default`), `OUO_PROJECT_TOKEN` (required), `OUO_ALLOWED_ORIGINS` (comma separated patterns). rum-api refuses to start with no project configured; there is no "auth off" mode.

4. **Checks, in order, on every ingest request.** Each rejection is counted with its reason.
   1. Body size against the project limit or the default (`OUO_MAX_INGEST_BYTES`, default 4 MiB; replay chunks keep their own limits): `413`.
   2. Token present and known: `401`.
   3. `Origin` header, when present, matches one of the project's allowed origin patterns: `403`. Requests without `Origin` (mobile, server-side) pass this check. Patterns are `scheme://host[:port]` where `*` may replace the leading host label or the port.
   4. Rate limit: a token bucket per project (defaults `OUO_RATE_LIMIT_RPS=1000`, `OUO_RATE_LIMIT_BURST=5000`) and a token bucket per client IP (`OUO_IP_RATE_LIMIT_RPS=100`, `OUO_IP_RATE_LIMIT_BURST=300`): `429` with `Retry-After`. The client IP comes from the connection unless `OUO_TRUST_PROXY=true`, in which case the last `X-Forwarded-For` hop is used.
   5. The body decodes as the OTLP message for the route: `400`.
   6. The resource attribute `ouo.project.id` is **set by rum-api** on every resource in the payload, overwriting whatever the client sent. Downstream, project isolation keys on this attribute.
   7. The payload is re-encoded as protobuf and forwarded to `OUO_COLLECTOR_OTLP_ENDPOINT` (default `http://otel-collector:4318`) with a timeout. The collector's status and OTLP response body are passed back; collector unavailability is `502`.

5. **CORS at rum-api, per project.** Preflights carry no token, so a preflight is answered for an origin if any configured project allows that origin. Allowed headers include `X-Ouo-Project-Token`, `Content-Type`, `Content-Encoding`, `traceparent`, `baggage` and the replay headers.

6. **Read side.** When `OUO_READ_TOKEN` is set, every `GET /v1/*` and `DELETE /v1/*` requires `Authorization: Bearer <read token>`; `GET /healthz` and `GET /readyz` stay open. The Grafana plugin stores the read token in `secureJsonData.readToken` and its route proxy adds the header, so the token never reaches the browser. In the compose stack the token is set in `.env` and provisioned.

7. **SDK configuration changes (breaking, SDKs go to 0.2.0).** `endpoint` becomes the rum-api base URL and `projectToken` is required. The SDK derives `${endpoint}/ingest/otlp/v1/{traces,logs}` and `${endpoint}/v1/replay/chunks` and sends the token header on all of them. `replayEndpoint` is removed. An escape hatch `otlpEndpoint` lets a trusted in-network app bypass rum-api for OTLP.

   ```ts
   initRUM({
     endpoint: "https://rum.example.com",
     projectToken: "pt_live_9f3c...",
     service: { name: "web-store", version: "1.4.2", environment: "production" },
   });
   ```

8. **Collector exposure.** In Docker Compose the OTLP ports bind to `127.0.0.1` only and the browser CORS block is removed from the receiver. In Kubernetes the collector is a ClusterIP service. Only rum-api (and Grafana) are exposed.

9. **Ingest telemetry.** rum-api records OTel metrics through its existing exporter: `ouo.ingest.requests` (attributes `ouo.project.id`, `signal`, `outcome`, `reason`), `ouo.ingest.bytes` (received, decompressed), `ouo.replay.chunks` and `ouo.replay.bytes`. Phase 8c builds the platform dashboards on these.

## Consequences

- Every SDK consumer updates two lines (`endpoint`, `projectToken`); the demo apps, the fast-tracked guides and the e2e scenario change accordingly.
- rum-api decodes every OTLP payload. That costs CPU per request but gives schema validation and project stamping, both of which the product needs. The proto packages (`go.opentelemetry.io/proto/otlp`, `google.golang.org/protobuf`) are the only new dependencies.
- The replay store does not change layout in this phase; chunks record `project_id` in `meta.json` so Phase 8b can delete by project and Phase 11 can partition.
- A compromised token lets an attacker write junk into one project, bounded by the rate and size limits, exactly as with every RUM vendor's public key. Rotation is a config change.
- Smoke and e2e scripts must present the token; `deploy/docker/.env.example` ships a development token that is clearly marked as such.
