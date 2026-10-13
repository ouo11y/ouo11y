# Custom collector components and the ouo-collector distribution

Status: filled in Phase 8a revision 2 by the collector agent (2026-10-13). Everything below was
checked against the 0.160.0 sources in the Go module cache and, where marked "observed", on the
built `ouo/collector:dev` image running standalone.

## Question

How do we build an OpenTelemetry Collector distribution with our own receiver, exporter and
processor (ADR-0007), authenticate every request with a project token, stamp the project on
all telemetry, and rate limit per project and per client, without surprises from ocb,
basicauth, confighttp or the OTLP receiver?

## ocb (OpenTelemetry Collector Builder)

- **The builder version decides the `otelcol` version.** The generated `go.mod` requires
  `go.opentelemetry.io/collector/otelcol <builder's DefaultBetaOtelColVersion>` whatever the
  manifest says. Observed: builder v0.162.0 on our 0.160.0 manifest does not refuse, it
  silently generates `otelcol v0.162.0`, `component v1.68.0` next to `otlpreceiver v0.160.0`
  (a mixed build). Use `go install go.opentelemetry.io/collector/cmd/builder@v0.160.0` for a
  0.160.0 component set; bump builder and every `gomod:` line together.
- Module versions for a release: run the stock image's `otelcol-contrib components`; it prints
  every module with its exact version. Beta modules are `v0.160.0`, stable ones (`confmap`
  providers, `component`, `pdata`, `client`, `config*` except `confighttp`) are `v1.66.0`.
- Local modules: either `path:` on the component (ocb writes the `replace`) or a `gomod: ...
  v0.0.0` line plus a `replaces:` entry. `replaces` paths are written verbatim into
  `<output_path>/go.mod`, so they are relative to **output_path** (`../receiver/...` from
  `collector/dist`), not to the manifest. Copying the manifest elsewhere breaks them.
- ocb runs `go mod tidy -compat=1.25` and `go build -trimpath` with `CGO_ENABLED=0` by default;
  `GOOS`/`GOARCH` in the environment are honoured, which is how the Dockerfile cross-compiles
  from `$BUILDPLATFORM` (no Go compiler under QEMU for arm64).
- A full build from a cold cache takes about 1 minute on an M-series Mac (44 MB binary), about
  2 minutes in Docker with BuildKit cache mounts; the image is 62 MB on distroless static.
- Our component modules must require exactly the collector's versions. `go mod tidy` in a
  component module happily resolves a missing collector package to the **latest** (it pulled
  `consumererror v0.162.0`, `pdata v1.68.0`); after every tidy run
  `grep -E 'collector/[a-z/]+ v' go.mod | grep -v 'v0.160.0\|v1.66.0'` and pin with
  `go get <module>@v0.160.0`.

## confighttp pitfalls

- **Never embed `confighttp.ServerConfig` / `ClientConfig` anonymously in a component config.**
  Both have an `Unmarshal(*confmap.Conf)` method (keepalive migration). Anonymous embedding
  promotes it to the parent, confmap calls it for the whole component config, and it decodes
  only the confighttp part with `WithIgnoreUnused`: every sibling key is dropped silently.
  Observed: `ingest_token`, `sending_queue`, `retry_on_failure` and `max_rrweb_chunk_bytes`
  were ignored, the exporter sent no bearer. Upstream uses a named field
  `ClientConfig confighttp.ClientConfig \`mapstructure:",squash"\``; do the same, and keep a
  test that loads the config through `confmap.NewFromStringMap(...).Unmarshal(cfg)`.
- Handler order built by `ToServer` (outermost first): clientInfo (sets `client.Info.Addr`,
  and `Metadata` when `include_metadata: true`), otelhttp, response headers, CORS, auth,
  body-size interceptor, decompressor, middlewares, your handler. So: auth runs before the
  body is read (a 5 MiB body without credentials is 401, not 413), CORS preflights are
  answered without auth, and `r.Body` reaching the handler is already decompressed and capped
  at `max_request_body_size` (also after decompression: a 9 KiB gzip that inflates to 9 MiB
  hits the cap, observed 413 in our receiver).
- Default decoders: `""`, `gzip`, `zstd`, `zlib`, `snappy`, `deflate`. `identity` is **not**
  accepted (400 "unsupported Content-Encoding"); add `confighttp.WithDecoder("identity", ...)`.
- `WithErrorHandler(fn)` receives the 401 from auth and the 400 from the decompressor; use it to
  keep a JSON error shape. `max_request_body_size` <= 0 becomes 20 MiB inside `ToServer`.
- CORS is `rs/cors` v1.11.1 with `AllowCredentials: true`. A preflight is answered 204 even
  for a refused origin, just without `Access-Control-Allow-Origin`. The browser sends
  `Access-Control-Request-Headers` lowercase and **sorted**; rs/cors rejects an unsorted list,
  so a hand-written curl preflight must sort it (`authorization,content-encoding,content-type`).
  `exposed_headers: [Retry-After]` lets browser JS read the throttling delay.
- `allowed_origins: ${env:OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}` works:
  confmap's decoder has `StringToSliceHookFunc(",")`, so a comma-separated env value (no
  spaces) becomes the list, and the `:-` default may contain colons. Observed with
  `OUO_ALLOWED_ORIGINS=https://app.example.com,http://localhost:*`.

## basicauth extension (0.160.0)

