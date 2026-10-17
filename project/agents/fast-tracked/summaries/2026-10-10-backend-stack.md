# 2026-10-10 fast-tracked: stack + Go backend onboarding guides

Agent: `fast-tracked-backend` (writer). Branch `fast-tracked`, nothing committed.

## What was written

- `examples/fast-tracked/00-stack.md` (about 865 lines). Prerequisites, two ways to get
  the files (clone next to your project, or vendor `deploy/`, `services/rum-api`,
  `plugins/ouo-rum-app` keeping the relative layout the compose file depends on), the
  port table with the `.env` override pattern (defaults and the dev Mac's
  3001/3101/3201/9009/4327/4328/13134/8082/8080), start/stop/reset commands, manual
  readiness curls mirroring `deploy/scripts/wait-ready.sh`, the CORS preflight curl, a
  hand-rolled OTLP/JSON trace post plus Tempo fetch-by-id and TraceQL search, rum-api
  readiness, plugin build + Grafana re-create + plugin-proxy check, Grafana login, what
  each collector pipeline does and why CORS is on the receiver, then every ref file
  inlined verbatim (collector, loki, tempo, mimir, datasources, plugin provisioning,
  `.env.example`, `wait-ready.sh`, and the otel-collector + backend blocks of
  `compose.yaml`), and a "What you should see" checklist.
- `examples/fast-tracked/10-backend.md` (about 920 lines). Sections (a) to (h) as
  requested: twelve `go get` lines with versions from `examples/backend/go.mod` and a
  one-line reason each; env var table (host vs in-compose values); `telemetry.go` and
  `baggage.go` inlined in full under "Important: we do this ourselves" callouts with
  a block-by-block explanation; the correlation story (SDK `SessionPropagator` ->
  `baggage` header -> `otelhttp` extract -> `BaggageSpanProcessor.OnStart` -> Tempo
  `{ span.session.id = ... }` -> rum-api); an eight-item swap list (otelhttp handler,
  `http.route` middleware, `otelhttp.NewTransport` client, `slog.InfoContext` +
  `identityLogAttrs`, custom spans with `RecordError`/`SetStatus`, propagator
  pitfall, CORS allow-headers with `cors.go` inlined, graceful shutdown with
  `run()` inlined); an eleven-file reading-order walkthrough of `examples/backend`;
  local run with `go run .` and env vars, curl with `baggage:` and `traceparent:`,
  Tempo/Loki/Mimir verification curls and Grafana Explore steps; a short demo-only
  note on `?delay`, `?fail=500`, `?fail=timeout`, `broken-card`.

Both pages were assembled with a script that `cat`s the ref files into the Markdown,
so the inlined code is byte-identical to the repo at the time of writing. No em dashes,
no `$` prompts, one command per fence.

## What was verified by reading

- `deploy/README.md`, `deploy/docker/compose.yaml`, `deploy/docker/collector/config.yaml`,
  `deploy/docker/{loki,tempo,mimir}/config.yaml`, both Grafana provisioning files,
  `deploy/docker/.env.example` and the local `.env`, `deploy/scripts/{wait-ready,smoke,e2e}.sh`,
  `services/rum-api/README.md` and `main.go` (the `otelhttp.NewTransport` reference),
  `plugins/ouo-rum-app/README.md` and `package.json`, root `package.json` workspaces.
- `examples/backend/main.go`, `internal/telemetry/{telemetry,baggage}.go`,
  `internal/api/{cors,faults,handlers,store}.go`, `go.mod`, `README.md`, `Dockerfile`,
  test function names in `baggage_test.go` and `api_test.go`.
- `kb/otel-go-baggage.md`, `docs/specs/session-lifecycle.md`, ADR-0001 (Correlation),
  ADR-0002, ADR-0004, `sdk/browser/src/telemetry/propagator.ts` and `types.ts`
  (`propagateTo`) for what the browser actually sends in `baggage`.
- Every env var, port, image tag, function name, import path, header list, metric name
  and query in the guides was checked against those files. Nothing was executed.

## Uncertain or not verified by running

- The exact readiness bodies Loki/Tempo/Mimir return during the first 30 s were
  described generically ("non-200 body explaining what it waits for"), not quoted.
- `traces_spanmetrics_calls_total` as the example Mimir metric from Tempo's generator
  comes from Tempo's documented naming, not from a query against this stack.
- The hand-rolled OTLP/JSON curl in `00-stack.md` is derived from `smoke.sh` with fixed
  ids; it was not posted against a live collector in this run.
- `services/rum-api` and `plugins/ouo-rum-app` have no published images, so the
  "vendor the stack" path tells the reader to copy both source trees; a published
  image would simplify this and is worth a follow-up.

## Not done on purpose

- No `index.md` for `examples/fast-tracked/` or `agents/fast-tracked/` (instructions
  said to write only the three files). The orchestrator should add both index entries
  and a `kb/index.md` line if a kb entry is extracted later.
