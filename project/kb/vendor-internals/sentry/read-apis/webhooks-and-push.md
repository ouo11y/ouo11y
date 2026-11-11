# Push instead of polling: webhooks, forwarding and export

> Can Sentry tell Muninn that a new replay or error exists, or must Muninn poll?

Versions: Sentry self-hosted 26.10.0. Research date 2026-11-10.

**Short answer: there is no replay webhook. Muninn must poll for replays.** Webhooks exist for issues and errors only, and self-hosted blocks them to private IPs by default.

## Internal integration webhooks

Resources a Sentry App can subscribe to, and the events they expand to ([sentry_apps/utils/webhooks.py#L86-L124](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/sentry_apps/utils/webhooks.py#L86-L124)):

| Resource | Events |
|---|---|
| `issue` | `issue.created`, `issue.resolved`, `issue.ignored`, `issue.assigned`, `issue.unresolved` |
| `error` | `error.created` (every error event) |
| `comment` | `comment.created/updated/deleted` |
| `seer` | Seer autofix lifecycle |
| `preprod_artifact` | mobile build size / distribution |
| alert rule actions | `event_alert`, `metric_alert` (when `isAlertable` and used in an alert rule) |
| `installation` | install / uninstall |

No `replay`, `session`, `span`, `log` or `profile` resource exists in 26.10.0.
Docs: [Webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/) (accessed 2026-11-10).

### Observed on self-hosted

1. Created an internal integration with scopes `org:read project:read event:read`, resources `issue` + `error`, webhook URL `http://host.docker.internal:4550/hook` (`POST /api/0/sentry-apps/`, `isAlertable` must be sent, else 400). Response `webhookEvents`: `error.created, issue.assigned, issue.created, issue.ignored, issue.resolved, issue.unresolved`.
2. Started a listener on port 4550 and confirmed the taskworker container could reach it.
3. Sent a fresh error with a new fingerprint at 03:27:35.
4. The taskworker tried to send `error.created` and `issue.created` at 03:27:47 (**~12 s after the event was sent**), but halted both: `outcome_reason='send_and_save_webhook_request.restricted_ip'` ([webhook-halted-restricted-ip.txt](fixtures/measurements/webhook-halted-restricted-ip.txt)). Nothing reached the listener.
5. Cause: `SENTRY_DISALLOWED_IPS` blocks private ranges for outbound requests ([conf/server.py#L117](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/conf/server.py#L117), [net/socket.py#L21-L45](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/net/socket.py#L21-L45)). The self-hosted config leaves the override commented out ([sentry.conf.example.py#L115](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py#L115)). The coordinator's config was not changed.

So, for self-hosted customers, webhooks to an in-cluster Muninn need the operator to edit `SENTRY_DISALLOWED_IPS`, or Muninn must be reachable on a public address. Payload shape was therefore **not captured**; see the docs for `error.created` (contains the full event, with `contexts.replay.replay_id` when the SDK set it).

### What webhooks are still good for

`error.created` carries the replay id of errors captured during a replay. Muninn can use it as a **hint** to sync that replay sooner (the replay is listable ~4 s after the SDK sends it, the webhook arrives ~12 s after). It does not replace polling: session replays without errors never trigger anything.

## Other push or bulk options

| Option | What it sends | Replays? | Source |
|---|---|---|---|
| Legacy service hooks `projects/{org}/{proj}/hooks/` | `event.alert`, `event.created` | no | feature `projects:servicehooks`, default **off** ([features/permanent.py#L160](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/features/permanent.py#L160)) |
| Data forwarding (Segment, Splunk, Amazon SQS) | error events | no | feature `organizations:data-forwarding` default on ([permanent.py#L66](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/features/permanent.py#L66)); [docs](https://docs.sentry.io/organization/integrations/data-forwarding/), accessed 2026-11-10 |
| Data export `organizations/{org}/data-export/` | Discover/issue CSV, async, emailed | no | **private** ([data_export.py#L306](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/data_export/endpoints/data_export.py#L306)) |
| Self-hosted only: read Kafka (`ingest-replay-events`, `ingest-replay-recordings`; observed topic list) or ClickHouse/filestore directly | everything | yes | not an API; see the wire/storage agent's entries in `project/kb/vendor-internals/sentry/` |

**Muninn can use it for:** `issue`/`error` webhooks as low-latency hints; polling for everything else.
