# How long and where Datadog keeps RUM data

- **Research date:** 2026-11-10. All sources accessed 2026-11-10.
- Datadog is SaaS-only. Internals below come from public blog posts and are marked as inference where they are.

## Retention defaults

<https://docs.datadoghq.com/data_security/data_retention_periods/>:

| Data | Retention |
|---|---|
| RUM sessions, views, actions, errors | 30 days |
| RUM resources, long tasks, vitals | **15 days** |
| Session Replay | 30 days; extended retention to 15 months per replay |
| Product Analytics events and user profiles | 15 months |
| Metrics generated from RUM | 15 months |

**Extended replay retention** (<https://docs.datadoghq.com/session_replay/>):
- Only for ended sessions.
- Applied automatically when a replay is added to a playlist or saved as a heatmap snapshot.
- Covers the replay only, not its RUM events.

## What decides what is stored ("RUM without Limits")

<https://docs.datadoghq.com/real_user_monitoring/rum_without_limits/retention_filters/>:
- Client sampling (`sessionSampleRate`) decides what is **sent**. Retention filters decide, server side at ingest, which sessions are **indexed**.
- Filter order: permanent (keep 1 % of sessions with APM traces; all Synthetics; all forced replays), then exclusion, then custom. The first match wins. Minimum rate 0.1 %.
- Once a session is retained, its later events are kept. A replay is kept only if its session is retained.
- Non-retained sessions still feed metrics and can go to the **Managed Archive**: 1, 3 or 6 months of cold storage, with recovery into the Explorer (<https://docs.datadoghq.com/real_user_monitoring/managed_archive/>).
- This is the backend counterpart to the SDK having no on-error replay buffer. Datadog moved the "keep only interesting sessions" decision to the server.

## Intake technical limits

<https://docs.datadoghq.com/real_user_monitoring/> (technical limitations):

| Limit | Value |
|---|---|
| Session length | 4 h; inactivity timeout 15 min |
| Events per session | 10 million |
| Attributes per event | 1 000 |
| Attribute depth | 20 |
| Event size | 1 MB |
| Intake payload | 5 MB |
| Maximum ingestion delay | 24 h |
| Source map | 500 MB |
| dSYM | 2 GB |

The SDK constants match these: 1 MB per event and 5 MB per batch on mobile; 18–24 h maximum batch age ([intake-and-batching.md](../wire-format/intake-and-batching.md)).

## Storage internals (public hints only)

- RUM events go to Datadog's event platform. **Husky** is its event store: writers consume Kafka, buffer, and upload columnar files to object storage, and queries read them back (<https://www.datadoghq.com/blog/engineering/introducing-husky/>).
- A Datadog job post says Husky backs Logs, RUM and APM (<https://careers.datadoghq.com/detail/7959705/>).
- **Inference:** the replay segments API takes `source=event_platform|blob`. Replay segments probably live either in the event platform or in plain blob storage, perhaps depending on age or size. Unverified.
- Replay images are uploaded separately and deduplicated by content hash on the client (browser `replayResourceCollection`; Android keeps sent hashes 30 days). Server-side dedup storage is not documented.
- Views are stored as one row per `view.id` with the highest `_dd.document_version`. `view_update` events are merged on the server. Inferred from the SDK contract; Datadog does not document it.
