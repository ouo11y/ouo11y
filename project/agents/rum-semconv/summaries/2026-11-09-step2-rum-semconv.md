# Step 2: RUM semantic conventions (2026-11-09)

## What was done

Read core semantic conventions v1.45.0, the client-side registry v0.1.0-dev, the OTel browser, Android, Swift and js-contrib repositories, and their open PRs and issues. Exact versions are in [rules.md](../../../kb/opentelemetry/rum-semantic-conventions/rules.md). Wrote nine kb entries in `project/kb/opentelemetry/rum-semantic-conventions/` and an [HTML signal table](../../../kb/opentelemetry/rum-semantic-conventions/signals-table.html). No product code changed. `project/kb-archive/` and the existing SDKs were not used.

## Findings the next agent must know

1. Only `exception` and `exception.*` are Stable. All other client conventions are Development or exist only in an SDK.
2. `session`, `app` and `device` are moving to the client-side registry in open PRs. Names stay; the schema URL changes.
3. The Browser SIG agreed on Oct 22 to one `documentLoad` span with timing as events (PR #504, draft). js-contrib still has three span levels.
4. Swift's crash event is `device.crash`; core and Android say `app.crash`.
5. OTel has no replay convention, no work in progress, and no React Native SDK.
6. `otel.event.name` is the Stable attribute for destinations without an `EventName` field. It answers how to keep the name on Loki.
7. The browser's session inactivity counts any telemetry, not user input.
8. Android sends two events for one tap on a widget.
9. Android and Swift both already sample by session.

## Decisions waiting on the founder

D1 to D5, in [questions-for-step-3.md](../../../kb/opentelemetry/rum-semantic-conventions/questions-for-step-3.md). Summary: unprefixed OTel SDK names; `browser.navigation` plus `documentLoad`; replay bytes to the Collector and a reference onward; diverging from SDK defaults on resource attributes and baggage; `ouo.view.id`.

## What was verified and how

| Check | Method |
|---|---|
| Conventions, stability, requirement levels | Read YAML models and generated docs at the versions listed |
| What SDKs emit | Read instrumentation READMEs and source |
| Open decisions | `gh` on the issues and PRs named in the entries |
| SIG outcomes | Issue threads reporting the calls, plus a keyword search of both public notes documents |
| Vendor names | Grep of each vendor's SDK source, at the commits listed. Some entries are blank where not checked. Not a study; Step 6 does that |
| Links | `lychee --offline` clean on the changed files |

**Not verified:** no SDK, Collector or backend was run. `signaltometrics` exponential histogram output is from memory. Predictions are judgment, and each states a confidence. Sentry's error shape in [errors.md](../../../kb/opentelemetry/rum-semantic-conventions/errors.md) is from memory plus one grep.

## What is left

- Founder decisions.
- Step 3 starts from [questions-for-step-3.md](../../../kb/opentelemetry/rum-semantic-conventions/questions-for-step-3.md), only after founder approval. Check its watch list first, because these repositories changed daily during this run.

## Dependencies added

None.

## Notes on this run

- The brief asked for a new worktree. The session's existing worktree was already at the required base commit `6753d67e`, so it was used.
- Written before Step 1 merged as flat `project/kb/` entries, then rebased on it and moved into a topic folder to follow the rule Step 1 added to `AGENTS.md`. The HTML table moved with them.
- Pushed as a PR at the founder's request. Founder decisions D1 to D5 are still open.
- No environment left running.
