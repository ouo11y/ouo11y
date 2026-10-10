# Ingest gateway: OTLP decode / re-encode in Go, OTLP/JSON gotchas, rate limiter

Question: what does an OTLP/HTTP gateway written with the standard library plus
`go.opentelemetry.io/proto/otlp` need to get right? Written while implementing ADR-0007 in
`services/rum-api/internal/ingest` (Phase 8a). Package docs: `services/rum-api/README.md`.

## OTLP/JSON is not protojson for ids

- The OTLP spec encodes `traceId`, `spanId` and `parentSpanId` as **hex** strings in JSON.
  `protojson` decodes every `bytes` field as **base64**. A 32-char hex trace id is also
  valid base64 (length is a multiple of 4), so `protojson.Unmarshal` silently turns it into
  24 wrong bytes; the collector then stores a trace id nobody can look up. Fix used: decode
  the JSON generically, rewrite values under the keys `traceId` / `trace_id`, `spanId` /
  `span_id`, `parentSpanId` / `parent_span_id` (span `links` and log records included) from
  hex to base64 when they are hex of length 32 / 16, re-marshal, then `protojson`. Base64
  of 16 / 8 bytes is 24 / 12 chars, so the length test never misfires on an already
  base64 value. `AnyValue.bytesValue` stays base64 (spec and protojson agree there).
- Decode with `json.Decoder.UseNumber()`: `startTimeUnixNano` from the JS SDK is a string,
  but a numeric 1.79e18 nanosecond timestamp as `float64` loses the low digits. `json.Number`
  round-trips the literal and protojson accepts 64-bit integers as strings or numbers.
- `protojson.UnmarshalOptions{DiscardUnknown: true}`: SDKs newer than the proto module may
  send fields it lacks (and the JS SDK sends `droppedAttributesCount` style fields on every
  object). Consequence: a trace payload posted to the logs route decodes to an *empty* logs
  export and is forwarded as such (200), not a 400. Accepted trade-off.
- protojson accepts enums as numbers (`"kind":3`) or names and camelCase or original
  field names, so the JS SDK and `protojson.Marshal` output both parse.
- Checked `camelCase` vs `snake_case` key handling by posting the real JS SDK shape in a test
  (`jsSDKTrace` in `gateway_test.go`).

## Responses

- OTLP/HTTP says the response uses the request's encoding. rum-api always sends protobuf to
  the collector, so a JSON client would otherwise get protobuf back. The collector's 2xx
  body is an `Export*ServiceResponse` (the real collector always sets an empty
  `partialSuccess`, so JSON clients see `{"partialSuccess":{}}`), non-2xx bodies are
  `google.rpc.Status`; both are transcoded with `protojson.Marshal` for JSON clients.
  `google.golang.org/genproto/googleapis/rpc/status` is already in the module graph via
  grpc-gateway.
- Pass `Retry-After` through when the collector sets it (memory limiter / queue full
  return 503 with it).

## Stamping

- `ResourceSpans.Resource` may be nil in a valid payload; create it before appending the
  attribute. Filter out any client-sent `ouo.project.id` first so there is exactly one.
- `proto.MarshalOptions{Deterministic: true}` keeps the forwarded bytes stable for tests.
- The proto packages (`collector/trace/v1` etc.) import grpc and grpc-gateway because the
  generated files include the gRPC service and gateway stubs; both were already indirect
  dependencies of the OTLP exporters, so no new module appears.

## Check order and sizes

- Size must beat token (413 before 401) but the project's `max_body_bytes` needs the
  project. Resolution: look the token up first *without rejecting*, compute the limit, check
  `Content-Length`, then reject on the token. Bodies without `Content-Length` (chunked) hit
  the limit in `http.MaxBytesReader` after authentication, still 413.
- Gzip: the limit applies to both the wire bytes (`MaxBytesReader`) and the inflated bytes
  (`io.LimitReader(gr, limit+1)` then compare), otherwise a 4 MiB limit admits a 4 GiB
  zip bomb. Same pattern as the replay upload.
- Replay uploads reuse checks 1 to 4 through `Gateway.Authorize(w, r, "replay", limit)` and
  keep their own body handling (the rrweb / frames split needs the decompressed body).

## Rate limiter

- Plain token bucket per key: `tokens = min(burst, tokens + elapsed*rate)`, take one,
  `Retry-After = ceil((1 - tokens) / rate)` seconds (never 0). A clock function is injected
  so tests advance time instead of sleeping.
- Idle buckets: a bucket idle for `burst / rate` seconds is full again, which is exactly a
  fresh bucket, so a sweep that deletes those changes nothing observable. The sweep runs
  inline from `Allow` at most once per minute (no background goroutine, nothing to stop on
  shutdown, deterministic in tests).
- Per-project limiters are separate `Limiter` instances (project `rate_limit` overrides),
  the per-IP limiter is one instance keyed by IP across projects. Rejections before the
  rate check (size, token, origin) do not consume a token.
- Client IP: `net.SplitHostPort(r.RemoteAddr)`; with `OUO_TRUST_PROXY=true` the **last**
  `X-Forwarded-For` entry (the one the trusted proxy appended; the first entry is client
  controlled). Without the flag the header is ignored entirely.
- Limits are per process. With N replicas the effective limit is N times the configured one.

## CORS per project

- Preflights carry no custom headers, so the token cannot identify the project; the answer
  is "any project allows this origin". The per-project Origin check then runs on the
  actual request (403 when the token's project does not list it).
- Returning 403 for a disallowed preflight (instead of letting it fall through to a 404 /
  405) makes the failure visible in the browser network tab.
- `Access-Control-Expose-Headers: Retry-After` is needed or the browser SDK cannot read
  the back-off hint on 429.
- Origin patterns: parse both sides into `scheme / host / port`, lower-case, fold default
  ports, tolerate a trailing slash. `*` is allowed only as the whole leading label
  (`https://*.preview.example.com` matches exactly one label) or as the port
  (`http://localhost:*`). `Origin: null` (sandboxed iframes, file://) never matches.

## Read token

- `Authorization: Bearer <token>` compared with `crypto/subtle.ConstantTimeCompare`; the
  scheme is case-insensitive. Applied to `GET`, `HEAD`, `DELETE` under `/v1/`, which leaves
  `POST /v1/replay/chunks` (project token), `/ingest/*`, probes and `OPTIONS` alone.

## Verified

- `go test ./...` in `services/rum-api` (fake collector asserting the forwarded protobuf).
- Live: OTLP/JSON trace with hex ids posted to a local binary on `:18080`, forwarded to the
  collector on `:4328`, found in Tempo on `:3201` by id with `ouo.project.id=demo` about
  30 s later (TraceQL search lagged behind the by-id lookup). Details in
  `agents/rum-api/summaries/2026-10-10-phase-8a.md`.
