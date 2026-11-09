# RUM semantic conventions: sources, rules and what is settled

Step 2 of the post-MVP plan. This entry holds the sources, the naming rule and the event-or-span rule that the other entries in this folder apply. It answers the cross-cutting questions in [otel-step2-questions.md](../questions-for-step-2.md). Everything marked **Proposed** is our recommendation until the founder approves it.

## Sources read on 2026-11-09

| Source | Version |
|---|---|
| `open-telemetry/semantic-conventions` ("core") | release v1.45.0 (2026-11-02), `main` at `be58305` |
| `open-telemetry/semantic-conventions-client-side` | v0.1.0-dev (2026-10-27), `main` at `3c66733`, schema `client-side-dev/0.1.0-dev`, pinned to core 1.45.0 |
| `open-telemetry/opentelemetry-browser` | browser-sdk v0.7.0, browser-instrumentation v0.10.0 (2026-10-30), `main` at `f840e4d`. All experimental |
| `open-telemetry/opentelemetry-android` | v1.8.1 (2026-11-05), `main` at `0874416`, with its own local registry in `semconv/model/android/` |
| `open-telemetry/opentelemetry-swift` | 2.6.0 (2026-10-01), `main` at `c024074` |
| `open-telemetry/opentelemetry-js-contrib` | `instrumentation-document-load` 0.70.0 |
| SIG record | Client-side and browser issue threads that report the Oct 22, Oct 27, Oct 29 and Nov 3 calls. The two public SIG notes documents were searched by keyword, not read in full |
| React Native | **OTel has no React Native repository** (organisation search, empty) |
| Vendor names, for gaps only | sentry-javascript 11.11.0, sentry-cocoa `5a60a80`, Datadog browser-sdk 7.17.0, dd-sdk-ios `ad5ed83`, posthog-js 1.447.3, posthog-ios `911fd9d`. Step 6 researches these properly |

## The state of OTel in one paragraph

**Everything client-side is Development, except the `exception` event and the `exception.*` attributes, which are Stable.** Client-side conventions are moving from core to the new registry. Browser navigation, navigation timing, resource timing and console have already landed there. `app`, `session` (client-side PR #48, core PR #4306) and `device` (PR #51, core PR #4308) are open PRs that move the names unchanged. `browser.web_vital` is still in core. Issue client-side #34 is taking the remaining browser decisions to the SIG one at a time.

## Status words used in these entries

| Status | Meaning |
|---|---|
| Stable | Stable in core |
| Dev core | Development in core 1.45.0 |
| Dev client | Development in client-side 0.1.0-dev |
| SDK only | Emitted by an OTel SDK but in no shared registry. The Android local registry counts here |
| Draft | In an open PR or an open issue only |
| None | OTel is silent. The name is ours |

Confidence is how sure we are that the final OTel convention will match what we emit.

## Naming rule (answers Q3) — Proposed

Take the first of these that exists:

1. A name in core or the client-side registry, as written, even if Development.
2. A name an official OTel SDK already emits, unprefixed. Examples: `browser.user_action.click`, `device.anr`, `app.navigation.complete`, `start.type`.
3. An `ouo.` name.

Why tier 2 stays unprefixed: these are the names the eventual convention is most likely to start from, and they let telemetry from a stock OTel SDK land in the same place as ours. The cost is that it is not strictly "custom attributes get `ouo.`". **Founder decision D1.**

When a Development name changes, the SDK sends its `schema_url`, and one rename table in the Collector maps old names to new ones. Backends and dashboards see only the current name. Nothing in the SDK needs an urgent release. The client-side migrations keep names and change only the schema URL, so this is cheap so far.

## Event or span

Step 1 measured that an event and a span differ by about 13 gzipped bytes in a batch ([cost comparison](../storage-backends/signal-choice-and-backends.md)). So cost is not the decider. What decides is whether the data survives the client dying and whether it needs structure:

| Question | If yes |
|---|---|
| Must it survive tab or process death at any moment? | Event |
| Is it a moment, or a measurement a platform API reports after the fact? | Event |
| Does it need to be the parent of, or the same trace as, a backend call? | Span |
| Is it a duration whose start and end are both known exactly? | It can be a span, created **after the fact** with explicit timestamps, so it is never open |

The OTel browser model states the same bias: avoid "using a span when it could be a log", and prefer definitively reported timing in logs ([browser-observability-model.md](https://github.com/open-telemetry/opentelemetry-browser/blob/main/docs/browser-observability-model.md)). Its reason is that browsers have no native context propagation, so a click cannot reliably parent its fetch.

**Rule for us: spans are reserved for network calls and two load phases (document load, app start). Everything else is an event.**

## Where OTel's own SDKs disagree

| Topic | One side | Other side | We follow |
|---|---|---|---|
| Document load | js-contrib: 3 span levels (`documentLoad`, `documentFetch`, one `resourceFetch` each) with span events | Browser SIG (Oct 22, PR #504 draft): one `documentLoad` span, timing as separate events, no children, no span events | Browser SIG |
| Crash event name | Core and Android: `app.crash` | Swift KSCrash: `device.crash` | Core |
| Click | Web SDK: `browser.user_action.click` | Android and core: `app.screen.click`, `app.widget.click` | Each platform's own, until #34 decides |
| User interaction | js-contrib: span per interaction, needs Zone.js | Browser SDK: point-in-time event, Zone-free | Browser SDK |
| Screen tracking | Android: `Created`/`Resumed`/... lifecycle spans | Android Compose: `app.navigation.complete` event | Event |
| App launch | Android: `AppStart` span per launch | Swift: MetricKit 24-hour aggregate spans | Android shape |
| Session defaults | Android: 15 min background, 4 h max | Swift: 30 min, max optional. Browser: no defaults | Ours, Step 3 |
| Session attribution | Browser: `session.id` only | Swift: `session.id` and `session.previous_id` on every record | Browser |

## Other cross-cutting answers — Proposed

**Q4, `event_name` on Loki.** The Collector copies `EventName` to the attribute `otel.event.name` before the Loki exporter. That attribute is Stable, and core says it "SHOULD be used by non-OTLP exporters" when the destination has no such field. Do not use `event.name`, which is deprecated. Loki's OTLP path is technically OTLP but drops the field ([Step 1](../storage-backends/signal-choice-and-backends.md)), so this is the intended use in spirit.

**Q5, clock skew.** Validate at the edge, because that is the only place it can be guaranteed: a Collector processor replaces any `time_unix_nano` outside the window Loki accepts with the observed time and sets `ouo.time.corrected=true`. Whether the SDK also estimates an offset is a Step 3 question.

Q1 and Q2 are answered in [propagation-and-resources.md](propagation-and-resources.md). Q22 is in [sessions.md](sessions.md).

## The signal entries

- [Web vitals and mobile performance](performance.md)
- [Errors and crashes](errors.md)
- [Clicks and taps](interactions.md)
- [Navigation and screens](navigation.md)
- [Sessions](sessions.md)
- [Replay](replay.md)
- [Propagation, resources and entities](propagation-and-resources.md)
- [Questions for Step 3](questions-for-step-3.md)
