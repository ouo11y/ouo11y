# Sentry read APIs (for Muninn)

Which Sentry REST endpoints can Muninn, our replay store, use to read sessions, replays and everything joined to them when customers keep sending to Sentry (topology a)? Verified against self-hosted Sentry **26.10.0** on 2026-11-10, with source pinned to the `26.10.0` tag. Step 6 of the post-MVP plan, agent `sentry-read-api`. Start with the explainer.

| Path | What it is |
|---|---|
| [read-apis-explainer.html](read-apis-explainer.html) | Muninn's read path as a diagram, plus every endpoint in one filterable table |
| [replays.md](replays.md) | How do we list replays, read one, and download every rrweb segment and mobile mp4, and what are the traps? |
| [sessions.md](sessions.md) | What release-health session data can we read, and why is there no per-session detail? |
| [issues-and-events.md](issues-and-events.md) | How do we turn a replay's error ids into issues and full events, and query Discover? |
| [traces-spans-logs.md](traces-spans-logs.md) | How do we fetch the trace tree, spans and logs of a replay? |
| [profiles.md](profiles.md) | Which endpoints return profiles and profile chunks? (source only, no data locally) |
| [users-releases-projects.md](users-releases-projects.md) | How do we discover orgs, projects and DSNs, and where does end-user data live? |
| [auth-scopes-and-rate-limits.md](auth-scopes-and-rate-limits.md) | Which token kind and scopes does each read need, and how fast may we call? |
| [pagination.md](pagination.md) | How do Sentry cursors work per endpoint and how do we page without losing rows? |
| [webhooks-and-push.md](webhooks-and-push.md) | Can Sentry push new replays or errors to us, or must we poll? |
| [saas-vs-self-hosted.md](saas-vs-self-hosted.md) | What changes between sentry.io (regions, rate limits, flags) and self-hosted? |
| [muninn-sync-recipe.md](muninn-sync-recipe.md) | How should Muninn poll incrementally without missing replays or segments? |
| [scripts/](scripts/index.md) | Stdlib Python scripts: pull replays, measure ingest delay, scope matrix, capture fixtures, mint and revoke test tokens |
| [fixtures/](fixtures/index.md) | Redacted sample responses and the measurement results the entries cite |

## Top findings

1. **Replays: rely on four public endpoints.** List (`/organizations/{org}/replays/`), details (`/organizations/{org}/replays/{id}/`), segments (`/projects/{org}/{project}/replays/{id}/recording-segments/`, plus `/{segment_id}/?download`). Mobile video (`/videos/{segment_id}/`) works but is **experimental**. The project-level replay details GET is private.
2. **The segment list returns contents, not metadata, and hides gaps.** Use per-segment metadata to prove completeness.
3. **Time windows use SDK timestamps, not receive time.** A replay delivered 3 h late was invisible to a 1 h window. Sync needs overlapping hot, warm and cold scans.
4. **Real web replays mix ms and seconds timestamps** (`@sentry/react` 11.11.0 custom events use seconds).
5. **Data is visible fast:** replays 2.4–5.4 s after the SDK sent them, errors 5.5–7.6 s, spans 14.5–18 s, sessions about 50 s.
6. **Sessions are aggregates only.** No per-session id, user or timeline anywhere in the API.
7. **No replay webhook.** Issue/error webhooks exist but self-hosted blocks private IPs by default.
8. **Use an internal integration with `org:read project:read event:read` and always pass `project=-1`.** Org auth tokens see nothing without it.
9. **Self-hosted has no API rate limiting;** SaaS limits per endpoint (e.g. `eventids` 1/s, issues 10/s).
