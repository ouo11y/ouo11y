# RUM into ouo without the ouo browser SDK

How a customer's web app feeds ouo with stock OpenTelemetry JS, rrweb and web-vitals, and what
bit while building `examples/quickstarts/tiny-shop-otel` (2026-10-25, N48). The working code is
`examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/` (about 300 lines).

## The contract rum-api actually reads

Found by reading `services/rum-api/internal/session` and `internal/loki`, then confirmed with a
session that rum-api folded like an SDK one.

- **Session list** = Loki `{service_name=~".+", event_name=~"..."}`, folded per `session_id`
  structured metadata. No `session.start` is needed (the first event's time is used), but
  `ouo.session.started_at` on it is preferred when earlier.
- **Platform** comes from `ouo_platform`; a resource attribute is enough (Loki promotes it to a
  label, the collector's `transform/events` also copies it onto the record).
- **Status** (ADR-0004): `exception` with `ouo.exception.fatal` true -> `crashed`; any other
  `exception` or an `http.request.failed` -> `errored`. Only these `event.name` values are typed:
  `session.start`, `session.end`, `exception`, `http.request.failed`, `navigation`, `web_vital`
  (and the mobile vitals). Everything else is `custom`.
- **Traces** = Tempo search on the span attribute `session.id`. rum-api caches that search for
  60 s per session and range, so a session opened right after the clicks shows `trace_count 0`
  for up to a minute even when Tempo has the traces.
- **Replay** = JSON chunks `{session_id, seq, started_at, ended_at, events}` posted to
  `:4319/v1/replay/chunks` with `Authorization`, `x-ouo-session-id`, `x-ouo-seq`. Plain JSON
  without gzip is accepted (202). A new session must start with an rrweb full snapshot
  (`record.takeFullSnapshot()` on rotation).
- `device_id` in the session record needs rum-api > 0.3.0: the quickstart's 0.3.0 image predates
  it (commit `60c103f`), the attribute is in Loki either way.

## OpenTelemetry JS 3.0 in the browser

- `@opentelemetry/sdk-trace-web` is deprecated ("Use @opentelemetry/sdk-trace"). `sdk-trace` 3.0
  exports `TracerProvider`, `BatchSpanProcessor`, `StackContextManager`; there is no
  `register()`: call `context.setGlobalContextManager`, `propagation.setGlobalPropagator`,
  `trace.setGlobalTracerProvider`, `logs.setGlobalLoggerProvider` yourself.
- The Logs API moved into `@opentelemetry/api` 1.10 (`logs`, `SeverityNumber`); `sdk-logs` 3.0
  takes `{ processors: [...] }` and `BatchLogRecordProcessor({ exporter })`.
- `instrumentation-fetch` 0.300: `propagateTraceHeaderCorsUrls`, `ignoreUrls` (strings compared
  whole, use RegExps), `applyCustomAttributesOnSpan(span, request, result)`; `result.url` and
  `result.status` give the failed-request event. The OTLP browser exporters use `fetch` with a
  keepalive budget of their own.
- Baggage: with `StackContextManager` the context is gone across `await`, so a propagator that
  merges `session.id` / `user.id` into the baggage at inject time is the reliable way (the SDK's
  `SessionPropagator` does the same).
- `@opentelemetry/browser-instrumentation` 0.9 / `browser-sdk` 0.6 (opentelemetry-browser repo)
  still depend on the 0.223 / 2.x line and emit `browser.navigation`, `browser.console`, ...
  names ouo does not type. Not used.

## Testing quirks

- The desktop app's browser pane, when hidden, loads pages as background tabs: web-vitals then
  reports no FCP / LCP (correctly). Use headless Playwright for vitals checks.
- npm fails everywhere inside a worktree with `Exit prior to config file resolving` when the main
  checkout's workspace has a `package.json` with merge-conflict markers: npm walks up to the main
  checkout's root `package.json` and maps its workspaces. Install from a copy outside the repo.
