# Spec gaps and answers, handed to Step 7

Step 4, 2026-11-10. What the [target list](target-list.md) needs that the [draft SDK spec](../opentelemetry/rum-semantic-conventions/sdk-spec.md) `0.1.0-draft` does not say, and Step 4's answers to the nine questions in spec [section 18](../opentelemetry/rum-semantic-conventions/sdk-spec.md#18-step-2-questions-and-what-passes-to-step-4). Step 7 reviews the spec with these, Step 5's measurements and Step 6's vendor internals. **Proposals, not decisions.**

## Answers to the spec's Step 4 questions

| # | Question | Step 4 answer | Evidence | Gap |
|---|---|---|---|---|
| 1 | First display or time to full display on mobile? | **Should.** Time to initial display automatic per screen view, time to full display by a manual `reportFullyDisplayed()` with a deadline | Sentry: TTFD manual, deadline 30 s iOS, 25 s Android. Datadog: TTID automatic, TTFD manual, plus iOS time-to-network-settled. PostHog: none | G7 |
| 2 | Should an unsampled session send recent breadcrumbs with its bypass errors? | **Should.** Keep a small in-memory ring of recent records in unsampled sessions and flush it with a bypass record, marked like the bypass record and counted against the cap | Sentry attaches up to 100 breadcrumbs to every error. PostHog keeps a 32 KB manual "exception steps" buffer. Datadog samples whole sessions | G4 |
| 3 | Is redacting every query value too strict for analytics? | **Keep the strict default.** Document an opt-in preset of campaign keys: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`. Leave click ids such as `gclid` out, since they identify a visit | All three vendors keep query values by default; Sentry v11 made collection permissive | G17 |
| 4 | Should a session span subdomains? | **Later, opt-in.** It needs a cookie scoped to the parent domain, which SES-12 forbids. Step 7 decides whether an opt-in cookie is allowed | Datadog `trackSessionAcrossSubdomains` (off). PostHog `cross_subdomain_cookie` (on unless the host is on a public-suffix list) | G1 |
| 5 | Per-signal rates, remote configuration, remote kill switch? | **No per-signal rates** (one session decision keeps the story whole). **Remote kill switch and rate override: Should**, served through the Collector | Datadog added remote config in 2026 (iOS 3.17, Android 3.14; web `@internal`). PostHog loads remote config on every start and gates most features with it. Sentry has none in the npm SDK | G16 |
| 6 | Which mobile replay format first? | **Not decided here, by the brief.** Evidence: [mobile-replay-format-evidence.md](mobile-replay-format-evidence.md) | Sentry is video only; Datadog is wireframe only; PostHog ships both and reports users prefer screenshots | none, founder decision |
| 7 | Should `browser.resource_timing` default on? | **Off until Step 5 prices it**, then on with a per-view cap and a first-party filter option | Sentry: resource spans on with tracing. Datadog: resources tracked by default. PostHog: network timing remote-toggled | G8 |
| 8 | Console logs, network bodies, feature flags, user feedback in scope? | Console as logs **Should** (opt-in). Network bodies **Later** (PRV-12 forbids today). Feature flags **Should** via OTel `feature_flag.evaluation`. Feedback API **Should**, widget Later | Sentry and PostHog show console in replay (Datadog uncertain); all three attach flag evaluations to errors; Sentry ships a feedback widget on all platforms; PostHog uses its survey widget; Datadog has none | G13, G22, G23 |
| 9 | Do heatmaps need document size as well as viewport? | **Yes, when heatmaps come** (Later): a page-relative click needs the document's scroll width and height to place it on a long page | Datadog and PostHog ship heatmaps; Sentry has none | G10 |

## Gaps

Priority follows the target of the rows that need it. "Rows" link back to the [target list](target-list.md).

| Gap | Rows | Target | What the spec lacks | Proposal for Step 7 |
|---|---|---|---|---|
| G1 | SES-c | Later | Cross-subdomain sessions | Opt-in `session.cookieDomain`; amend SES-12 for that case only |
| G2 | ERR-e | Must | A default hang threshold for SIG-07 | Pick one number per platform. Sentry iOS 2 s on; Datadog iOS off, 0.25 s suggested. Step 5 measures noise |
| G3 | ERR-f | Should | OOM, watchdog termination, exit reasons | Android `ApplicationExitInfo` reasons as an event; iOS MetricKit diagnostics and a next-launch heuristic. Needs a name under the naming rule |
| G4 | ERR-g | Should | Trail for unsampled sessions | Ring of the last N records or seconds, memory only, flushed with a bypass record (answer 2) |
| G5 | ERR-k | Must | Flood guard in sampled sessions | Per-type token bucket for `exception` and other events, dropped records counted by ERR-7 |
| G6 | PERF-b | Should | LCP element attribution | Optional attribute on the LCP event, sanitised like the INP target |
| G7 | PERF-h | Should | Time to initial and full display | Event or after-the-fact span per screen view; `reportFullyDisplayed()` in section 3.1 |
| G8 | PERF-e | Should | Resource timing cap | Per-view cap and an origin filter; default stays off until Step 5 |
| G9 | INT-c | Must | Rage threshold check | Spec says 4 clicks in 1 s; Datadog, PostHog and Sentry RN use 3 in 1 s, Datadog within 100 px, PostHog within 30 px. Step 7 aligns or explains |
| G10 | INT-h | Later | Document size for heatmaps | `ouo.document.width`, `.height` on clicks, when heatmaps are built (answer 9) |
| G11 | NAV-b to NAV-d, FWK | Must | Named framework integrations | List the integrations each platform ships (React Router, Next.js, React Navigation, Expo Router, SwiftUI, Compose, OkHttp) and the route-pattern naming each gives |
| G12 | RPL-d | Should | Iframes, shadow DOM, canvas | Same-origin iframes and open shadow roots recorded; canvas opt-in and always blocked unless unmasked by the app |
| G13 | LOG-b, RPL-f | Should | Console capture | Opt-in `instrumentations.console` with levels (default warn, error), each line a log record, argument size capped |
| G14 | RPL-j | Should | Replay idle pause and maximum length | Pause capture after N minutes without activity; stop a replay at a maximum length |
| G15 | USR-d | Should | Install or pseudo id for user counts | Opt-in random install id as a record attribute, never on the resource; ties to D4 |
| G16 | SMP-f | Should | Remote configuration | A kill switch and rate overrides only, fetched from the Collector, cached, never blocking `init`. Step 7 compares OpAMP with a static JSON document |
| G17 | PRV-d | Must | Recommended query allowlist | Document the campaign-key preset (answer 3) |
| G18 | PRV-g | Should | Global Privacy Control | Opt-in `privacy.respectGpc`: when the browser sends GPC, act as consent denied |
| G19 | CFG-e | Should | Loading model | Replay and other heavy parts loaded on demand; a CDN build; how lazy parts count against the bundle budget (section 13) |
| G20 | API-d | Should | View-scoped attributes | `setViewAttributes(map)`, cleared at the next view |
| G21 | SYM-a to SYM-e | Must | How records name their build for symbolication | Web: a build or debug id per bundle, readable by the server. Mobile: `app.build_id` exists; RN needs the JS bundle id too. Tooling (CLI, plugins) as its own spec |
| G22 | FF-a, FF-c | Should | Feature flag evaluations | Emit OTel `feature_flag.evaluation` (release candidate in semconv v1.45.0) through an OpenFeature hook; cap per session |
| G23 | FB-b | Should | User feedback | `recordFeedback(message, {email?})` as an event joined by `session.id`, triggering a buffered replay |
| G24 | OTH-d | Should | WebView bridging | The native SDK passes `session.id` and sampling into a WebView so the web SDK joins the same session instead of starting one |
| G25 | OTH-h | Should | Bot and crawler filtering | Do not start a session for known crawler user agents; SES-3 lets `init` in a visible page count as activity |
| G26 | OTH-g | Should | Changing a default without breaking installs | Consider PostHog's dated `defaults` snapshot as part of section 15 |
| G27 | OTH-g | Later | Battery-aware upload | Defer non-crash uploads on low battery or low-power mode, as Datadog does |

## Conflicts the research found in the spec

- **NET-c against PRV-12.** If network bodies ever become a target, PRV-12 must change. Step 4 keeps them Later.
- **Rage threshold** (G9) and **hang threshold** (G2) are judgement in the spec; the vendor numbers are in [vendors/](vendors/index.md).
- **Vendor docs disagree with vendor code** in several places (Datadog privacy default and rage threshold, Sentry's long-animation-frame default, Sentry RN's on-error buffer). Step 6 should read code, not docs.
