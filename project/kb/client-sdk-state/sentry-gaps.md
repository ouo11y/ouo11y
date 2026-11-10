# ouo SDKs against Sentry: gap analysis

Where do our SDKs stand against Sentry's on each Must and Should feature from [Step 4's target list](../client-sdk-features/target-list.md)? Step 5, 2026-11-10. The filterable per-feature matrix with evidence and Sentry's configuration is in the [report](sdk-state-report.html#gaps).

## Method

- **Ours**: each platform auditor graded every Must and Should feature that applies (`full`, `partial`, `none`) with `file:line` evidence, in the same pass as the [compliance audit](compliance.md). A feature counts as `full` when it works, even if its names do not yet follow the spec: naming is the compliance audit's job.
- **Sentry**: the `Has` cells of Step 4's vendor files ([web](../client-sdk-features/vendors/sentry-web.md), [mobile](../client-sdk-features/vendors/sentry-mobile.md)), for sentry-javascript 11.11.0, sentry-cocoa 9.33.0, sentry-java 8.63.0 and sentry-react-native 8.34.0. No new Sentry research was needed. One cell was corrected: Step 4 marks web `TRN-g` (OTLP on the wire) as "yes", but its own text says Sentry sends envelopes, not OTLP.
- **Gap**: `large` Sentry has it fully and we do not have it; `medium` one level apart; `none` level; `ahead` we have more; `target only` neither has it fully, so the gap is to our own target. Computed by [`build_gaps.py`](../../agents/sdk-state/scripts/build_gaps.py).
- **Effort**: a rough size to close the gap on the platforms that need it: **S** up to a week, **M** one to three weeks, **L** more. A judgement from the audit notes, not an estimate anyone has committed to.

## Summary

| Platform | Must: none / ahead | Must: medium | Must: large | Must: target only | Should: large |
|---|---|---|---|---|---|
| Web | 25 / 6 | 19 | 3 | 4 | 9 |
| iOS | 18 / 4 | 23 | 5 | 7 | 4 |
| Android (standalone) | 3 / 0 | 26 | 20 | 8 | 9 |
| React Native | 14 / 4 | 32 | 4 | 5 | 6 |

Of the 74 Must features, 60 have a gap on at least one platform: 37 sized S, 19 M, 4 L. Most "medium" gaps are features we ship in a weaker or MVP-shaped form, so the work is mostly reshaping, not building. Android stands apart: Sentry ships a full native SDK, and ours exists only inside React Native.

## Top gaps (Must)

Ranked by how many platforms are behind and how far, then by effort.

| # | Feature | Gap | Effort | What we lack |
|---|---|---|---|---|
| 1 | SMP-e Errors kept in unsampled sessions | large on all four | S | Unsampled sessions send nothing, crashes included. Sentry samples errors separately. The spec's bypass set (SMP-5 to SMP-7) is the fix |
| 2 | PRV-f `beforeSend` hook | large on all four | S | No hook anywhere. Sentry has `beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb` |
| 3 | RPL-e Network requests in replay | large on iOS, Android, RN | M | Mobile replay has no network timeline. Sentry shows requests in replay on every platform |
| 4 | SMP-d Buffer-on-error replay | large on iOS, Android; medium on RN | M | No ring buffer on mobile. Sentry's `onErrorSampleRate` works on all three |
| 5 | ERR-h Fingerprint override | large on iOS, Android; medium web, RN | S | No app-supplied fingerprint attribute |
| 6 | USR-c Global attributes | large on web, Android; medium iOS, RN | S | No `setGlobalAttributes`; Sentry has tags, contexts, scope |
| 7 | ERR-d, ERR-e, PERF-f, PERF-g crashes, hangs, app start, frames | medium on iOS, Android, RN | L, M, M, S | All exist, as `exception` events or custom JSON reports; Android has no NDK crashes; hang threshold and in-progress persistence differ |
| 8 | RPL-c, RPL-g replay modes and masking | medium on most | M | Buffer mode, unmaskable secure fields, mask-on-failure drop |
| 9 | CFG-b, CFG-c switches, debug and drop counts | medium on all four | S, M | No per-instrumentation switches on mobile; no drop events or self-disable |
| 10 | REL-b crash-free sessions | medium on all four | S | Sessions and crashes exist; crashes in unsampled sessions are lost (see 1), so the rate is biased |

On Android alone, 20 Must features are large gaps (sessions, manual capture, trail, HTTP spans, propagation, screen views, user id, global attributes, logs, custom spans, release tagging and others). They are one gap: a native Android SDK with its own init, session and exporter, which Step 4 targets and ADR-0017 began.

## Top gaps (Should)

Large on some platform: vital attribution (PERF-b, web), console in replay and console as logs (RPL-f, LOG-b, web and RN), replay idle pause and max duration (RPL-j, web), attributes for the current view (API-d, all), build tooling for symbols (SYM-e, mobile), Next.js (FWK-b), feature-flag evaluations (FF-a, all) and OpenFeature (FF-c), feedback API (FB-b, web and Android), WebView bridging (OTH-d, iOS and RN). Twelve of the 23 Should features are size S.

## Where we are level or ahead

- **Ahead of Sentry**: one session shared across tabs on the web (SES-c; Sentry's replay session is per tab), session-level sampling that every signal follows on web, iOS and RN (SMP-a), OTel logs interop on web and RN (LOG-c), batching on mobile (TRN-a), compression on the web (TRN-d; Sentry's browser envelopes go uncompressed except replay), and a custom event API on web and iOS (API-a). Our telemetry is OTLP; Sentry's is not (TRN-g), though our replay is not OTLP yet either.
- **Level**: web errors and rejections, web vitals capture, HTTP spans, `traceparent`, rrweb replay, React integration, source maps.

## What this does not say

- It compares features, not quality. Whether our hang detection or masking is as good as Sentry's in the field is Step 6 (vendor internals) and Step 12 (refinement).
- Sentry cells marked "uncertain" or "partial" in Step 4 stay that way. Three cells are unknown (INT-e and USR-d on the web, RPL-i on RN).
- Effort sizes assume the spec work in [compliance.md](compliance.md) is done once, shared across platforms where it can be (sanitiser, sampling rule, bypass set).
