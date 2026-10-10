# e2e scenario (synthetic sessions through the rum-api ingest gateway)

Status: filled in Phase 6 by qa (2026-10-08), updated for the Phase 8a gateway (2026-10-10). Code:
`tests/e2e/scenario.mjs`, `deploy/scripts/e2e.sh`. Verified against the Phase 1 to 5 stack and the
Phase 8a stack (collector-contrib 0.160.0, Loki 3.7.7, Tempo 3.0.3, Grafana 13.2.1, rum-api from
this tree). Since 8a the script posts to `${OUO_RUM_API}/ingest/otlp/v1/*` with
`X-Ouo-Project-Token`, never to the collector (which is loopback-only).

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

## Phase 8a: gateway, tokens, project stamping

- `deploy/scripts/e2e.sh` exports `OUO_RUM_API`, `OUO_OTLP_URL=$OUO_RUM_API/ingest/otlp`,
  `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`, `OUO_READ_TOKEN` from `deploy/docker/.env`
  (`OUO_ENV_FILE=...` to point at another env file, needed when the ports are not the stock ones).
  The scenario sends the token on every OTLP post and `Authorization: Bearer` on every rum-api read;
  an empty `OUO_READ_TOKEN` skips the read-auth checks for a rum-api without a read token.
- Negative checks cost nothing and run before ingestion: POST without / with an unknown token is 401,
  a valid token with `Origin: https://evil.example` is 403 (the preflight too), `{"resourceSpans": 1}`
  is 400, `/v1/replay/chunks` without token 401, reads without the read token 401 with
  `WWW-Authenticate: Bearer realm="ouo-rum-api"` (compare the prefix, not the whole value).
- To prove stamping, send `ouo.project.id=spoofed-by-client` on every resource and read the stored
  trace back through Grafana's datasource proxy
  `GET $GRAFANA/api/datasources/proxy/uid/tempo/api/traces/<trace id>` (basic auth): Tempo answers
  the v1 `batches[].resource.attributes` shape here, the walker also accepts `trace.resourceSpans`.
  Expect exactly one `ouo.project.id` per resource, all equal to `OUO_PROJECT_ID`; the trace can
  404 for a few seconds after search already finds it, poll.
- Rate-limit check: 400 parallel tiny POSTs from one Node process finish in ~130 ms and get
  ~300 x 200 then 429 `Retry-After: 1` (`{"error":"client rate limit exceeded"}`); a second later
  everything is 200 again. Mimir `ouo_ingest_requests{outcome="rejected",reason="rate"}` counts them
  (metric names in Mimir are `ouo_ingest_requests` / `ouo_ingest_bytes`, no `_total`).
- Manual QA of the Grafana plugin read token: change it with
  `POST /api/plugins/ouo-rum-app/settings {"enabled":true,"pinned":true,"jsonData":{...},"secureJsonData":{"readToken":"..."}}`
  (admin basic auth) and restore the same way; a Grafana restart re-applies provisioning. On
  Grafana 13.2.1 Reset + empty save deletes the key (`secureJsonFields: {}`).
- iOS dev builds: expo-constants evaluates `app.config.ts` during `xcodebuild`
  (`EXConstants.bundle/app.config`), so `EXPO_PUBLIC_RUM_API` / `BACKEND_URL` must be set for the
  native build (or in `examples/mobile/.env`), not only for `expo start`. Without `expo-dev-client`
  the app connects to Metro on 8081 whatever `expo start --port` says; redirect it with
  `xcrun simctl spawn booted defaults write dev.ouo.mobilestore RCT_jsLocation "localhost:8091"` and
  relaunch (delete the key afterwards). The app's URL scheme is `dev.ouo.mobilestore`, not
  `mobilestore`.
- Pane-driven unload test: closing the tab from the Claude browser pane did not deliver the
  pagehide keepalive chunk (a seq gap appears, rum-api tolerates it); a navigation in the same tab
  does. Use navigation to test the keepalive path, a real Chrome window for tab close.

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
