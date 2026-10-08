# ADR-0004 Healthy / errored / crashed classification

Status: accepted (2026-10-06)

## Context

The MVP's headline numbers are the percentages of healthy, errored and crashed sessions, for web and for mobile per app version. The classification must be deterministic from the events in Loki.

## Decision

Status is derived from `exception` and `http.request.failed` events carrying the session's `session.id`, with precedence crashed > errored > healthy:

| Status | Rule |
|---|---|
| `crashed` | at least one `exception` event with `ouo.exception.fatal = true` |
| `errored` | not crashed, and at least one `exception` event with `ouo.exception.fatal = false`, or at least one `http.request.failed` event |
| `healthy` | neither |

What counts as fatal:

- **Mobile**: an error reaching the global handler with `isFatal = true`, or a crash marker found on the next launch.
- **Web**: an uncaught exception (`window.onerror`) or an unhandled promise rejection. The page keeps running, but the session is counted as crashed, matching the convention used by Sentry for browser sessions. `console.error` and errors reported through `ouo.captureError()` are non-fatal.

`http.request.failed` is emitted for network failures and responses with status 500 to 599. 4xx responses are not errors for session health.

Percentages are computed over sessions whose `started_at` is in the selected range, grouped by `ouo.platform` and `service.version`.

## Consequences

- One query over Loki (session events plus exception events) suffices to classify every session in a range.
- The web definition of crashed is aggressive by design; it can be softened later with a config flag without changing the data model.
