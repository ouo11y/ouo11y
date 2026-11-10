# Step 4: target features (2026-11-10)

## What was done

Built a catalog of 125 SDK features in 20 groups, researched what Sentry, Datadog and PostHog ship for each on web, iOS, Android and React Native, and recommended a target for every feature, with its reason and the spec section that covers it. Everything is in [project/kb/client-sdk-features/](../../../kb/client-sdk-features/index.md). Docs and a generator script only; no product code changed.

| Entry | Content |
|---|---|
| [catalog.md](../../../kb/client-sdk-features/catalog.md) | Feature ids |
| [vendors/](../../../kb/client-sdk-features/vendors/index.md) | Six research files, one per vendor and web or mobile |
| [target-list.md](../../../kb/client-sdk-features/target-list.md) | Must 74, Should 23, Later 15, Never 13 |
| [gaps-for-step-7.md](../../../kb/client-sdk-features/gaps-for-step-7.md) | 27 spec gaps and answers to the spec's nine Step 4 questions |
| [mobile-replay-format-evidence.md](../../../kb/client-sdk-features/mobile-replay-format-evidence.md) | Wireframe against video, from 13 vendors, no decision |
| [feature-matrix.html](../../../kb/client-sdk-features/feature-matrix.html) | Generated, self-contained, filterable |

## Sources

Each vendor file names the SDK versions read (latest release on 2026-11-10) and cites source files at those tags; defaults come from code where docs were vague or wrong. Docs pages carry no update date, so they are cited as accessed 2026-11-10. `project/kb-archive/` and the SDK code in this repo were not used. Steps 1 to 3 in `project/kb/opentelemetry/` were the baseline.

Research ran as seven parallel sub-agents (three vendors by web and mobile, plus the replay-format evidence) with a shared catalog; I read every result, cross-checked the claims the target list relies on against the vendor files, and fixed five overstatements before writing the list.

## What the next agent must know

1. **Targets are recommendations.** The founder has not reviewed them.
2. **Headline.** Must is the full story on OTel; Never is product analytics (autocapture, identify, experiments, surveys, flag service) and client metrics; Should fills what users expect from vendors (TTFD, OOM, console logs, flags, feedback API, remote kill switch, WebView bridging, bot filtering).
3. **None of the three vendors sends RUM as OTLP.** PostHog sends logs as OTLP; Datadog accepts the OTel tracing API on mobile. Datadog propagates W3C trace context to an allowlist; Sentry makes it opt-in; PostHog uses its own headers.
4. **Vendor docs and code disagree** in several places (Datadog's privacy default and rage threshold, Sentry's long-animation-frame default, Sentry RN's on-error buffer length, Datadog iOS trace sample rate). Step 6 should read code.
5. **Mobile replay format is open.** Sentry is video at 1 fps; Datadog is wireframe; PostHog ships both and says most users prefer screenshots. Wireframes miss custom drawing, maps, video and much of SwiftUI; screenshot masking has leaked on OS changes (iOS 26).
6. **Gaps with Must rows:** G2 hang threshold, G5 flood guard, G9 rage threshold, G11 framework integrations, G17 query allowlist preset, G21 symbolication build ids.

## What was verified and how

| Check | Method | Result |
|---|---|---|
| Every catalog id has a target and a cell for every vendor and platform | `build_matrix.py` exits if not | Pass |
| HTML matches the Markdown | `build_matrix.py --check` | Pass. Not in CI yet: a CI step would catch drift |
| Every spec link points at a real heading | Anchors derived from the spec's headings, compared with the links | All match |
| Claims in the target list and gaps file | Read against the vendor rows by hand | Five fixed |
| `feature_flag.evaluation` exists | `model/feature-flags/events.yaml` at semconv v1.45.0 | Release candidate |
| Matrix renders, no external loads, no horizontal page scroll | Opened in the in-app browser; DOM checks | Pass |
| Links | `lychee --offline` | See PR |

**Not verified:** vendor cells were not run on devices; costs in the replay evidence are vendor numbers with their stated methods. Cells marked "uncertain" stay uncertain.

## Review

Reviewed in PR #174 by a separate agent (`Review: changes needed`, nine findings). All fixed: Datadog web masks inputs only, PostHog Android has opt-in dead taps, OTH-h vendor rows added and the generator now fails on a missing cell, Sentry's permissive defaults qualified as JavaScript-only, PostHog's rage window is per click gap, gap priorities explained, five smaller overstatements corrected, feature ids declared a separate namespace from spec requirement ids, and the "Where" legend completed.

## What is left

Founder review of the target list; Step 5 to price PERF-e and the overhead budgets; Step 7 to take the gaps.

## Dependencies added

None. The generator uses the Python standard library.
