# Target features for the ouo SDKs

Step 4 of the post-MVP plan, 2026-11-10. Every row of the [catalog](catalog.md) gets one target. **These are recommendations for the founder, not decisions.** Evidence per vendor is in [vendors/](vendors/index.md); the [matrix](feature-matrix.html) shows both side by side.

| Target | Meaning |
|---|---|
| **Must** | In the first spec-conformant release of every platform where it applies |
| **Should** | Planned, after the Musts. The spec should leave room for it now |
| **Later** | Worth doing, not before the core is measured (Step 5) and the store exists (Step 8) |
| **Never** | Out of scope by design. Reopening it needs an ADR |

Where: **W** web, **M** mobile (iOS, Android and RN), **iOS**, **Android** or **RN** alone, **all**. Reasons name one or more of three tests:

- **OTel**: does it fit OpenTelemetry as written, or need a name we invent?
- **Story**: does it add to the full story from a user's session to the backend trace, which is our edge?
- **Cost**: build effort, bytes on the wire, overhead on the device, privacy risk.

Feature ids such as `ERR-a` or `PRV-e` are a namespace of their own. They are not the spec's requirement ids (`ERR-7`, `PRV-13`), which the "Spec" column always writes in full with a number.

"Spec" links the [draft SDK spec](../opentelemetry/rum-semantic-conventions/sdk-spec.md) section that covers the row. **G*n*** is a gap: the spec does not cover the row as targeted. Gaps go to Step 7 through [gaps-for-step-7.md](gaps-for-step-7.md).

