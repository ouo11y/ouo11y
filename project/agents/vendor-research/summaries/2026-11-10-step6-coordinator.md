# 2026-11-10: Step 6 vendor research (coordinator)

## What was done

- Researched Sentry in depth on browser, iOS, Android and React Native, then Datadog and PostHog, under `project/kb/vendor-internals/`. Six research agents each owned one folder: `sentry/browser-sdk/`, `sentry/mobile-sdks/`, `sentry/wire-format/` with `sentry/self-hosted-storage/`, `sentry/read-apis/`, `datadog/`, `posthog/`. Their summaries sit next to this one.
- Ran self-hosted Sentry 26.10.0 (compose project `sentry-sbx`, `feature-complete`) and the ouo-env proxy for the whole run. Created five projects (`step6-browser`, `step6-react-native`, `step6-ios`, `step6-android`, `step6-wire`) and a local admin API token for the agents.
- Wrote the coordinator files: `project/kb/vendor-internals/index.md`, `sentry/index.md`, `sentry/sentry-explainer.html` (the end-to-end path and what it means for topologies a, b and c), `mobile-replay-evidence.md` (new measured numbers across vendors), this agent folder, and index rows in `project/kb/index.md` and `project/agents/index.md`.
- Demos: `examples/sentry-web/` (new), `examples/datadog-capture/` (new), `examples/posthog-capture/` (new), and flag-gated additions to `examples/sentry-mobile/` (Android build, `SENTRY_CAPTURE_ALL`, `SENTRY_REPLAY_MASK`, capture decoders). The sentry-mobile agent had bumped `@sentry/react-native` to 8.34.0 in `package.json`; I reverted that, because the bridge journey in CI runs on the committed 8.32.0. The captures were made with 8.34.0 installed locally, and the README says so.

## Verified, and how

- Every capture went through `collector/tools/sentrytap` to self-hosted Sentry, and the agents checked what landed in ClickHouse, nodestore, filestore and the API. Datadog and PostHog were captured with local capture servers; no SaaS account was created.
- Secrets: every file in the PR was scanned for the DSN public and secret keys of all eight local projects and for the API token, also inside zlib and gzip streams (the scanner was first shown to catch a key planted in a zlib stream). No hits. The macOS username in two iOS simulator paths was replaced by `<user>`. Docker gateway IPs are already masked (`192.168.65.x`).
- `examples/sentry-mobile`: `tsc --noEmit` passes.
- `lychee --offline` over the new files: see the PR description for the final count.

## Cross-cutting findings

- Sentry's Relay answers 200 for data it then drops (a gzip replay body, a replay event without its recording). Our bridge and Muninn cannot treat a 200 as proof of storage.
- None of the three vendors keeps browser telemetry across page loads by default (Sentry needs the opt-in offline transport, Datadog and PostHog queue in memory). All three mobile SDKs write to disk, with different drop rules: Sentry deletes on any 4xx or 5xx, PostHog native retries without a cap, Datadog keeps batches for its own retry rules.
- Mobile replay: Sentry is video (165 to 212 KB/min masked, observed), Datadog is wireframe only (34 KB/min on a simple screen, observed), PostHog has both. Datadog's browser SDK v7 no longer sends rrweb by default.
- Muninn can read Sentry replays through public endpoints, must poll (no replay webhook), and must scan overlapping windows because time filters use SDK timestamps.

## What is left

- Founder review of the PR.
- Gaps listed in `../tracker.md` under "Not verified".
- Teardown done at the end of the run: Sentry stopped (volumes kept), proxy stopped, the five Step 6 projects left in the local Sentry for later reading, the coordinator's API token revoked, the empty `step6-*` worktrees removed.

## What the next agent must know

- A hook allows writes only inside the session's own worktree. Sub-agents of one session cannot each own a worktree; they shared this one with disjoint folders and the coordinator committed.
- Two agents hit the 5-hour usage limit midway and were resumed after the reset; their staged drafts in the scratchpad survived.