- Server mode reads `htpasswd.file` and/or `htpasswd.inline` once at start (no reload; restart
  the collector after editing the file). On success `client.Info.Auth` has attributes
  `username` and `raw`.
- Hash formats (`github.com/tg123/go-htpasswd` v1.2.5, `DefaultSystems`): apr1 / `$1$` MD5,
  `{SHA}`, bcrypt, `{SSHA}`, crypt SHA-256/512 (`$5$`/`$6$`) and **plain text** (last, accepts
  anything). We use `{SHA}` (`htpasswd -nbs id token`, or
  `printf '%s:{SHA}%s\n' id "$(printf '%s' token | openssl dgst -binary -sha1 | openssl base64)"`):
  one SHA-1 per request, negligible. bcrypt would cost tens of milliseconds of CPU per request
  at the default cost; the token is public by design, so a slow hash buys nothing.
- **There are no comments in htpasswd.** Every non-blank line is split at the first `:`. A line
  without a colon is silently skipped (no logger is passed), so `# text` works as a comment
  only while it contains no colon. `# note: x` becomes user `# note` with the **plain-text**
  password ` x`. Our committed file keeps its comment lines colon-free and says so.
- Missing header: `no basic auth provided`; wrong token: `invalid credentials`; both 401 (gRPC
  `Unauthenticated`).

## Project stamping (`from_context`)

- The `resource` processor shares `attraction` with `attributes`, and passes the request
  context, so `from_context: auth.username` works on resources. Supported keys: `auth.<attr>`
  (string or []string), `metadata.<header>` (needs `include_metadata: true`), `client.address`,
  and a bare key falls back to metadata.
- When the context has no value, `upsert` does nothing and the client's value survives. The
  config therefore runs `delete` then `upsert from_context` on `ouo.project.id`. Observed: a
  span sent with `ouo.project.id=spoofed` arrives with `ouo.project.id: Str(demo)`.
- Everything reading the client context (resource/project, ouoratelimit) must run before
  `batch`, which drops it (unless `metadata_keys` is set).

## OTLP receiver error-to-status mapping (0.160.0)

`internal/errors.GetStatusFromError` then `GetHTTPStatusCodeFromStatus`:

| Consumer returns | gRPC | HTTP | Retry-After |
|---|---|---|---|
| plain error (non-permanent) | Unavailable | 503 | no |
| `consumererror.NewPermanent` | Internal | 500 | no |
| `status.Error(ResourceExhausted)` with `errdetails.RetryInfo` | ResourceExhausted | **429** | yes, seconds from RetryInfo |
| `status.Error(Unavailable)` with RetryInfo | Unavailable | 503 | yes |
| InvalidArgument / Unauthenticated / PermissionDenied / Unimplemented | same | 400 / 401 / 403 / 404 | no |

`ouoratelimit` returns ResourceExhausted + RetryInfo. Observed:
`HTTP/1.1 429 Too Many Requests`, `Retry-After: 1`, body
`{"code":8,"message":"rate limit exceeded for client \"172.17.0.1\", retry after 1s","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1s"}]}`.
OTel SDK exporters retry ResourceExhausted only when RetryInfo is present, which it is.

Oversize OTLP/HTTP bodies are **400**, not 413: `readAndCloseBody` maps the
`http.MaxBytesError` to `InvalidArgument` (observed `{"code":3,"message":"http: request body
too large"}`). Our replay receiver answers 413.

## Self-telemetry

- Components get `set.MeterProvider`; counters created there appear in the collector's own
  metrics with the scope name. Name counters with the `_total` suffix yourself
  (`ouo_ratelimit_rejected_total`): the Prometheus pull reader keeps it as is, and Mimir with
  `otel_metric_suffixes_enabled: false` stores the OTLP name unchanged, so both paths give the
  same series name.
- `service.telemetry.metrics.readers`: `pull.exporter.prometheus {host, port}` and
  `periodic {interval (ms), exporter.otlp {protocol: http/protobuf, endpoint: <full URL incl.
  /v1/metrics>}}`. Observed: the periodic reader POSTs to exactly the URL given
  (`/otlp/v1/metrics` for Mimir) with `application/x-protobuf`.
- The collector's own resource has `service.name=ouo-collector` (dist name),
  `service.version=0.1.0`, `service.instance.id`.

## Client address behind NAT and proxies

- Docker Desktop on macOS: every request from the host reaches the container from the bridge
  gateway (observed `172.17.0.1`), so a per-address bucket is per host machine on a laptop.
- Behind Caddy every peer is Caddy. `ouoratelimit` `client.key_from: x_forwarded_for` keys on
  the first `X-Forwarded-For` hop (needs `include_metadata: true`). Caddy without
  `trusted_proxies` replaces any client-sent `X-Forwarded-For` with the real peer, so the first
  hop is trustworthy there (Caddy documentation, not re-verified in this run); on a directly exposed port the client can choose the header, so
  keep `address` there.

## Replay chunks as log records

- Body is `pcommon.Value` bytes (`SetEmptyBytes().FromRaw(json)`); the debug exporter prints it
  base64. `ouo.replay.seq` is an int attribute.
- One HTTP request = one plog.Logs with one record; no `batch` on the replay pipeline so the
  receiver's 202 means "accepted by the exporter queue". With `sending_queue.enabled`, a
  rum-api outage is absorbed by the queue (1000 chunks) and retried for 5 minutes; a 4xx from
  rum-api is permanent and the chunk is dropped (logged).
