# 2026-11-10: golden rule checklist

## What was done

- Collected 45 incidents where a monitoring or analytics SDK hurt its host app (Meta's 2020 iOS SDK crashes, Sentry, Firebase, Datadog, New Relic, PostHog, rrweb, OpenTelemetry JS, Application Insights, storage quota cases, token leaks), 14 vendor and platform guidance pages, and 13 of ouo's own faults from `project/kb-archive/`, git history and the code. `project/kb/client-sdk-safety/incidents/`.
- Wrote the 61-item checklist in 15 categories, each item with an id, a MUST rule, the motivating incident, platforms and an automated test. `checklist/golden-rule-checklist.md`.
- Graded web, React Native, iOS and Android with `file:line` evidence. `grades/current-sdks.md`.
- Proposed how the rule enters the SDK spec and the fix order. `spec-proposal/step-7-proposal.md`. The spec itself is untouched.
- Built `golden-rule.html` with `scripts/build_explainer.py` (standard library only, no dependency added).

## How it was verified

- The four known faults were read in the code on `origin/main` 3e9e2c11: `OuoReplayConfig.kt:29-30` and `ReplayRecorder.kt:315-318` (Android `jpegQuality`), `replay.ts:300` (RN token prefix), `network.ts:43-47` (RN header bag overwrites), `errors/install.ts:151-160` (Hermes tracker).
- Other grades come from a research pass; verdicts that rest on a search hit only are marked *(sampled)*.
- Internet sources come from search results, not full reads. Items seen only on mirror sites are marked *(mirror)*, with the canonical github.com URL rebuilt from the issue number.
- The explainer was opened in a browser: grade table renders, the platform filter works (57 of 61 items apply to RN).
- `lychee --offline` passes on the new files.

## What is left

- Step 7: apply the spec proposal, fix OUO-1..5, build the fault-injection harness (GR-CRASH-7) per SDK.
- Battery and startup are not measured (`?` in the grades).
- No public incident was found for a retry storm against an ingest endpoint, a Bugsnag host crash, or opentelemetry-android/-swift crashes.

## What the next agent must know

- Edit the Markdown, then run `python3 -I project/agents/sdk-safety/scripts/build_explainer.py`; the HTML is generated.
- The checklist sides with spec ERR-1 against today's web and RN behaviour of throwing on a missing token.
