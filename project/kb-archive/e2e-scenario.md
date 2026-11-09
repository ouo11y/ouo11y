# e2e scenario (synthetic sessions through the collector edge)

Status: filled in Phase 6 by qa (2026-10-08), updated for Phase 8a revision 2 (2026-10-13, ADR-0007:
the `ouo-collector` is the only public edge, rum-api is internal). Code: `tests/e2e/scenario.mjs`,
`deploy/scripts/e2e.sh`. Verified against the `ouo-8a` stack (ouo-collector 0.1.0 on collector
0.160.0, Loki 3.7.7, Tempo 3.0.3, Grafana 13.2.1, rum-api from this tree). The script posts OTLP to
`${OUO_OTLP_URL}/v1/*` and replay chunks to `${OUO_REPLAY_URL}/v1/replay/chunks`, both with
`Authorization: Basic base64(project id:project token)`, and reads rum-api with the read token.

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

## Phase 8a: collector edge, tokens, project stamping

- `deploy/scripts/e2e.sh` exports `OUO_OTLP_URL` (collector 4318), `OUO_REPLAY_URL` (4319),
  `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`, `OUO_PROJECT_BASIC`, `OUO_RUM_API_URL` (read side only),
  `OUO_READ_TOKEN`, `OUO_GRAFANA_URL` from `deploy/compose/.env` (`OUO_ENV_FILE=...` when the ports
  are not the stock ones; the `ouo-8a` stack uses 4330 / 4331 / 8090). An empty `OUO_READ_TOKEN`
  skips the read-auth checks.
- Edge checks cost nothing and run before ingestion: OTLP without credential, wrong token and
  unknown project are 401 (`{"code":16,"message":"no basic auth provided"}` / `invalid credentials`);
  an empty `resourceSpans` batch with the credential is 200; replay without credential or with a
  wrong token 401; rum-api's sink without the ingest token, or with the public project Basic
  instead, 401; reads without / with a wrong read token 401 (`WWW-Authenticate: Bearer…`, compare
  the prefix).
- CORS preflights by hand must send `Access-Control-Request-Headers` lowercase and **sorted**
  (`authorization,content-type` on 4318, `authorization,content-encoding,content-type,x-ouo-seq,x-ouo-session-id`
  on 4319). rs/cors answers an unsorted list with a 204 that has no `Access-Control-Allow-Origin`,
  which looks like a CORS failure that browsers never hit. A refused origin also gets 204 without
  the allow headers, so assert the header, not the status.
- To prove stamping, send `ouo.project.id=spoofed-by-client` on every resource and read the stored
  trace back through Grafana's datasource proxy
  `GET $GRAFANA/api/datasources/proxy/uid/tempo/api/traces/<trace id>` (basic auth; v1 `batches`
  shape, the walker also accepts `trace.resourceSpans`). Expect one `ouo.project.id` per resource,
  all equal to `OUO_PROJECT_ID`. The trace can 404 for a few seconds after search finds it; poll.
- Replay end to end: one rrweb chunk for one matrix session to the replay receiver answers 202
  `{"accepted":1,...}`; the exporter forwards it to rum-api in well under a second, so
  `GET /v1/sessions/<id>/replay` shows `chunk_count 1, project_id demo` on the first poll and the
  session detail flips to `has_replay: true` (the others stay false). Use a session that is
  already in the matrix; a replay-only session id is not listed by rum-api.
- Rate limit at the collector: 400 parallel tiny authenticated OTLP posts from one Node process
  finish in ~160 ms with ~307 x 200 and ~93 x 429 `Retry-After: 1` (body is the gRPC status JSON
  with `RetryInfo`); one second later 200. On Docker Desktop every host request comes from the VM
  gateway (`192.168.65.1` here), so the per-client bucket (100/s, burst 300) is per laptop.
  Mimir has `ouo_ratelimit_rejected_total{key_kind="client"}` and
  `otelcol_receiver_refused_log_records{receiver="otlp"}` with the same count (collector
  self-metrics are pushed every 15 s; `otelcol_*` names carry no `_total`). 401s are not counted.
- Body limits: OTLP over 4 MiB is **400** (`http: request body too large`), not 413; an rrweb
  chunk over 4 MiB on the replay port is 413; a big body without credential is 401 (auth first).
- Manual QA of the Grafana plugin read token: change it with
  `POST /api/plugins/ouo11y-rum-app/settings {"enabled":true,"pinned":true,"jsonData":{...},"secureJsonData":{"readToken":"..."}}`
  (admin basic auth) and restore the same way; a Grafana restart re-applies provisioning. On
  Grafana 13.2.1 Reset + empty save deletes the key (`secureJsonFields: {}`).
- Demo apps on remapped ports: the SDKs derive the replay URL as port 4319 only from 4318. With
  4330 neither `examples/ouo-web` nor `examples/ouo-mobile` exposes `replayEndpoint` (qa finding R2-1/R2-2);
  pass it explicitly or chunks hit the OTLP port and get 404.
