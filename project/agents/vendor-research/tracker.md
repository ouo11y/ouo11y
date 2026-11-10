# vendor-research tracker

| Date | Event |
|---|---|
| 2026-11-10 | Step 6 run: Sentry (browser, iOS, Android, React Native, wire format, self-hosted storage, read APIs), Datadog and PostHog researched; captures from local demos; kb under `project/kb/vendor-internals/` |

## Open

- Founder review of the PR. Nothing here is a decision.
- Mobile replay format, wireframe or video first: more evidence in `project/kb/vendor-internals/mobile-replay-evidence.md`, not decided.
- Step 7 (spec review) input: `sentry/wire-format/ouo-receiver-gaps.md` (bridge), the reliability entries (what to copy or avoid), the browser `wire-capture.md` section 6 (fields the wire spec lacks).
- Step 8 (Muninn) input: `sentry/read-apis/muninn-sync-recipe.md` and the endpoint stability list in `sentry/read-apis/index.md`.
- Not verified anywhere: Sentry SaaS behaviour (regions, rate-limit values), webhook payloads, profiles read-back, Android NDK/ANR/app hang captures, Datadog Android and React Native captures, PostHog mobile captures, any real device.