## Sessions

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| SES-a | Automatic sessions | Must | all | Story: `session.id` is the join key for everything. OTel: `session.start`/`session.end` exist. All three vendors do it | [§5.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#51-start-and-activity) |
| SES-b | Session timeouts | Must | all | Story: session health depends on it. Ours: 30 min web, 15 min background, 4 h max, configurable. Datadog fixes 15 min/4 h; PostHog 30 min/24 h | [§5.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#52-end), [§3.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#32-configuration) |
| SES-c | Shared across tabs; kept across app restarts | Must | all | Story: one user, one session. Datadog and PostHog share across tabs; Sentry's replay session is per tab. Cross-subdomain sharing is G1 | [§5.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#53-tabs-and-windows-web), [§5.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#54-app-restarts-and-crashes-mobile), G1 |
| SES-d | Manual session control | Must | all | Cost: trivial. `getSessionId` lets apps join support tickets to sessions | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) |

## Errors and crashes

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| ERR-a | Unhandled exceptions | Must | all | OTel: `exception` is the one Stable client-specific convention (HTTP client conventions are also Stable). Every vendor has it | [§6.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#63-errors-and-crashes) SIG-08 |
| ERR-b | Unhandled promise rejections | Must | W, RN | Same as ERR-a. The Datadog RN research found no promise-rejection capture | [§6.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#63-errors-and-crashes) SIG-08 |
| ERR-c | Manual capture API | Must | all | Cost: trivial | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) `recordException` |
| ERR-d | Native crashes | Must | M | Story: the most important mobile signal. OTel: `app.crash` (Development). PostHog has it opt-in, without ANR | [§6.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#63-errors-and-crashes) SIG-09 |
| ERR-e | ANR and app hangs | Must | M | Story: a frozen app is worse than a crash for users. Thresholds differ: Sentry iOS 2 s, Datadog iOS off by default, both Android 5 s plus `ApplicationExitInfo`. Hang threshold default is G2 | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-06, SIG-07, G2 |
| ERR-f | OOM, watchdog and exit reasons | Should | M | Story: OOM kills are invisible without it. Sentry and Datadog infer them on next launch; Android `ApplicationExitInfo` is cheap | G3 |
| ERR-g | Trail of events before an error | Must | all | OTel: our ordinary events (clicks, navigation, HTTP spans, logs) are the trail, joined by `session.id` and time, so we need no separate breadcrumb buffer. Unsampled sessions have no trail today, G4 | [§6](../opentelemetry/rum-semantic-conventions/sdk-spec.md#6-signals), G4 |
| ERR-h | Client fingerprint override | Must | all | Cost: one attribute. The SDK never computes one | [§6.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#63-errors-and-crashes) SIG-34 |
| ERR-i | Screenshot or view hierarchy on error | Later | M | Cost: privacy and bytes. Replay in buffer mode already shows the moment | none, not needed now |
| ERR-j | `console.error` as errors | Never | W, RN | OTel: console output is a log, not an exception (see LOG-b). Sentry keeps it opt-in for this reason | none |
| ERR-k | Error dedupe and flood guard | Must | all | Cost: an error loop can cost a customer real money and battery. Datadog 3000/min per type, PostHog 10 burst then 1 per 10 s per type | G5 |

## Performance and vitals

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| PERF-a | Core Web Vitals and FCP, TTFB | Must | W | OTel: `browser.web_vital`. PostHog has no TTFB | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-01 |
| PERF-b | Vital attribution | Should | W | Story: tells the developer which element. INP is in the spec, LCP element is not (G6) | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-02, G6 |
| PERF-c | Long animation frames | Should | W | OTel: draft PR #429, gated. Sentry has it on by default | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-03 |
| PERF-d | Page load timing | Must | W | OTel: `browser.navigation_timing` and `documentLoad`. Story: the page-load span links to the server trace | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-14 to SIG-16 |
| PERF-e | Resource timing | Should | W | Cost: the main volume risk. Default off until Step 5 prices it, then a per-view cap (G8) | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-17, G8 |
| PERF-f | App start | Must | M | Story: the first thing a mobile user feels. All three except PostHog have it | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-04 |
| PERF-g | Slow and frozen frames | Must | M | OTel: `app.jank` | [§6.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#62-performance) SIG-05 |
| PERF-h | Time to initial and full display | Should | M | Story: per-screen load time. Sentry and Datadog: TTID automatic, TTFD by a manual call | G7 |
| PERF-i | Profiling | Later | all | OTel: the profiles signal is still in development. Cost: high | none |
| PERF-j | Device vitals (CPU, memory, battery, thermal) | Later | M | Only Datadog ships it. Cost: sampling overhead | none |
| PERF-k | Custom spans and timings | Must | all | OTel: the app uses the OTel API through our tracer provider. We add no span API of our own | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-5 |

## Network

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| NET-a | Automatic HTTP spans | Must | all | OTel: Stable HTTP client conventions | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-21 |
| NET-b | Trace propagation to the backend | Must | all | Story: our edge. W3C `traceparent` by default. Sentry sends its own headers, `traceparent` opt-in; Datadog sends W3C plus its own to an allowlist; PostHog sends nothing by default and, when enabled, session and user-id headers rather than trace headers | [§7.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#72-traceparent) |
| NET-c | Request and response headers and bodies | Later | all | Cost: privacy. PRV-12 forbids it today. If added: opt-in URL allowlist, size cap, replay only, as Sentry does | [§10.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#103-attributes-and-urls) PRV-12 |
| NET-d | GraphQL operation names | Later | all | OTel: `graphql.*` exists, but naming needs the request body | none |
| NET-e | Failed HTTP request as an error | Never | all | OTel: the HTTP span's status and `error.type` already say it. A second record duplicates it | SIG-21 covers it |
| NET-f | WebSocket | Later | all | Datadog has it in beta only | none |

## Interactions

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| INT-a | Click and tap capture | Must | all | Story: what the user did. Sentry has it as breadcrumbs and replay, with interaction spans opt-in | [§6.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#64-interactions) SIG-10 to SIG-12 |
| INT-b | Action naming | Should | all | Cost: privacy. We never send element text (SIG-39). Names come from selectors, widget ids and opt-in `data-otel-*` attributes. Datadog masks names by default since v7 | [§10.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#103-attributes-and-urls) PRV-9 |
| INT-c | Rage clicks and taps | Must | all | Story: frustration tells the developer where users struggle. Our threshold (4 in 1 s) is stricter than Datadog and Sentry RN (3 in 1 s) and PostHog (3 clicks, each within 1 s of the previous), G9 | [§6.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#64-interactions) SIG-13, G9 |
| INT-d | Dead clicks | Must | W | Same. On mobile only PostHog Android has it, opt-in, so mobile dead taps are not a target yet | [§6.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#64-interactions) SIG-13 |
| INT-e | Error clicks | Must | all | Same. Only Datadog ships it | [§6.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#64-interactions) SIG-13 |
| INT-f | Scroll and swipe | Later | all | Needed for scroll maps and scroll depth. Replay already shows scrolling | none |
| INT-g | Form and input autocapture | Never | all | Cost: privacy. Product analytics, not reliability | none |
| INT-h | Heatmaps | Later | all | A query over clicks. Needs document size (G10) | G10 |

## Navigation

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| NAV-a | Hard page loads | Must | W | OTel: `browser.navigation` | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-14 |
| NAV-b | SPA route changes | Must | W | Story: most apps are SPAs. Route-pattern names need router integrations (G11) | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-18, G11 |
| NAV-c | Mobile screen views | Must | M | Story: the mobile "page". UIKit and Activities automatic; SwiftUI and Compose need integrations (G11) | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-19, G11 |
| NAV-d | RN navigation | Must | RN | React Navigation and Expo Router. PostHog needs manual calls for Expo Router | [§6.8](../opentelemetry/rum-semantic-conventions/sdk-spec.md#68-react-native-boundaries), G11 |
| NAV-e | Manual view API | Must | all | Cost: trivial | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) `trackNavigation` |
| NAV-f | Foreground and background | Must | M | OTel: `device.app.lifecycle` | [§6.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#65-navigation-and-network) SIG-20 |

## Replay

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| RPL-a | Web DOM replay | Must | W | Story: the centre of the full story. rrweb, as Sentry and PostHog use | [§11](../opentelemetry/rum-semantic-conventions/sdk-spec.md#11-replay-contract) |
| RPL-b | Mobile replay | Must | M | Story: same. **The format is not decided here.** Evidence is in [mobile-replay-format-evidence.md](mobile-replay-format-evidence.md) | [§11.6](../opentelemetry/rum-semantic-conventions/sdk-spec.md#116-format-is-pluggable) |
| RPL-c | Session and on-error modes | Must | all | Cost: buffer mode keeps replays of failures at low cost. Datadog has no client buffer | [§9.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#91-replay-sampling-and-buffer-on-error) |
| RPL-d | Iframes, shadow DOM, canvas | Should | W | Same-origin iframes and shadow DOM Should; canvas Later and opt-in, since canvas pixels cannot be masked (G12) | G12 |
| RPL-e | Network requests in replay | Must | all | OTel: the player joins HTTP spans by `session.id` and time. No copy inside the replay | SIG-21, [§11](../opentelemetry/rum-semantic-conventions/sdk-spec.md#11-replay-contract) |
| RPL-f | Console in replay | Should | W, RN | Follows LOG-b: logs join like spans | G13 |
| RPL-g | Masking defaults and APIs | Must | all | Cost: privacy. Ours masks all text, inputs and media, like Sentry and Datadog mobile. Datadog web masks inputs only by default (`mask-user-input`); PostHog web does not mask text | [§10.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#102-masking) |
| RPL-h | RN replay | Must | RN | Native capture under RN | [§6.8](../opentelemetry/rum-semantic-conventions/sdk-spec.md#68-react-native-boundaries) |
| RPL-i | SwiftUI and Compose replay | Must | M | Story: new apps are built with them. The format decision decides how hard this is | [§11.6](../opentelemetry/rum-semantic-conventions/sdk-spec.md#116-format-is-pluggable) |
| RPL-j | Idle pause and maximum duration | Should | all | Cost: Sentry pauses after 5 min idle and stops at 60 min. The spec bounds a replay only by its session (30 min inactivity, 4 h maximum), so a mostly idle replay can run 4 h (G14) | G14 |

## User and attributes

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| USR-a | Set user id | Must | all | OTel: `enduser.id` | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) `setUser`, PRV-13 |
| USR-b | User traits | Never | all | Cost: PII sprawl. Global attributes cover segmenting, such as a plan tier | none |
| USR-c | Global attributes | Must | all | Cost: trivial | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) `setGlobalAttributes` |
| USR-d | Anonymous install id | Should | all | Story: crash-free *users* needs a stable pseudo id. Opt-in, off the resource (G15) | [§7.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#71-resource) RES-2, G15 |
| USR-e | Identify and alias merging | Never | all | Product analytics; a server-side concern | none |

## Logs

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| LOG-a | Structured logs | Must | all | OTel: the app uses the OTel Logs API through our provider | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-5 |
| LOG-b | Console capture as logs | Should | W, RN | Story: console lines next to the error. Opt-in, warn and error only, size-capped (G13) | G13 |
| LOG-c | OTel logs interop | Must | all | OTel: we are the OTel pipeline. PostHog sends OTLP logs; Sentry and Datadog do not | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) |

## Sampling

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| SMP-a | Session sampling | Must | all | Story: one decision keeps every signal of a session together | [§9](../opentelemetry/rum-semantic-conventions/sdk-spec.md#9-sampling) |
| SMP-b | Separate trace sampling | Never | all | Story: a second rate breaks the session's story. Volume is cut by session rate, defaults and caps instead | [§9](../opentelemetry/rum-semantic-conventions/sdk-spec.md#9-sampling) SMP-1 |
| SMP-c | Error sample rate | Never | all | Errors are never sampled away: they bypass the session decision | [§9](../opentelemetry/rum-semantic-conventions/sdk-spec.md#9-sampling) SMP-5 |
| SMP-d | Buffer-on-error replay | Must | all | Cost: see RPL-c | [§9.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#91-replay-sampling-and-buffer-on-error) |
| SMP-e | Errors kept in unsampled sessions | Must | all | Story: rare crashes are never lost | [§9](../opentelemetry/rum-semantic-conventions/sdk-spec.md#9-sampling) SMP-5 to SMP-7 |
| SMP-f | Remote config and kill switch | Should | all | Cost: a mobile release takes days to roll back. Datadog mobile (2026) and PostHog have it; Datadog web's is internal and undocumented. Served through the Collector (G16) | G16 |

## Privacy

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| PRV-a | Consent API | Must | all | Story: without consent handling the SDK cannot ship in the EU. Pending, granted, denied, per category. Sentry has none | [§10.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#101-consent) |
| PRV-b | Masking outside replay | Must | all | No element text, no input values | [§6.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#64-interactions) SIG-39 |
| PRV-c | Element-level mask and unmask | Must | all | Web attributes, mobile view APIs | [§10.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#102-masking) |
| PRV-d | URL and query sanitising | Must | all | Ours redacts every query value by default. Sentry, Datadog and PostHog keep them. A recommended allowlist is G17 | [§10.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#103-attributes-and-urls) PRV-10, G17 |
| PRV-e | No PII by default | Must | all | Sentry's JavaScript SDK v11 flipped to collect user info, IP, headers and bodies by default; Sentry mobile keeps `sendDefaultPii` off. Ours collects none | [§10.3](../opentelemetry/rum-semantic-conventions/sdk-spec.md#103-attributes-and-urls) PRV-13 |
| PRV-f | `beforeSend` hook | Must | all | Every vendor has one | [§3.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#32-configuration) CFG-4 |
| PRV-g | Global Privacy Control and Do Not Track | Should | W | Cost: GPC is a legal opt-out in some US states. Opt-in setting (G18) | G18 |

## Offline and transport

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| TRN-a | Batching | Must | all | OTel: OTLP batches | [§8.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#81-encoding-and-batching) |
| TRN-b | Offline persistence and retry | Must | all | Story: mobile users go offline. Datadog and PostHog web retry from memory only; Sentry's web offline queue is opt-in | [§8.4](../opentelemetry/rum-semantic-conventions/sdk-spec.md#84-offline-persistence) |
| TRN-c | Delivery at page unload | Must | W | Story: the last seconds before a user leaves | [§8.5](../opentelemetry/rum-semantic-conventions/sdk-spec.md#85-page-unload-budget-web) |
| TRN-d | Compression | Must | all | Cost | [§8.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#81-encoding-and-batching) TRN-2 |
| TRN-e | Custom endpoint or proxy | Must | all | Self-hosting: the Collector runs on the customer's domain, so a tunnel is not needed | [§3.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#32-configuration) `endpoint` |
| TRN-f | Server-driven backoff | Must | all | OTLP retry rules | [§8.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#82-responses-and-retries) |
| TRN-g | OTLP on the wire | Must | all | OTel: our reason to exist. None of the three vendors sends RUM as OTLP | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-2 |

## Configuration

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| CFG-a | One config object | Must | all | | [§3.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#32-configuration) |
| CFG-b | Per-instrumentation switches | Must | all | | [§3.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#32-configuration) `instrumentations.<signal>` |
| CFG-c | Debug mode and drop counts | Must | all | Story: the customer must see what was dropped. Sentry's client reports are the model | [§12](../opentelemetry/rum-semantic-conventions/sdk-spec.md#12-error-handling) ERR-7, ERR-8 |
| CFG-d | Service, version, environment | Must | all | OTel: resource attributes | [§7.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#71-resource) |
| CFG-e | Loader, CDN and lazy loading | Should | W | Cost: bundle size. Replay loaded on demand, as Sentry and PostHog do (G19) | G19 |
| CFG-f | SSR safety, workers, extensions | Must | W | SSR safety is Must (LIF-9). Workers, extensions and micro-frontends are Later | [§4.2](../opentelemetry/rum-semantic-conventions/sdk-spec.md#42-web) LIF-9 |

## Manual instrumentation API

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| API-a | Custom events | Must | all | OTel: events through the Logs API | [§3.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#31-api) `recordEvent` |
| API-b | Custom metrics | Never | all | OTel: browsers do not fit the single-writer metric model. Events are aggregated at the edge | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-6 |
| API-c | Custom spans | Must | all | Through the OTel tracer provider | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-5 |
| API-d | Attributes for the current view | Should | all | Datadog's view context. Lets an app tag a page with, say, an experiment arm (G20) | G20 |
| API-e | OTel interop | Must | all | Never replaces the host's providers; exposes ours | [§1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#1-scope-and-relation-to-opentelemetry) REL-4, REL-5 |

## Source maps and symbolication

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| SYM-a | Web source maps | Must | W | Story: a minified stack is useless. Needs a build or debug id on records (G21) | G21 |
| SYM-b | iOS dSYM | Must | iOS | `app.build_id` on the resource | [§7.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#71-resource), G21 |
| SYM-c | Android mapping and NDK symbols | Must | Android | Same | [§7.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#71-resource), G21 |
| SYM-d | RN and Hermes source maps | Must | RN | Same | G21 |
| SYM-e | Build tooling | Should | all | CLI, Vite and webpack plugins, Gradle, Xcode build phase, Expo plugin. A tooling spec, not the SDK spec | G21 |

## Framework integrations

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| FWK-a | React | Must | W | Error boundary and router names | G11 |
| FWK-b | Next.js | Should | W | The most used React meta-framework | G11 |
| FWK-c | Vue, Angular, Svelte | Later | W | `trackNavigation` works meanwhile | G11 |
| FWK-d | SwiftUI and UIKit | Must | iOS | | G11 |
| FWK-e | Compose and OkHttp | Must | Android | | G11 |
| FWK-f | React Native and Expo | Must | RN | Expo config plugin | [§6.8](../opentelemetry/rum-semantic-conventions/sdk-spec.md#68-react-native-boundaries) |
| FWK-g | Flutter and others | Later | M | OTel has no Flutter SDK. Cost: a fifth platform | none |

## Release and versioning

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| REL-a | Release tagging | Must | all | OTel: `service.version`, `app.build_id` | [§7.1](../opentelemetry/rum-semantic-conventions/sdk-spec.md#71-resource) |
| REL-b | Crash-free sessions and users | Must | all | Story: our session health. Derived on the server from `session.start` and crashes; users need USR-d | [§9](../opentelemetry/rum-semantic-conventions/sdk-spec.md#9-sampling) SMP-6 |
| REL-c | Commits and suspect commits | Later | all | Server and VCS work, not the SDK | none |
| REL-d | Version adoption | Should | all | Server query over `service.version`. No SDK work | none needed |

## Feature flags

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| FF-a | Flag evaluations on errors and sessions | Should | all | OTel: a `feature_flag.evaluation` event exists in semconv, and OpenFeature publishes OTel hooks. Story: "broke after the flag flipped" (G22) | G22 |
| FF-b | Own flag service | Never | all | Not our product | none |
| FF-c | OpenFeature integration | Should | all | Same as FF-a. One hook covers most providers | G22 |

## User feedback

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| FB-a | Feedback widget | Later | all | Cost: UI on four platforms | none |
| FB-b | Feedback API | Should | all | Story: the user's own words, joined to replay. Can trigger the replay buffer (G23) | G23 |
| FB-c | Screenshot and shake to report | Later | M | Follows FB-a | none |

## Other

| ID | Feature | Target | Where | Why | Spec |
|---|---|---|---|---|---|
| OTH-a | Product analytics autocapture | Never | all | We tell the reliability story; funnels can be queried from navigation events later | none |
| OTH-b | Experiments | Never | all | Not our product | none |
| OTH-c | Surveys | Never | all | Not our product | none |
| OTH-d | WebView and hybrid apps | Should | M | Story: the web SDK inside a WebView joins the native session (G24) | G24 |
| OTH-e | Synthetic test link | Later | all | | none |
| OTH-f | Third-party integrations | Never | all | OTLP is the integration | none |
| OTH-g | Other vendor extras | Later | all | Listed under each group in the matrix. Two shape the gaps: PostHog's dated defaults (G26) and Datadog's battery-aware upload (G27) | G26, G27 |
| OTH-h | Bot and crawler filtering | Should | W | Cost: crawlers create sessions, because `init` in a visible page counts as activity (G25) | G25 |