- iOS dev builds: expo-constants evaluates `app.config.ts` during `xcodebuild`
  (`EXConstants.bundle/app.config`), so `EXPO_PUBLIC_*` / `BACKEND_URL` given only to `expo start`
  do not reach `Constants.expoConfig.extra`; `process.env.EXPO_PUBLIC_*` read in app code is inlined
  by Metro and does. Without `expo-dev-client` the app connects to Metro on 8081 whatever
  `expo start --port` says; redirect it with
  `xcrun simctl spawn booted defaults write dev.ouo.mobilestore RCT_jsLocation "localhost:8091"` and
  relaunch (delete the key afterwards). In dev the fatal error does not kill the app: terminate and
  relaunch to get `session.end crash`; pending frames chunks upload on the relaunch.
- Header evidence in the Claude browser pane: its network log has URLs and statuses but no request
  headers. Wrap `window.fetch` from `javascript_tool` and record `url`, `Authorization`,
  `keepalive`, `Content-Encoding`, `x-ouo-seq` into `localStorage` (survives a cross-origin
  navigation, read it back from a new tab on the same origin) plus a capture-phase `pagehide`
  listener. In revision 2 both navigation and the pane's tab close delivered the final keepalive
  chunk.

## Gotchas

- Tempo's search API returns trace ids with leading zeros stripped (`0a09...` comes back as
  `a09...`); rum-api passes them through. Compare ids through `normTraceId` in
  `tests/e2e/lib.mjs`, never raw. Tempo `/api/traces/<id>` and Grafana accept both forms.
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
  `project/agents/qa/reports/phase-6-bugs.html`); health totals for `web-store` include phantom sessions
  until that is fixed.

## Edge QA checks (`tests/e2e/edge-qa.mjs`, N15, 2026-10-23)

`deploy/scripts/qa-edge.sh [<env>] [--out-dir <dir>]` runs the checks that had only been
unit-tested or reasoned about, against an `ouo-env` env: profile `default` (auth-failure
counter, empty exports charged, stock OTel SDK with `OTEL_EXPORTER_OTLP_HEADERS`, foreign-origin
CORS in headless Chromium, plugin as a Grafana Viewer, RN `background` end reason), then it
recreates the collector with `OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for` and small buckets
(`OUO_RATELIMIT_{PROJECT,CLIENT}_{RATE,BURST}`, passed through by `ouo-env up` because it hands
its environment to compose), runs profile `limits` (X-Forwarded-For keying, project bucket),
and restores the stock collector on exit. About 6 minutes, mostly Mimir's 15 s self-metric push.

- **Playwright never sees the CORS preflight.** Chromium runs it internally: no `response`
  event with method `OPTIONS`. The verdict is on the console (`... blocked by CORS policy:
  Response to preflight request doesn't pass access control check: No
  'Access-Control-Allow-Origin' header ...`); `page.on("console")` is the evidence. Any
  `http://<name>.localhost:<port>` is a foreign origin for the dev CORS list (`*.localhost`
  resolves to loopback in Chromium) and needs no hosts entry. Playwright 1.64.1 in headless
  mode uses the cached `chromium_headless_shell-1248`; `tests/e2e` has its own `package.json`
  (not a workspace) so the root install stays without Playwright.
- **Traefik (the ouo-env proxy) replaces a client's X-Forwarded-For.** Through
  `otlp.<env>.ouo.localhost`, requests spoofing a different header each share one client
  bucket, named after the address Traefik saw (`172.x.0.1`). Direct to the published port, the
  header is taken as is, which is why `key_from: x_forwarded_for` is only for deployments
  where a proxy that overwrites the header is the only way in.
- **The RN `background` end reason without a device:** `tests/e2e/rn-background` runs the SDK's
  own source under Vitest with the unit tests' `react-native` / AsyncStorage / Expo stand-ins,
  `backgroundTimeoutMs: 1500`, `AppState.__emit("background")`, waits, `__emit("active")`, and
  exports to the env's real collector (jsdom keeps Node's fetch, no CORS). Only the OS
  transition is simulated; rum-api reports `end_reason background`, `state ended`.
- **Stock OTel JS SDK in Node from the repo's node_modules** (`tests/e2e/otel-sdk/stock-node.mjs`):
  `new OTLPTraceExporter()` with no options reads `OTEL_EXPORTER_OTLP_ENDPOINT` and
  `OTEL_EXPORTER_OTLP_HEADERS` (`%20` decoded); a wrong credential surfaces as
  `OTLPExporterError: Unauthorized` with code 401.
- A Grafana user created through `/api/admin/users` gets the org role Viewer; `PATCH
  /api/org/users/<id>` with `{"role": "Editor"}` makes an Editor. Until N30 (2026-11-04) the plugin
  route `rum/*` had `method: "*"` and `reqRole: Viewer`, so a Viewer could `DELETE` a replay
  through `/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions/<id>/replay` (finding V1). The routes
  are split per method now and the `viewer` check asserts it: Viewer and Editor DELETE 403, PUT /
  PATCH / other POSTs 404, Admin DELETE 204 (`project/kb-archive/grafana-app-plugin.md`, "Route roles").
