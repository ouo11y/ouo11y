# Competitors: session and replay models

Status: seeded from the vision review on 2026-10-06. Verify against current docs before relying on specifics.

## Question

How do established RUM products define sessions and session status, so ouo's choices are familiar to users.

## Notes

- **Sentry**: sessions are `ok`, `errored`, `crashed`, `abnormal`. Web: unhandled error marks the session crashed; handled error marks it errored. Mobile sessions end when the app is backgrounded for more than 30 seconds. Health is shown per release. ouo's ADR-0004 follows this convention.
- **Datadog RUM**: session expires after 15 minutes of inactivity, max 4 hours. Views are first-class. Replay is sampled independently of telemetry.
- **Grafana Faro**: Apache-2.0 web SDK, sessions with 15 min inactivity and 4 h max by default, sends OTLP-ish signals to Grafana Alloy. No open-source replay. Worth reading for the session manager and the `faro` meta attributes.
- **PostHog**: open-source replay on rrweb, chunks recorded data into "snapshot" events stored in ClickHouse and S3. No backend trace correlation.
- **OpenReplay**: open-source replay with its own tracker (not rrweb), stores sessions in ClickHouse and object storage.

## Gotchas

- The 30 minute inactivity default in ouo is longer than Datadog's 15 minutes. It is configurable; revisit after real usage.
