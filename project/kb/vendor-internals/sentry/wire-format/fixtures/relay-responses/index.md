# Relay 26.10.0 responses to hand-crafted requests

Observed 2026-11-10 against self-hosted Sentry 26.10.0 (nginx then Relay 26.10.0) at `localhost:9000`, project `step6-wire` (id 8). Each JSON file holds the request (method, path, headers, size, first bytes; public key replaced by `<redacted-public-key>`) and the response (status, relevant headers, body, latency). Sent by [../harness/](../harness/index.md). `_ids.json` lists the ids of the stored test data.

| File | Request | Status | Body (start) | Note |
|---|---|---|---|---|
| [auth-authorization-header.json](auth-authorization-header.json) | POST `/api/8/envelope/` | 200 | {"id":"26cdb71e1b44497ebde139fe96e66fc6"} | Authorization: Sentry ... instead of X-Sentry-Auth |
| [auth-bad-key-format.json](auth-bad-key-format.json) | POST `/api/8/envelope/` | 400 | {"detail":"bad sentry DSN public key","causes":["invalid project key"]} |  |
| [auth-basic.json](auth-basic.json) | POST `/api/8/envelope/` | 200 | {"id":"5901fbfe9e784936a69b0feb82de21cb"} | HTTP basic auth with public key as user |
| [auth-dsn-project-mismatch.json](auth-dsn-project-mismatch.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["project id header mismatch between envelope  |  |
| [auth-envelope-dsn-only.json](auth-envelope-dsn-only.json) | POST `/api/8/envelope/` | 200 | {"id":"139b738df2e148c19f042bb6cbcbd4ab"} | no header/query auth: Relay reads dsn from the envelope header (browser tunnel / sendBeacon style) |
| [auth-header-and-query.json](auth-header-and-query.json) | POST `/api/8/envelope/?sentry_key=<redacted-public-key>` | 401 | {"detail":"multiple authorization payloads detected"} | X-Sentry-Auth and ?sentry_key together |
| [auth-missing.json](auth-missing.json) | POST `/api/8/envelope/` | 401 | {"detail":"bad envelope authentication header","causes":["missing field `dsn` at line 1 co |  |
| [auth-query-sentry_key.json](auth-query-sentry_key.json) | POST `/api/8/envelope/?sentry_key=<redacted-public-key>&sentry_version=7` | 200 | {"id":"fa96652c4b124fe3b5cf0d150b08e2b6"} |  |
| [auth-unknown-key.json](auth-unknown-key.json) | POST `/api/8/envelope/` | 200 | {"id":"1ffba243b89d42b5b7dcf4e1474b6064"} | well-formed key that no project has |
| [auth-version-5.json](auth-version-5.json) | POST `/api/8/envelope/` | 200 | {"id":"766a970befbe474593331de1e181ecb0"} |  |
| [auth-version-8.json](auth-version-8.json) | POST `/api/8/envelope/` | 400 | {"detail":"unsupported protocol version (8)"} |  |
| [auth-wrong-project-in-path-no-dsn.json](auth-wrong-project-in-path-no-dsn.json) | POST `/api/5/envelope/` | 403 | {"detail":"event submission rejected with_reason: ProjectId"} | key of project 8, path /api/5/, envelope header without dsn |
| [auth-wrong-project-in-path.json](auth-wrong-project-in-path.json) | POST `/api/5/envelope/` | 400 | {"detail":"invalid event envelope","causes":["project id header mismatch between envelope  | key of project 8 posted to /api/5/ |
| [blank-line-between-items.json](blank-line-between-items.json) | POST `/api/8/envelope/` | 200 | {"id":"3ad233591e104a8eb65d44113fce0061"} | an empty line between two items |
| [combo-event-plus-replay_event.json](combo-event-plus-replay_event.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'replay_event' (https://develop.sentry.d | error event and replay_event in one envelope share the 'event' size limit (count 1) |
| [combo-event-plus-transaction.json](combo-event-plus-transaction.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'transaction' (https://develop.sentry.de |  |
| [cors-preflight.json](cors-preflight.json) | OPTIONS `/api/8/envelope/` | 200 |  |  |
| [crlf-line-endings.json](crlf-line-endings.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["missing newline after header or payload"]} | CRLF after headers |
| [empty-body.json](empty-body.json) | POST `/api/8/envelope/` | 400 | {"detail":"empty request body"} |  |
| [endpoint-cron-get.json](endpoint-cron-get.json) | GET `/api/8/cron/step6-wire-http-cron/<redacted-public-key>/?status=ok` | 202 |  |  |
| [endpoint-minidump-garbage.json](endpoint-minidump-garbage.json) | POST `/api/8/minidump/?sentry_key=<redacted-public-key>` | 400 | {"detail":"invalid minidump"} |  |
| [endpoint-nel.json](endpoint-nel.json) | POST `/api/8/nel/?sentry_key=<redacted-public-key>` | 200 |  |  |
| [endpoint-security-csp.json](endpoint-security-csp.json) | POST `/api/8/security/?sentry_key=<redacted-public-key>&sentry_environment=wire` | 200 |  |  |
| [endpoint-store-envelope-content-type.json](endpoint-store-envelope-content-type.json) | POST `/api/8/store/` | 200 | {"id":"ee3b163a920144b4bd92ab1e66e259cf"} | store endpoint given an envelope |
| [endpoint-store-json.json](endpoint-store-json.json) | POST `/api/8/store/` | 200 | {"id":"afb97a2b0c0e4d1f89b265604eca6a4f"} |  |
| [endpoint-unreal-garbage.json](endpoint-unreal-garbage.json) | POST `/api/8/unreal/<redacted-public-key>/` | 200 | 12b68116-eee3-48f3-834b-8b810ddb989d |  |
| [event-br.json](event-br.json) | POST `/api/8/envelope/` | 200 | {"id":"4e51af59b43c4121a7bbe77adaa17f1b"} |  |
| [event-deflate-raw.json](event-deflate-raw.json) | POST `/api/8/envelope/` | 400 | Failed to buffer the request body: deflate decompression error | raw deflate without zlib wrapper |
| [event-deflate-zlib.json](event-deflate-zlib.json) | POST `/api/8/envelope/` | 200 | {"id":"755cc69dad1b4312985396c20af5c24c"} | HTTP deflate = zlib wrapper (RFC 9110) |
| [event-double-trailing-newline.json](event-double-trailing-newline.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["unexpected end of file"]} | extra empty line at the end |
| [event-gzip-header-plain-body.json](event-gzip-header-plain-body.json) | POST `/api/8/envelope/` | 400 | Failed to buffer the request body: Invalid gzip header | Content-Encoding gzip but body not compressed |
| [event-gzip.json](event-gzip.json) | POST `/api/8/envelope/` | 200 | {"id":"cb9a8a6067a640e2aebf76ef8b2e7e27"} |  |
| [event-length-short-no-newline.json](event-length-short-no-newline.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["missing newline after header or payload"]} | length shorter than payload: byte after payload is not a newline |
| [event-length-too-long.json](event-length-too-long.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["unexpected end of file"]} |  |
| [event-no-length.json](event-no-length.json) | POST `/api/8/envelope/` | 200 | {"id":"36e56e2c50ed40cea0fcd9b7724569a6"} | item without length: payload runs to next newline |
| [event-no-trailing-newline.json](event-no-trailing-newline.json) | POST `/api/8/envelope/` | 200 | {"id":"36e56e2c50ed40cea0fcd9b7724569a6"} | envelope ends right after the payload |
| [event-plain.json](event-plain.json) | POST `/api/8/envelope/` | 200 | {"id":"ff562c370e33407b98236dd8193d01da"} | error event, length header, X-Sentry-Auth |
| [event-x-gzip.json](event-x-gzip.json) | POST `/api/8/envelope/` | 415 |  |  |
| [event-zstd.json](event-zstd.json) | POST `/api/8/envelope/` | 200 | {"id":"0fbca83b8e8a43ec860b0f7d6c73044e"} |  |
| [header-only-no-items.json](header-only-no-items.json) | POST `/api/8/envelope/` | 200 | {"id":"895b756f650a4596aaa1f48e3760aa75"} | envelope header and no items |
| [item-attachment-no-event.json](item-attachment-no-event.json) | POST `/api/8/envelope/` | 200 | {"id":"14b9c0ba542440808f1ceae950281848"} | attachment without an event item |
| [item-attachment.json](item-attachment.json) | POST `/api/8/envelope/` | 200 | {"id":"7998b1f02baa458baf1c2da51717fee7"} |  |
| [item-check_in.json](item-check_in.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-client_report.json](item-client_report.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-feedback.json](item-feedback.json) | POST `/api/8/envelope/` | 200 | {"id":"ce766a81f3e44c6d8b4b123c0a710bde"} |  |
| [item-header-not-json.json](item-header-not-json.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["invalid item header","key must be a string a |  |
| [item-integration-forbidden.json](item-integration-forbidden.json) | POST `/api/8/envelope/` | 400 | {"detail":"envelope contains internal items"} |  |
| [item-log-container.json](item-log-container.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-log-count-mismatch.json](item-log-count-mismatch.json) | POST `/api/8/envelope/` | 200 | {} | item_count 5 but 2 items |
| [item-profile_chunk-minimal.json](item-profile_chunk-minimal.json) | POST `/api/8/envelope/` | 200 | {} | structurally minimal; accepted at the edge, validity decided async |
| [item-replay-event-only.json](item-replay-event-only.json) | POST `/api/8/envelope/` | 200 | {"id":"62649a29ef4440bfa140a17c472d1ba3"} | replay_event without replay_recording |
| [item-replay-recording-only.json](item-replay-recording-only.json) | POST `/api/8/envelope/` | 200 | {"id":"62649a29ef4440bfa140a17c472d1ba3"} | standalone recording |
| [item-replay-two-events.json](item-replay-two-events.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'replay_event' (https://develop.sentry.d |  |
| [item-replay-web-segment0.json](item-replay-web-segment0.json) | POST `/api/8/envelope/` | 200 | {"id":"62649a29ef4440bfa140a17c472d1ba3"} |  |
| [item-replay-web-segment1-uncompressed.json](item-replay-web-segment1-uncompressed.json) | POST `/api/8/envelope/` | 200 | {"id":"62649a29ef4440bfa140a17c472d1ba3"} | recording body not compressed (starts with '[') |
| [item-replay-web-segment2-gzip-body.json](item-replay-web-segment2-gzip-body.json) | POST `/api/8/envelope/` | 200 | {"id":"62649a29ef4440bfa140a17c472d1ba3"} | recording body gzip instead of zlib |
| [item-replay_video-empty-video.json](item-replay_video-empty-video.json) | POST `/api/8/envelope/` | 200 | {"id":"0f40d9e1d7dd4938bd8c8f0b9a555d67"} |  |
| [item-replay_video.json](item-replay_video.json) | POST `/api/8/envelope/` | 200 | {"id":"0fa16ee44572493da849817ed72e01c9"} | msgpack map {replay_event, replay_recording, replay_video} |
| [item-session-in-error-envelope.json](item-session-in-error-envelope.json) | POST `/api/8/envelope/` | 200 | {"id":"9a605f1404b04b4b86ed25ef3ec9dfea"} |  |
| [item-session-no-release.json](item-session-no-release.json) | POST `/api/8/envelope/` | 200 | {} | session without attrs.release (required) is dropped async, not at the edge |
| [item-session.json](item-session.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-sessions.json](item-sessions.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-span-legacy.json](item-span-legacy.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-span-v2-container.json](item-span-v2-container.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-trace_metric-container.json](item-trace_metric-container.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-transaction.json](item-transaction.json) | POST `/api/8/envelope/` | 200 | {"id":"044bf5fba7ee4cd78fc83081fe9e7694"} |  |
| [item-unknown-type.json](item-unknown-type.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [item-user_report.json](item-user_report.json) | POST `/api/8/envelope/` | 200 | {"id":"ff562c370e33407b98236dd8193d01da"} |  |
| [limit-101-client-reports.json](limit-101-client-reports.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'client_report' (https://develop.sentry. | max_client_reports_count = 100 |
| [limit-501-items.json](limit-501-items.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["too many individual items"]} | MAX_ENVELOPE_ITEMS = 500 |
| [limit-event-over-1MiB.json](limit-event-over-1MiB.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'event' (https://develop.sentry.dev/sdk/ | event item > max_event_size (1 MiB) |
| [limit-gzip-210MiB-decompressed.json](limit-gzip-210MiB-decompressed.json) | POST `/api/8/envelope/` | 413 | Failed to buffer the request body: length limit exceeded | 214144 compressed bytes, 210 MiB after gunzip (> max_envelope_size 200 MiB) |
| [limit-log-over-2MiB.json](limit-log-over-2MiB.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'log' (https://develop.sentry.dev/sdk/en |  |
| [limit-nginx-101MiB-raw.json](limit-nginx-101MiB-raw.json) | POST `/api/8/envelope/` | 413 | <html> <head><title>413 Request Entity Too Large</title></head> <body> <center><h1>413 Req | raw body > nginx client_max_body_size 100m |
| [limit-replay-recording-over-10MiB.json](limit-replay-recording-over-10MiB.json) | POST `/api/8/envelope/` | 413 | {"detail":"envelope exceeded size limits for type 'replay_recording' (https://develop.sent |  |
| [malformed-header.json](malformed-header.json) | POST `/api/8/envelope/` | 400 | {"detail":"invalid event envelope","causes":["invalid envelope header","key must be a stri |  |
| [otlp-logs-json.json](otlp-logs-json.json) | POST `/api/8/integration/otlp/v1/logs` | 200 | {} |  |
| [otlp-metrics-json.json](otlp-metrics-json.json) | POST `/api/8/integration/otlp/v1/metrics` | 404 |  | metrics are not an OTLP route in Relay 26.10.0 |
| [otlp-short-path.json](otlp-short-path.json) | POST `/api/8/otlp/v1/traces` | 404 |  | path without /integration/ |
| [otlp-traces-bad-content-type.json](otlp-traces-bad-content-type.json) | POST `/api/8/integration/otlp/v1/traces` | 415 | {"code":3,"message":"unsupported content type: text/plain"} |  |
| [otlp-traces-bearer-auth.json](otlp-traces-bearer-auth.json) | POST `/api/8/integration/otlp/v1/traces` | 401 | {"code":16,"message":"missing authorization information"} | Authorization: Bearer is not an accepted form |
| [otlp-traces-gzip.json](otlp-traces-gzip.json) | POST `/api/8/integration/otlp/v1/traces` | 200 | {} |  |
| [otlp-traces-json-trailing-slash.json](otlp-traces-json-trailing-slash.json) | POST `/api/8/integration/otlp/v1/traces/` | 200 | {} |  |
| [otlp-traces-json.json](otlp-traces-json.json) | POST `/api/8/integration/otlp/v1/traces` | 200 | {} |  |
| [otlp-traces-no-auth.json](otlp-traces-no-auth.json) | POST `/api/8/integration/otlp/v1/traces` | 401 | {"code":16,"message":"missing authorization information"} |  |
| [otlp-traces-protobuf.json](otlp-traces-protobuf.json) | POST `/api/8/integration/otlp/v1/traces` | 200 |  |  |
| [ratelimit-key-1-per-60s-try1.json](ratelimit-key-1-per-60s-try1.json) | POST `/api/8/envelope/` | 429 | {"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This w | project key rateLimit {window:60,count:1} set temporarily via API |
| [ratelimit-key-1-per-60s-try2.json](ratelimit-key-1-per-60s-try2.json) | POST `/api/8/envelope/` | 429 | {"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This w | project key rateLimit {window:60,count:1} set temporarily via API |
| [ratelimit-key-1-per-60s-try3.json](ratelimit-key-1-per-60s-try3.json) | POST `/api/8/envelope/` | 429 | {"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This w | project key rateLimit {window:60,count:1} set temporarily via API |
| [ratelimit-key-1-per-60s-try4.json](ratelimit-key-1-per-60s-try4.json) | POST `/api/8/envelope/` | 429 | {"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This w | project key rateLimit {window:60,count:1} set temporarily via API |
| [ratelimit-key-mixed-event-plus-session.json](ratelimit-key-mixed-event-plus-session.json) | POST `/api/8/envelope/` | 429 | {"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This w | error is limited, session is not: whole request answers 429, the session item is still queued |
| [ratelimit-key-session-while-limited.json](ratelimit-key-session-while-limited.json) | POST `/api/8/envelope/` | 200 | {} |  |
| [ratelimit-key-transaction-while-limited.json](ratelimit-key-transaction-while-limited.json) | POST `/api/8/envelope/` | 200 | {"id":"0a3776ca3d2d4e5f8efb9323651a5f73"} |  |
