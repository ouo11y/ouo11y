# Sentry ingest endpoints and authentication

Versions: Relay 26.10.0, self-hosted 26.10.0 (nginx 1.31.6). Researched 2026-11-10. Observed results come from [fixtures/relay-responses/](fixtures/relay-responses/index.md).

## Routes

Read: `public_routes_raw` in [`relay-server/src/endpoints/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/mod.rs). In self-hosted, nginx sends `/api/store/`, every `/api/<digit-led id>/...` path and `/api/0/relays/` to Relay, and everything else to `web` ([`nginx.conf`](https://github.com/getsentry/self-hosted/blob/26.10.0/nginx.conf)).

| Route | Method | Body | Becomes | Observed |
|---|---|---|---|---|
| `/api/{project_id}/envelope/` | POST | envelope | as is | 200 `{"id"}` / `{}` |
| `/api/{project_id}/store/` | POST | event JSON (also base64+zlib legacy, or an envelope) | `event` item | 200 `{"id"}` (`endpoint-store-json.json`); an envelope body is also accepted (`endpoint-store-envelope-content-type.json`) |
| `/api/store/` | POST | event JSON | legacy, no project id in path; Relay skips the id check | not tested |
| `/api/{project_id}/security/` and `/csp-report/` | POST | CSP, Expect-CT, Expect-Staple, HPKP report JSON | `raw_security` item → `security` event | 200 empty body (`endpoint-security-csp.json`); then dropped by Relay's CSP inbound filter (outcome `filtered`, reason `invalid-csp`, category `security`, observed in `outcomes_raw_local`); the exact filter rule that matched was not checked |
| `/api/{project_id}/nel/` | POST | Reporting API `application/reports+json` array | NEL → **log** (`LogsIntegration::Nel`) | 200 empty; stored as an EAP log (`sentry.body` "The TCP connection was refused by the server", `nel.phase`, `url.full`) |
| `/api/{project_id}/minidump/` (slash optional) | POST | multipart with `upload_file_minidump` | `event.minidump` attachment | garbage → 400 `invalid minidump` |
| `/api/{project_id}/unreal/{sentry_key}/` | POST | UE4 crash zip | `unreal_report` item | garbage → **200** with a bare UUID body; dropped later (no event stored) |
| `/api/{project_id}/events/{event_id}/attachments/` | POST | multipart | `attachment` items | not tested |
| `/api/{project_id}/cron/{monitor_slug}/{sentry_key}[/]` and `/cron/{monitor_slug}/` | GET/POST | query `status`, `check_in_id`, `environment`, `duration` | `check_in` item | 202 empty (`endpoint-cron-get.json`); without `monitor_config` the monitor is not auto-created (outcome `invalid_monitor`) |
| `/api/{project_id}/upload/` | POST, PATCH, HEAD | TUS upload | large attachments, `X-Decoded-Content-Length` header | not tested |
| `/api/{project_id}/integration/otlp/v1/traces[/]` | POST | OTLP protobuf or JSON | spans | see [otlp-ingest.md](otlp-ingest.md) |
| `/api/{project_id}/integration/otlp/v1/logs[/]` | POST | OTLP protobuf or JSON | logs | see [otlp-ingest.md](otlp-ingest.md) |
| `/api/{project_id}/integration/vercel/logs` | POST | Vercel log drain JSON/NDJSON | logs | not tested |
| `/api/{project_id}/playstation/` | POST | PlayStation crash | only in Sentry-internal builds (`#[cfg(sentry)]`) | — |
| `/api/0/relays/projectconfigs/`, `/publickeys/`, `/register/*`, `/live/` | POST/GET | Relay-to-Relay protocol | — | — |
| `/api/relay/healthcheck/{ready,live}/` | GET | internal | not exposed through self-hosted nginx (observed 404 via `localhost:9000`) | — |

There is **no** `/otlp/v1/metrics`, and no OTLP route outside `/integration/otlp/` (observed 404, `otlp-metrics-json.json`, `otlp-short-path.json`).

## Authentication

Read: `auth_from_parts` and `FromRequestParts for RequestMeta` in [`extractors/request_meta.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/extractors/request_meta.rs), envelope fallback in [`endpoints/envelope.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/envelope.rs).

Relay looks for the public key in this order. **Exactly one** source may be present, otherwise 401 `multiple authorization payloads detected`:

1. `X-Sentry-Auth: Sentry sentry_key=<key>, sentry_version=7, sentry_client=<name/version>` (prefix `sentry ` case-insensitive).
2. `Authorization: Sentry sentry_key=...` (same format).
3. `Authorization: Basic base64(<key>:)` (key as user name).
4. Query string containing `sentry_` (`?sentry_key=<key>&sentry_version=7`).
5. Path segment `{sentry_key}` (cron and unreal routes only).
6. Envelope endpoint only: if none of the above, the first line of the body is parsed as the envelope header and its `dsn` is used. This is what browser `sendBeacon`/tunnel requests rely on.

| Case | Observed |
|---|---|
| `X-Sentry-Auth` | 200 |
| `Authorization: Sentry ...` | 200 (`auth-authorization-header.json`) |
| `Authorization: Basic` | 200 (`auth-basic.json`) |
| `?sentry_key=` | 200 (`auth-query-sentry_key.json`) |
| only `dsn` in the envelope header | 200 (`auth-envelope-dsn-only.json`) |
| header and query together | 401 `multiple authorization payloads detected` |
| nothing, and no `dsn` | 401 `bad envelope authentication header` / `missing field dsn` |
| key not 32 hex | 400 `bad sentry DSN public key` |
| well formed key of no project | 200, dropped later |
| `sentry_version=8` | 400 `unsupported protocol version (8)` (`PROTOCOL_VERSION = 7`, [`relay-event-schema/src/protocol/constants.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/constants.rs)) |
| `sentry_version=5` | 200 (anything ≤ 7 passes) |
| `dsn` in header names another project | 400 `project id header mismatch` |
| key of project 8 posted to `/api/5/` without `dsn` | **403** `event submission rejected with_reason: ProjectId` |
| `Authorization: Bearer <key>` (OTLP) | 401 `missing authorization information` |

Other auth fields: `sentry_client` becomes the client name in outcomes; `sentry_secret` is accepted and ignored. A key may carry flags after a dash (`<key>-no-cache`), parsed by `ProjectKey::parse_with_flags`.

Relay resolves the project from the **key**, not from the path. The path id is checked later against the project of the key (the 403 above).

## Client IP

Relay reads the client address from `X-Forwarded-For` (`ForwardedFor` extractor). Self-hosted nginx sets `X-Forwarded-For $remote_addr`, so the SDK's own header is replaced by the peer address (observed: `ip_address_v4` in `replays_local` is the Docker gateway `192.168.65.x`). Our bridge appends to the chain; behind nginx that value is lost unless nginx is changed.

## Responses per endpoint

| Endpoint | Success body |
|---|---|
| envelope | `{"id":"..."}` or `{}` |
| store | `{"id":"..."}` |
| security, nel | empty, 200 |
| unreal | event id as a bare UUID string (observed) |
| minidump | event id as a bare string (read: `minidump.rs`; not observed, our test was a 400) |
| cron | 202 empty |
| OTLP JSON | `{}` |
| OTLP protobuf | empty `Export*ServiceResponse` (0 bytes) |
