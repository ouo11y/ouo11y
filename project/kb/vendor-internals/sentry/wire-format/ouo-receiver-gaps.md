# What `ouosentryreceiver` does differently from Relay 26.10.0

Facts only, no fixes. Compared on 2026-11-10: our receiver at `collector/receiver/ouosentryreceiver/` on `origin/main` (commit `3e9e2c11`), spec [`docs/specs/sentry-bridge.md`](../../../../../docs/specs/sentry-bridge.md), against Relay 26.10.0 source and the observed answers in [fixtures/relay-responses/](fixtures/relay-responses/index.md).

The receiver has two modes: forward (raw bytes to Sentry, answer copied back, translate only on 2xx) and `upstream: none` (answer locally). Most framing differences only matter in `upstream: none` mode or for what ouo stores; in forward mode Sentry's own answer reaches the SDK.

## Routes and auth

| # | Relay 26.10.0 | `ouosentryreceiver` | Where |
|---|---|---|---|
| R1 | Serves `/envelope/`, `/store/`, `/security/` + `/csp-report/`, `/nel/`, `/minidump/`, `/unreal/{key}/`, `/events/{id}/attachments/`, `/cron/...`, `/upload/`, `/integration/otlp/v1/{traces,logs}` | Only `POST /api/{id}/envelope/`; everything else 404 | `envelopePathRe`, `receiver.go` |
| R2 | Auth sources: `X-Sentry-Auth`, `Authorization: Sentry`, `Authorization: Basic`, query `sentry_*`, path key, envelope `dsn` | No `Basic`, no path key | `auth.go` |
| R3 | Two auth sources at once → 401 `multiple authorization payloads detected`, even with the same key | Accepts header + query when the keys are equal; 403 only when they differ | `publicKey` |
| R4 | `sentry_version` > 7 → 400 | Not checked | — |
| R5 | Key not 32 hex → 400; missing auth → 401 | Unknown key or missing auth → 403 | `handle` |
| R6 | Envelope `dsn` project id / key must match the request → 400 mismatch | Not checked | — |
| R7 | CORS preflight answered (allow-origin `*`, expose rate-limit headers) | `OPTIONS` → 405 in `upstream: none` mode; in forward mode also 405 (method check before forwarding) | `handle` |

## Decompression and framing

| # | Relay 26.10.0 | `ouosentryreceiver` |
|---|---|---|
| F1 | `Content-Encoding` gzip, deflate (zlib only), **br**, **zstd** | gzip, `x-gzip`, deflate (zlib, then raw-deflate fallback). br and zstd → envelope forwarded but not translated (`drop reason=encoding`) |
| F2 | `x-gzip` → 415; raw deflate → 400 | Both accepted and translated |
| F3 | Two trailing newlines → 400 `unexpected end of file` | Tolerated (`rest[0] == '\n'` skip) |
| F4 | CRLF after a header → 400 | `\r` left at the end of the header line, which `json.Unmarshal` accepts as whitespace → accepted |
| F5 | > 500 items → 400 | No item limit |
| F6 | Container `item_count` must match → else items invalid | `item_count` ignored; logs decoded regardless |
| F7 | Per-item size limits and the "one event-like item per envelope" rule → 413 | Not enforced; e.g. `event` + `replay_event` is translated in `upstream: none` mode |
| F8 | Body limit 200 MiB decompressed (nginx 100 MiB compressed in self-hosted) | 100 MiB raw (`DefaultMaxRequestBodySize`), 20 MiB for translation (`DefaultMaxTranslateBytes`) |

## Item types translated

Relay processes 22 wire types. The receiver translates 7: `session`, `user_report`, `event`, `transaction`, `feedback`, `log`, `replay_video` (`decode` in `translate.go`). Not translated (forwarded only):

| # | Item | Consequence for ouo |
|---|---|---|
| I1 | `replay_event` + `replay_recording` (**web replays**) | No browser replay reaches ouo through the bridge; only mobile `replay_video` |
| I2 | `sessions` (aggregates) | Server-side request-mode sessions lost |
| I3 | `client_report` | No SDK-side drop counts (`ratelimit_backoff`, `sample_rate`, `queue_overflow` ...) |
| I4 | `span` (v1 and v2 containers) | Standalone spans (browser INP/CLS spans, streaming spans) lost; only spans inside transactions |
| I5 | `trace_metric` | lost |
| I6 | `check_in` | lost |
| I7 | `attachment` (incl. `event.view_hierarchy`, `event.minidump`, `event.applecrashreport`) | screenshots, view hierarchies and native crash files lost |
| I8 | `profile`, `profile_chunk` | lost |
| I9 | `security` / `raw_security`, `unreal_report`, `form_data` | lost (and their endpoints are not served, R1) |

## Field-level details

| # | Relay / Sentry | `ouosentryreceiver` |
|---|---|---|
| D1 | Log item has a top-level `span_id` (`OurLog.span_id`) | `sentryLog` has no `span_id` field; the span id is taken only from the attribute `sentry.trace.parent_span_id` (`emitLog` in `logs.go`), so a log that sets only `span_id` loses its span link |
| D2 | Recording bodies are **zlib** or raw JSON; Sentry drops gzip bodies (observed) | `parseRecording` inflates **gzip** only; a zlib recording inside `replay_video` is treated as plain text and its events (video meta, touches, breadcrumbs) are not parsed |
| D3 | `replay_video` with empty video → invalid | Decoded and emitted |
| D4 | `replay_event` validation: `segment_id` ≤ 65535, valid UUIDs in `error_ids`/`trace_ids`, lists capped at 100 | Not validated |
| D5 | DSC `trace` object fully parsed (sample_rate, sample_rand, sampled, ...) | Only `trace.replay_id` read (`traceReplayID`) |
| D6 | `sent_at` used for clock drift correction of all timestamps | `SentAt` parsed but not used for correction (not found in `translate.go`) |

## Responses and outcomes

| # | Relay 26.10.0 | `ouosentryreceiver` |
|---|---|---|
| O1 | 200 body `{}` when no event id | `upstream: none`: `{"id":""}` |
| O2 | 200 is "accepted for processing"; later drops (unknown key, filters, invalid payload, missing release in a session, gzip recording, project quota) are only outcomes | Translates on any 2xx, so ouo can store data that Sentry dropped (parity gap, not a bug) |
| O3 | 429 when **any** propagatable limit was enforced, while other items of the same envelope are still queued (observed: error limited, session accepted) | Translates only on 2xx, so the accepted items of a 429 envelope are not translated |
| O4 | `X-Sentry-Rate-Limits`, `Retry-After` on 429 | `upstream: none` never rate-limits |
| O5 | Error status 400/401/403/413/415/429/503 with `{"detail","causes"}` | `{"detail"}` with 403/404/405/413 |

## Network

| # | Fact |
|---|---|
| N1 | Self-hosted nginx sets `X-Forwarded-For $remote_addr`, replacing the chain the bridge builds. Behind self-hosted nginx, Sentry sees the bridge's address as the user IP (observed: Docker gateway IP in `replays_local.ip_address_v4`). Relay itself reads `X-Forwarded-For`. |
| N2 | The bridge does not speak OTLP; Sentry's OTLP routes (`/integration/otlp/v1/traces`, `/logs`) are a separate fan-out option for topology (b), see [otlp-ingest.md](otlp-ingest.md). |
