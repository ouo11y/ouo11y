# e2e scenario (synthetic sessions straight to the collector)

Status: filled in Phase 6 by qa (2026-10-08). Code: `tests/e2e/scenario.mjs`,
`deploy/scripts/e2e.sh`. Verified against the Phase 1 to 5 stack (collector-contrib 0.160.0,
Loki 3.7.7, Tempo 3.0.3, Grafana 13.2.1, rum-api from this tree).

## Question

How do you generate a known population of web and mobile sessions without an app, and assert
rum-api's health percentages, session lists, trace counts and Grafana links reproducibly?

## What works

- Post OTLP/JSON to the collector (`/v1/logs`, `/v1/traces`) with the resource the SDK would
  carry (`service.name`, `service.version`, `deployment.environment.name`, `ouo.platform`) and
  the identifiers as record / span attributes (`session.id`, `user.id`, `ouo.platform`,
  `service.version`). Set both the top-level `eventName` and the `event.name` attribute on log
  records (the collector transform mirrors one into the other; Loki's `event_name` label needs it).
- One `resourceLogs` entry per session is fine; 40 sessions / 106 records / 144 spans in two
  requests, accepted with no `partialSuccess`.
- `ouo.exception.fatal` as `boolValue` arrives in Loki as the string `"true"`; rum-api parses it.
- A `session.end` with `ouo.session.end_reason=crash` and no fatal `exception` is classified
  crashed (crash marker on next launch); the script sends one such session per mobile version.
- Traces: a CLIENT span from the service and a SERVER span from `qa-backend` with
  `parentSpanId` = the client span, both with `session.id`. rum-api counts them per session and
  Grafana's Tempo datasource (`POST /api/ds/query`, `queryType: "traceId"`, `query: <id>`)
  returns one frame with 2 rows: a stronger check than fetching the Explore URL (which is HTTP
  200 whatever the id).
- Idempotent range: use an absolute `from` (epoch ms, 60 s before the run) rather than
  `now-15m`, otherwise two runs inside 15 minutes count each other's sessions
  (`service=qa-web` is shared). Session ids are prefixed `qa-<run_id>-`.
- Ingestion wait: the health totals appear 20 to 60 s after posting (Loki flush + rum-api);
  trace counts may take up to 90 s (Tempo ingester + rum-api's 60 s cache). Poll, do not sleep.
- Session ids must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`; `qa-<base36>-w-100-e2` does.

## Gotchas

- Tempo's search API returns trace ids with leading zeros stripped (`0a09...` comes back as
  `a09...`); rum-api passes them through. Compare ids with `replace(/^0+/, "")`. Tempo
  `/api/traces/<id>` and Grafana accept both forms.
- rum-api `GET /v1/sessions/{id}` returns the record fields at the top level next to `timeline`
  and `traces` (not under a `session` key).
- Grafana's Tempo datasource with `queryType: "traceql"` and a bare trace id answers
  "invalid TraceQL query"; Explore's UI auto-detects a bare id, the API does not. Use
  `queryType: "traceId"`.
- Forcing a fresh browser session in the web demo for manual QA: `localStorage.removeItem("ouo.session")`
  alone does not work because the SDK re-persists the live session on `pagehide`. Override
  `Storage.prototype.setItem` to ignore the `ouo.session` key, then remove (or rewrite with an
  old `lastActivity`) and reload. The next page load has a clean prototype.
- The web SDK's inactivity rotation currently emits two `session.start` records (see
  `agents/qa/reports/phase-6-bugs.html`); health totals for `web-store` include phantom sessions
  until that is fixed.
