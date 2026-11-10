# Fixtures

Redacted sample responses from self-hosted Sentry 26.10.0, captured 2026-11-10 with [../scripts/capture_fixtures.py](../scripts/capture_fixtures.py). Each `<name>.json` (or binary) has a `<name>.headers.txt` with the request path, status and the headers that matter. DSN keys, emails, IP addresses, avatar and device hashes are redacted. Replay, event, trace and issue ids are kept (they are not secrets).

| Path | What it is |
|---|---|
| [event-attachments.json](event-attachments.json) | `/events/{id}/attachments/` (empty) ([headers](event-attachments.headers.txt)) |
| [eventid-lookup.json](eventid-lookup.json) | `/organizations/{org}/eventids/{id}/` (event trimmed) ([headers](eventid-lookup.headers.txt)) |
| [events-errors.json](events-errors.json) | Discover `dataset=errors` ([headers](events-errors.headers.txt)) |
| [events-logs.json](events-logs.json) | Explore `dataset=logs` for one trace ([headers](events-logs.headers.txt)) |
| [events-spans.json](events-spans.json) | Explore `dataset=spans` for one trace ([headers](events-spans.headers.txt)) |
| [issue-event-latest.json](issue-event-latest.json) | `/issues/{id}/events/latest/` (breadcrumbs trimmed) ([headers](issue-event-latest.headers.txt)) |
| [issue-events.json](issue-events.json) | `/issues/{id}/events/` ([headers](issue-events.headers.txt)) |
| [issues-list.json](issues-list.json) | `/organizations/{org}/issues/` one issue ([headers](issues-list.headers.txt)) |
| [orgs-list.json](orgs-list.json) | `GET /organizations/` with `links.regionUrl` ([headers](orgs-list.headers.txt)) |
| [project-keys.json](project-keys.json) | `GET /projects/{org}/{project}/keys/` (keys redacted; the key id is the public key) ([headers](project-keys.headers.txt)) |
| [projects-list.json](projects-list.json) | `GET /organizations/{org}/projects/` (first 2) ([headers](projects-list.headers.txt)) |
| [recording-segment-download-web.json](recording-segment-download-web.json) | R6 `?download` of one segment ([headers](recording-segment-download-web.headers.txt)) |
| [recording-segment-meta.json](recording-segment-meta.json) | R5 segment metadata ([headers](recording-segment-meta.headers.txt)) |
| [recording-segments-browser-sdk-11.11.0.json](recording-segments-browser-sdk-11.11.0.json) | R4 segment list, real `@sentry/react` 11.11.0 replay (5 segments) ([headers](recording-segments-browser-sdk-11.11.0.headers.txt)) |
| [recording-segments-mobile-page1.json](recording-segments-mobile-page1.json) | R4 first page (3 segments) of a mobile replay, shows the `video` custom event ([headers](recording-segments-mobile-page1.headers.txt)) |
| [recording-segments-web.json](recording-segments-web.json) | R4 segment list, synthetic web replay ([headers](recording-segments-web.headers.txt)) |
| [releases-health.json](releases-health.json) | `/organizations/{org}/releases/?health=1` ([headers](releases-health.headers.txt)) |
| [replay-clicks.json](replay-clicks.json) | R8 clicks (empty) ([headers](replay-clicks.headers.txt)) |
| [replay-count.json](replay-count.json) | R10 replay-count with `returnIds=true` ([headers](replay-count.headers.txt)) |
| [replay-details.json](replay-details.json) | R2 org-level replay details ([headers](replay-details.headers.txt)) |
| [replay-video-range.bin](replay-video-range.bin) | R7 with `Range: bytes=0-31` (206) ([headers](replay-video-range.bin.headers.txt)) |
| [replay-video-segment0.mp4](replay-video-segment0.mp4) | R7 mp4 of mobile segment 0 (binary, 4 KB) ([headers](replay-video-segment0.mp4.headers.txt)) |
| [replay-viewed-by.json](replay-viewed-by.json) | R12 viewed-by, trimmed to id/name/email (redacted) ([headers](replay-viewed-by.headers.txt)) |
| [replays-events-meta.json](replays-events-meta.json) | R11 private replays-events-meta ([headers](replays-events-meta.headers.txt)) |
| [replays-list-browser-sdk.json](replays-list-browser-sdk.json) | R1 one `@sentry/react` 11.11.0 replay ([headers](replays-list-browser-sdk.headers.txt)) |
| [replays-list-fields.json](replays-list-fields.json) | R1 with explicit `field=` list ([headers](replays-list-fields.headers.txt)) |
| [replays-list-mobile.json](replays-list-mobile.json) | R1 one iOS (React Native) replay ([headers](replays-list-mobile.headers.txt)) |
| [replays-list.json](replays-list.json) | R1 one synthetic web replay, all default fields ([headers](replays-list.headers.txt)) |
| [sessions-by-status.json](sessions-by-status.json) | `/sessions/` grouped by `session.status` ([headers](sessions-by-status.headers.txt)) |
| [sessions-groupby-session-id-rejected.json](sessions-groupby-session-id-rejected.json) | `/sessions/` rejecting `groupBy=session.id` (400) ([headers](sessions-groupby-session-id-rejected.headers.txt)) |
| [sessions-grouped.json](sessions-grouped.json) | `/sessions/` grouped by project and release ([headers](sessions-grouped.headers.txt)) |
| [tag-user-values.json](tag-user-values.json) | `/organizations/{org}/tags/user/values/` (first 3) ([headers](tag-user-values.headers.txt)) |
| [trace-meta.json](trace-meta.json) | `/trace-meta/{id}/` counts ([headers](trace-meta.headers.txt)) |
| [trace.json](trace.json) | `/trace/{id}/` tree ([headers](trace.headers.txt)) |

## measurements/

| Path | What it is |
|---|---|
| [measurements/scope-matrix.json](measurements/scope-matrix.json) | HTTP status of 30 GET endpoints × 10 tokens (kinds and scopes, no token values) |
| [measurements/ingest-latency-runs.json](measurements/ingest-latency-runs.json) | Five runs of the ingest-to-API visibility probe |
| [measurements/muninn-pull-report.json](measurements/muninn-pull-report.json) | Output of `muninn_pull.py` on a web SDK, a mobile and a synthetic replay |
| [measurements/routes-26.10.0.json](measurements/routes-26.10.0.json) | 253 relevant API routes dumped from Django's URL resolver: class, `publish_status`, scope maps, rate limits |
| [measurements/webhook-halted-restricted-ip.log](measurements/webhook-halted-restricted-ip.log) | Taskworker log lines showing webhooks halted with `restricted_ip` |
